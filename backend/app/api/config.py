"""配置 API。
- GET /api/config            获取全部配置（敏感字段掩码，扁平 key→value）
- POST /api/config/update    批量更新（支持掩码保留 / 新值加密）
- POST /api/config/test      测试当前 LLM 配置连通性
"""
import asyncio
import logging
import time
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api.deps import get_current_user
from app.models.user import User
from app.schemas.common import ApiResponse
from app.services.config_service import ConfigService, mask_all
from app.services.log_service import LogService

router = APIRouter(prefix="/config", tags=["config"])

logger = logging.getLogger("datapilot.config")

_config_service = ConfigService()
_log_service = LogService()


class ConfigUpdateRequest(BaseModel):
    updates: dict[str, dict]


def _ping_llm(cfg: dict) -> dict:
    """同步最小 LLM 连通测试（to_thread 执行，避免阻塞事件循环）。"""
    provider = cfg.get("provider", "openai")
    api_key = (cfg.get("api_key") or "").strip()
    model = (cfg.get("model") or "").strip()
    base_url = (cfg.get("base_url") or "").strip()
    if not api_key:
        return {"ok": False, "error": "未配置 API Key，请在配置页填写后保存"}
    if provider == "anthropic":
        return {"ok": False, "error": "Anthropic 协议测试将在 LLM 适配器（M2）就绪后支持"}
    backend = (base_url or "https://api.openai.com/v1").rstrip("/")
    start = time.perf_counter()
    try:
        resp = httpx.post(
            f"{backend}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model or "gpt-4o-mini",
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 5,
            },
            timeout=15,
        )
        latency_ms = int((time.perf_counter() - start) * 1000)
        if resp.status_code == 200:
            return {"ok": True, "model": model or "default", "latency_ms": latency_ms}
        return {"ok": False, "error": f"HTTP {resp.status_code}: {resp.text[:300]}"}
    except Exception as exc:  # 网络 / 超时 / DNS
        return {"ok": False, "error": str(exc)[:300]}


@router.get("", response_model=ApiResponse[dict])
async def get_config(user: Annotated[User, Depends(get_current_user)]):
    data = await _config_service.get_all()
    return ApiResponse(data=mask_all(data))


@router.post("/update", response_model=ApiResponse[dict])
async def update_config(
    req: ConfigUpdateRequest,
    user: Annotated[User, Depends(get_current_user)],
):
    try:
        await _config_service.set_many(req.updates)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    data = await _config_service.get_all()
    # 审计日志只记变更的配置 key 名，不记值（值可能含 API Key 等敏感字段）
    await _log_service.audit(
        user=user.username,
        resource="config",
        action="update",
        message=f"配置变更: {','.join(req.updates.keys())}",
    )
    return ApiResponse(data=mask_all(data), message="配置已更新")


@router.post("/test", response_model=ApiResponse[dict])
async def test_config(user: Annotated[User, Depends(get_current_user)]):
    cfg = await _config_service.get_llm_config()
    result = await asyncio.to_thread(_ping_llm, cfg)
    return ApiResponse(data=result, message="配置测试完成")