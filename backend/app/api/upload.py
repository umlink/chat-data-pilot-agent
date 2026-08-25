"""附件上传 API（M3）。

契约（docs/技术方案设计.md 附件上传）：
- POST /api/upload             multipart/form-data {file, session_id} → 附件记录 + file_parse 任务
- GET  /api/upload/{id}/status 解析状态（任务进度 / parsed_schema，契约 2.10）

归属校验：附件必须属于当前用户会话（CLAUDE.md §4.6 越权防护）。
上传本身为流式（AttachmentService.create_upload 边读边写 MinIO），解析走任务队列 Worker。
"""
import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.sessions import _get_owned_session
from app.core.database import get_db
from app.models.datasource import Attachment
from app.models.user import Session, User
from app.schemas.common import ApiResponse
from app.services.attachment_service import READ_CHUNK, AttachmentError, AttachmentService

router = APIRouter(prefix="/upload", tags=["upload"])

logger = logging.getLogger("datapilot.upload")

_upload_service = AttachmentService()


@router.post("", response_model=ApiResponse[dict])
async def upload_file(
    file: UploadFile,
    session_id: Annotated[str, Form()],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """上传附件：校验归属 → 流式写 MinIO → 建 Attachment 记录 → 创建 file_parse 任务。"""
    sess = await _get_owned_session(db, user, session_id)
    if not file.filename:
        raise HTTPException(status_code=400, detail="未选择文件")

    async def _chunks():
        while chunk := await file.read(READ_CHUNK):
            yield chunk

    try:
        data = await _upload_service.create_upload(
            db, sess, file.filename, file.content_type, _chunks(), None
        )
    except AttachmentError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    logger.info(
        "附件上传",
        extra={"user": str(user.id), "resource": f"attachment:{data['attachment_id']}", "action": "create"},
    )
    return ApiResponse(data=data, message="上传成功，正在解析")


@router.get("/{attachment_id}/status", response_model=ApiResponse[dict])
async def upload_status(
    attachment_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """附件解析状态：任务进度 / parsed_schema。归属校验经 Attachment → Session → user。"""
    try:
        aid = UUID(attachment_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="附件 ID 非法")
    att = await db.get(Attachment, aid)
    if att is None:
        raise HTTPException(status_code=404, detail="附件不存在")
    sess = await db.get(Session, att.session_id)
    if sess is None or sess.user_id != user.id:
        raise HTTPException(status_code=404, detail="附件不存在")
    status = await _upload_service.get_status(db, att)
    return ApiResponse(data=status)
