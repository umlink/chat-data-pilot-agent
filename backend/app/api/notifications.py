"""通知渠道 API（通知渠道层：不含 automation 通知接入与对话主动推送，见后续模块）。
- GET  /api/notifications/channels            列表（config 全掩码）
- POST /api/notifications/channels            新增（敏感字段 enc: 加密）
- POST /api/notifications/channels/update     更新（secret 掩码/留空=保留旧值）
- POST /api/notifications/channels/delete     删除（同时解绑 automations.notification 引用）
- POST /api/notifications/channels/test       发送测试（channel_id 或 {provider, config}）
- GET  /api/notifications/logs                发送记录（审计/重试，可按 channel 过滤）
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
from app.models.automation import Automation
from app.models.notification import NotificationChannel, NotificationLog
from app.models.user import User
from app.schemas.common import ApiResponse
from app.schemas.notification import (
    ChannelCreate,
    ChannelOut,
    ChannelTestRequest,
    ChannelUpdate,
    NotificationLogOut,
    NotificationSendRequest,
)
from app.services.log_service import LogService
from app.services.notification_service import (
    NotificationService,
    encrypt_config,
    mask_config,
    merge_config,
    validate_config,
)

router = APIRouter(prefix="/notifications", tags=["notifications"])

_log_service = LogService()
_notify_service = NotificationService()
logger = logging.getLogger("datapilot.notify")


class DeleteChannelRequest(BaseModel):
    id: str


async def _get_owned_channel(
    db: AsyncSession, user: User, channel_id: str
) -> NotificationChannel:
    """按 id 取渠道并校验归属：不存在 / 非本人统一 404。"""
    try:
        cid = UUID(channel_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="渠道 ID 非法")
    channel = await db.get(NotificationChannel, cid)
    if channel is None or channel.user_id != user.id:
        raise HTTPException(status_code=404, detail="通知渠道不存在")
    return channel


def _mask_out(channel: NotificationChannel) -> ChannelOut:
    out = ChannelOut.model_validate(channel)
    out.config = mask_config(channel.provider, channel.config or {})
    return out


@router.get("/channels", response_model=ApiResponse[list[ChannelOut]])
async def list_channels(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    channels = (
        await db.scalars(
            select(NotificationChannel)
            .where(NotificationChannel.user_id == user.id)
            .order_by(NotificationChannel.updated_at.desc())
        )
    ).all()
    return ApiResponse(data=[_mask_out(c) for c in channels])


@router.post("/channels", response_model=ApiResponse[ChannelOut])
async def create_channel(
    req: ChannelCreate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    try:
        cfg = encrypt_config(req.provider, validate_config(req.provider, req.config))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    channel = NotificationChannel(
        user_id=user.id, provider=req.provider, name=req.name, config=cfg
    )
    db.add(channel)
    await db.commit()
    await db.refresh(channel)
    await _log_service.audit(
        user=user.username, resource="notification_channel", action="create",
        message=f"新增通知渠道: {channel.name}",
    )
    return ApiResponse(data=_mask_out(channel), message="通知渠道已创建")


@router.post("/channels/update", response_model=ApiResponse[ChannelOut])
async def update_channel(
    req: ChannelUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    channel = await _get_owned_channel(db, user, req.id)
    if req.name is not None:
        name = req.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="渠道名称不能为空")
        channel.name = name
    if req.config is not None:
        try:
            channel.config = merge_config(channel.provider, channel.config, req.config)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    if req.enabled is not None:
        channel.enabled = req.enabled
    await db.commit()
    await db.refresh(channel)
    await _log_service.audit(
        user=user.username, resource="notification_channel", action="update",
        message=f"更新通知渠道: {channel.name}",
    )
    return ApiResponse(data=_mask_out(channel), message="通知渠道已更新")


@router.post("/channels/delete", response_model=ApiResponse)
async def delete_channel(
    req: DeleteChannelRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    channel = await _get_owned_channel(db, user, req.id)
    # 删除渠道时解绑引用它的 automations.notification（方案 §2.9：删除时解绑，避免空转）
    # 注意：JSONB 列不追踪原地修改，必须构造新 dict 再赋值，否则 SQLAlchemy 不感知变更。
    automations = (
        await db.scalars(select(Automation).where(Automation.user_id == user.id))
    ).all()
    for automation in automations:
        notification = dict(automation.notification or {})
        changed = False
        for key in ("on_success", "on_failure"):
            binding = dict(notification.get(key) or {})
            if binding.get("channel_id") == req.id:
                binding["channel_id"] = None
                binding["enabled"] = False
                notification[key] = binding
                changed = True
        if changed:
            automation.notification = notification
    await db.delete(channel)
    await db.commit()
    await _log_service.audit(
        user=user.username, resource="notification_channel", action="delete",
        message=f"删除通知渠道: {channel.name}",
    )
    return ApiResponse(data=None, message="通知渠道已删除")


@router.post("/channels/test", response_model=ApiResponse[dict])
async def test_channel(
    req: ChannelTestRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """发送测试消息（不落 notification_logs，仅验证连通性，方案 §4.4）。"""
    if req.channel_id:
        channel = await _get_owned_channel(db, user, req.channel_id)
        result = await _notify_service.test_config(
            channel.provider, channel.config, req.subject, req.body
        )
    elif req.provider and req.config is not None:
        try:
            validate_config(req.provider, req.config)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        result = await _notify_service.test_config(
            req.provider, req.config, req.subject, req.body
        )
    else:
        raise HTTPException(status_code=400, detail="请提供 channel_id 或 {provider, config}")
    return ApiResponse(data=result, message="测试完成")


@router.get("/logs", response_model=ApiResponse[list[NotificationLogOut]])
async def list_notification_logs(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    channel_id: str | None = Query(None, description="按渠道过滤（可选）"),
    limit: int = Query(20, ge=1, le=100, description="返回条数上限"),
    offset: int = Query(0, ge=0, description="跳过的记录数（分页偏移）"),
):
    query = select(NotificationLog).where(NotificationLog.user_id == user.id)
    if channel_id:
        try:
            cid = UUID(channel_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="渠道 ID 非法")
        # 校验渠道归属后再过滤，避免泄露他人渠道的日志存在性
        await _get_owned_channel(db, user, channel_id)
        query = query.where(NotificationLog.channel_id == cid)
    logs = (
        await db.scalars(
            query.order_by(NotificationLog.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
    ).all()
    return ApiResponse(data=[NotificationLogOut.model_validate(l) for l in logs])


@router.post("/send", response_model=ApiResponse[dict])
async def send_notification(
    req: NotificationSendRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """对话结果主动推送（方案 §3.5/§4.3）：发送并落 notification_logs。

    返回 ok 供前端 toast；发送失败仍返回 200（ok=False + error），前端可提示重试。
    渠道归属校验：非本人渠道 404。
    """
    channel = await _get_owned_channel(db, user, req.channel_id)
    log = await _notify_service.send_to_channel(channel.id, req.subject, req.body)
    if log is None:
        raise HTTPException(status_code=404, detail="通知渠道不存在")
    if log.status == "failed":
        return ApiResponse(
            data={"ok": False, "log_id": str(log.id), "error": log.error},
            message="推送失败",
        )
    return ApiResponse(data={"ok": True, "log_id": str(log.id)}, message="推送成功")
