"""数据源 API。
- GET  /api/datasources                列表（敏感字段掩码）
- POST /api/datasources                创建（敏感字段入库加密）
- POST /api/datasources/test           测试连接（body 含 type+config，不入库）
- POST /api/datasources/{id}/test      按已保存数据源测试连接（解密库中密文配置）
- POST /api/datasources/update         更新（body 含 id；掩码保留旧密文）
- POST /api/datasources/delete         删除（body 含 id；校验归属）
- GET  /api/datasources/{id}/preview   预览前 N 行（校验归属）
- GET  /api/datasources/{id}/schema    提取表结构（表清单/列/注释/采样，校验归属）
"""
import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.security import MASKED, encrypt_secret, upsert_secret
from app.models.datasource import Datasource
from app.models.user import User
from app.schemas.common import ApiResponse
from app.schemas.datasource import (
    SECRET_CONFIG_FIELDS,
    DatasourceCreate,
    DatasourceOut,
    DatasourceUpdate,
    TestConnectionRequest,
)
from app.services.data_service import DataService, decrypt_config

router = APIRouter(prefix="/datasources", tags=["datasources"])

logger = logging.getLogger("datapilot.datasource")

_data_service = DataService()


class DeleteDatasourceRequest(BaseModel):
    id: str


def _encrypt_config(config: dict) -> dict:
    """创建时：敏感字段明文加密（非字符串 / 掩码 / 已加密值原样保留）。"""
    out = dict(config)
    for key in SECRET_CONFIG_FIELDS:
        value = out.get(key)
        if isinstance(value, str) and value and value != MASKED and not value.startswith("enc:"):
            out[key] = encrypt_secret(value)
    return out


def _merge_config(current: dict, incoming: dict) -> dict:
    """更新时：字段级合并，敏感字段走 upsert_secret（掩码保留旧密文，新值加密）。"""
    merged = dict(current)
    for key, value in incoming.items():
        if key in SECRET_CONFIG_FIELDS:
            old = merged.get(key)
            old_str = old if isinstance(old, str) else None
            in_str = value if isinstance(value, str) else None
            merged[key] = upsert_secret(old_str, in_str)
        else:
            merged[key] = value
    return merged


async def _get_owned_datasource(db: AsyncSession, user: User, ds_id: str) -> Datasource:
    """按 id 取数据源并校验归属：不存在 / 非本人统一 404。"""
    try:
        did = UUID(ds_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="数据源 ID 非法")
    ds = await db.get(Datasource, did)
    if ds is None or ds.user_id != user.id:
        raise HTTPException(status_code=404, detail="数据源不存在")
    return ds


@router.get("", response_model=ApiResponse[list[DatasourceOut]])
async def list_datasources(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(
        select(Datasource)
        .where(Datasource.user_id == user.id)
        .order_by(Datasource.updated_at.desc())
    )
    items = result.scalars().all()
    return ApiResponse(data=[DatasourceOut.model_validate(ds) for ds in items])


@router.post("", response_model=ApiResponse[DatasourceOut])
async def create_datasource(
    req: DatasourceCreate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    ds = Datasource(
        user_id=user.id,
        name=req.name,
        type=req.type,
        config=_encrypt_config(req.config or {}),
    )
    db.add(ds)
    await db.commit()
    await db.refresh(ds)
    return ApiResponse(data=DatasourceOut.model_validate(ds), message="数据源已创建")


@router.post("/test", response_model=ApiResponse[dict])
async def test_datasource(
    req: TestConnectionRequest,
    user: Annotated[User, Depends(get_current_user)],
):
    result = await _data_service.test_connection(req.type, req.config or {})
    return ApiResponse(data=result, message="连接测试完成")


@router.post("/{ds_id}/test", response_model=ApiResponse[dict])
async def test_datasource_by_id(
    ds_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """按已保存数据源测试连接：解密库中密文配置后直连（列表页「测试」按钮用）。"""
    ds = await _get_owned_datasource(db, user, ds_id)
    try:
        config = decrypt_config(ds.config)
    except Exception as exc:
        # 密文无法用当前密钥解密（如密钥更换后旧密文未更新）→ 引导重新编辑保存
        raise HTTPException(
            status_code=400,
            detail="数据源凭据解密失败，请在编辑中重新输入密码保存后再试",
        ) from exc
    result = await _data_service.test_connection(ds.type, config)
    return ApiResponse(data=result, message="连接测试完成")


@router.post("/update", response_model=ApiResponse[DatasourceOut])
async def update_datasource(
    req: DatasourceUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    ds = await _get_owned_datasource(db, user, req.id)
    if req.name is not None and req.name.strip():
        ds.name = req.name.strip()
    if req.type is not None:
        ds.type = req.type
    if req.config is not None:
        ds.config = _merge_config(ds.config or {}, req.config)
    await db.commit()
    await db.refresh(ds)
    return ApiResponse(data=DatasourceOut.model_validate(ds), message="数据源已更新")


@router.post("/delete", response_model=ApiResponse)
async def delete_datasource(
    req: DeleteDatasourceRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    ds = await _get_owned_datasource(db, user, req.id)
    await db.delete(ds)
    await db.commit()
    return ApiResponse(data=None, message="数据源已删除")


@router.get("/{ds_id}/preview", response_model=ApiResponse[dict])
async def preview_datasource(
    ds_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    table: str = Query("", description="目标表名（可带 schema 前缀），默认取数据库第一张用户表"),
    limit: int = Query(50, ge=1, le=1000, description="返回行数上限"),
):
    ds = await _get_owned_datasource(db, user, ds_id)
    try:
        data = await _data_service.preview(ds, table=table or None, limit=limit)
    except NotImplementedError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return ApiResponse(data=data)


@router.get("/{ds_id}/schema", response_model=ApiResponse[dict])
async def schema_datasource(
    ds_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """提取数据源表结构（PG/MySQL：表清单 + 列名/类型/注释 + 每表 3 行采样）。"""
    ds = await _get_owned_datasource(db, user, ds_id)
    try:
        data = await _data_service.get_schema(ds)
    except NotImplementedError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return ApiResponse(data=data)