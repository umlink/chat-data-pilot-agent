"""LLM 供应商 API。
- GET   /api/llm/providers                 列表（当前用户，默认优先；api_key 掩码）
- POST  /api/llm/providers                 新增（首个自动默认）
- POST  /api/llm/providers/update          更新（api_key 掩码/空串=保留旧值）
- POST  /api/llm/providers/delete          删除（删默认自动提升）
- POST  /api/llm/providers/{id}/set-default
- POST  /api/llm/providers/{id}/test       → { ok, model?, latency_ms?, error? }
"""
import asyncio
import logging
import re
import time
import uuid
from typing import Annotated
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.security import encrypt_secret, is_masked
from app.models.llm_provider import LlmProvider
from app.models.user import User
from app.schemas.common import ApiResponse
from app.schemas.llm_provider import (
    MASKED,
    LlmProviderCreate,
    LlmProviderOut,
    LlmProviderUpdate,
    ProviderTestResult,
)

router = APIRouter(prefix="/llm/providers", tags=["llm-providers"])

logger = logging.getLogger("datapilot.llm_provider")

_BASE_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def _validate_base_url(url: str | None) -> None:
    """base_url 仅允许 http/https 或留空（防止非 http 协议与异常跳转）。"""
    u = (url or "").strip()
    if u and not _BASE_URL_RE.match(u):
        raise HTTPException(status_code=400, detail="base_url 仅支持 http/https 协议")


class DeleteProviderRequest(BaseModel):
    id: str


async def _get_owned(db: AsyncSession, provider_id: str) -> LlmProvider:
    """按 id 取供应商：不存在 / 非法统一 404（LLM 供应商为全局配置，认证即可管理）。"""
    try:
        pid = UUID(provider_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="供应商 ID 非法")
    row = await db.get(LlmProvider, pid)
    if row is None:
        raise HTTPException(status_code=404, detail="供应商不存在")
    return row


async def _list_all(db: AsyncSession) -> list[LlmProvider]:
    result = await db.execute(
        select(LlmProvider).order_by(
            LlmProvider.is_default.desc(), LlmProvider.updated_at.desc()
        )
    )
    return list(result.scalars().all())


def _out(row: LlmProvider) -> LlmProviderOut:
    return LlmProviderOut.model_validate(row)


@router.get("", response_model=ApiResponse[list[LlmProviderOut]])
async def list_providers(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    rows = await _list_all(db)
    return ApiResponse(data=[_out(r) for r in rows])


@router.post("", response_model=ApiResponse[LlmProviderOut])
async def create_provider(
    req: LlmProviderCreate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    rows = await _list_all(db)
    _validate_base_url(req.base_url)
    row = LlmProvider(
        name=req.name,
        type=req.type,
        base_url=req.base_url,
        api_key=encrypt_secret(req.api_key.strip()) if req.api_key.strip() else "",
        models=req.models or [],
        default_model=req.default_model,
        is_default=len(rows) == 0,  # 首个自动默认
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return ApiResponse(data=_out(row), message="供应商已创建")


@router.post("/update", response_model=ApiResponse[LlmProviderOut])
async def update_provider(
    req: LlmProviderUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    row = await _get_owned(db, req.id)
    if req.name is not None:
        row.name = req.name.strip()
    if req.type is not None:
        row.type = req.type
    if req.base_url is not None:
        _validate_base_url(req.base_url)
        row.base_url = req.base_url.strip()
    if req.api_key is not None:
        new_key = req.api_key.strip()
        if new_key and not is_masked(new_key):
            row.api_key = encrypt_secret(new_key)
        # 空串 / 掩码 = 保留旧密文
    if req.models is not None:
        row.models = req.models
    if req.default_model is not None:
        row.default_model = req.default_model
    await db.commit()
    await db.refresh(row)
    return ApiResponse(data=_out(row), message="供应商已更新")


@router.post("/delete", response_model=ApiResponse)
async def delete_provider(
    req: DeleteProviderRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    row = await _get_owned(db, req.id)
    was_default = row.is_default
    await db.delete(row)
    await db.commit()
    # 删除默认后自动提升最新一个为默认
    if was_default:
        rows = await _list_all(db)
        if rows:
            rows[0].is_default = True
            await db.commit()
    return ApiResponse(data=None, message="供应商已删除")


@router.post("/{provider_id}/set-default", response_model=ApiResponse[LlmProviderOut])
async def set_default(
    provider_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    row = await _get_owned(db, provider_id)
    rows = await _list_all(db)
    for r in rows:
        r.is_default = r.id == row.id
    await db.commit()
    await db.refresh(row)
    return ApiResponse(data=_out(row), message="已设为默认供应商")


def _ping_sync(ptype: str, api_key: str, model: str, base_url: str) -> dict:
    """同步最小 LLM 连通测试（to_thread 执行）。返回 {ok, model, latency_ms, error}。"""
    backend = (base_url or "").strip().rstrip("/")
    start = time.perf_counter()
    try:
        if ptype == "anthropic":
            url = f"{backend or 'https://api.anthropic.com'}/v1/messages"
            headers = {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
            body = {
                "model": model or "claude-3-5-sonnet-latest",
                "max_tokens": 5,
                "messages": [{"role": "user", "content": "ping"}],
            }
        else:
            url = f"{backend or 'https://api.openai.com/v1'}/chat/completions"
            headers = {"Authorization": f"Bearer {api_key}"}
            body = {
                "model": model or "gpt-4o-mini",
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 5,
            }
        resp = httpx.post(url, headers=headers, json=body, timeout=15)
        latency_ms = int((time.perf_counter() - start) * 1000)
        if resp.status_code == 200:
            return {"ok": True, "model": model or "default", "latency_ms": latency_ms}
        # 不回显响应体细节（避免服务端 echo 请求内容/敏感信息）
        return {"ok": False, "error": f"HTTP {resp.status_code}"}
    except Exception as exc:  # 网络 / 超时 / DNS
        return {"ok": False, "error": str(exc)[:200]}


@router.post("/{provider_id}/test", response_model=ApiResponse[ProviderTestResult])
async def test_provider(
    provider_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    row = await _get_owned(db, provider_id)
    if not row.api_key:
        return ApiResponse(
            data=ProviderTestResult(ok=False, error="未配置 API Key，请先填写"),
            message="配置测试完成",
        )
    from app.core.security import decrypt_secret

    api_key = decrypt_secret(row.api_key) or ""
    result = await asyncio.to_thread(
        _ping_sync, row.type, api_key, row.default_model, row.base_url
    )
    return ApiResponse(data=ProviderTestResult(**result), message="配置测试完成")
