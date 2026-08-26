"""附件上传 API（M3）。

契约（docs/技术方案设计.md 附件上传）：
- POST /api/upload             multipart/form-data {file, session_id} → 附件记录 + file_parse 任务
- GET  /api/upload/{id}/status 解析状态（任务进度 / parsed_schema，契约 2.10）
- GET  /api/upload/{id}/preview 附件预览（前 N 行，PRD 3.1.5）
- POST /api/upload/{id}/replace multipart 新文件替换附件（旧记录保留，供历史溯源）
- POST /api/upload/delete      移除附件（记录 + MinIO 对象 + 临时表）

归属校验：附件必须属于当前用户会话（CLAUDE.md §4.6 越权防护）。
上传本身为流式（AttachmentService.create_upload 边读边写 MinIO），解析走任务队列 Worker。
"""
import asyncio
import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.sessions import _get_owned_session
from app.core.database import get_db
from app.models.datasource import Attachment
from app.models.user import Session, User
from app.schemas.common import ApiResponse
from app.services.attachment_service import (
    READ_CHUNK,
    AttachmentError,
    AttachmentService,
    attachment_table_name,
    preview_attachment_table,
)

router = APIRouter(prefix="/upload", tags=["upload"])

logger = logging.getLogger("datapilot.upload")

_upload_service = AttachmentService()


class DeleteAttachmentRequest(BaseModel):
    attachment_id: str


async def _owned_attachment(
    db: AsyncSession, user: User, attachment_id: str
) -> Attachment:
    """校验附件 ID 合法且属于当前用户（Attachment → Session → user 归属链）。"""
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
    return att


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
    att = await _owned_attachment(db, user, attachment_id)
    status = await _upload_service.get_status(db, att)
    return ApiResponse(data=status)


@router.get("/{attachment_id}/preview", response_model=ApiResponse[dict])
async def upload_preview(
    attachment_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = Query(50, ge=1, le=200, description="预览行数（默认 50，PRD 3.1.5 前 N 行）"),
):
    """附件预览：读会话级 SQLite 附件表前 N 行（PRD 3.1.5 / 契约 2.10 preview_rows）。"""
    att = await _owned_attachment(db, user, attachment_id)
    table_name = attachment_table_name(attachment_id)
    try:
        data = await asyncio.to_thread(
            preview_attachment_table, str(att.session_id), table_name, limit
        )
    except AttachmentError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    return ApiResponse(data=data)


@router.post("/{attachment_id}/replace", response_model=ApiResponse[dict])
async def upload_replace(
    attachment_id: str,
    file: UploadFile,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """替换附件：上传新文件创建新 Attachment + 解析任务，返回新 attachment_id/task_id。

    旧记录与临时表保留（历史 block 溯源仍有效）；前端把引用切到新附件后
    后续分析即走新数据，满足「替换后关联分析自动更新」（PRD 3.1.5）。
    """
    att = await _owned_attachment(db, user, attachment_id)
    sess = await db.get(Session, att.session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="会话不存在")
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
    data["replaced_from"] = attachment_id
    logger.info(
        "附件替换",
        extra={
            "user": str(user.id),
            "resource": f"attachment:{data['attachment_id']}",
            "action": "replace",
        },
    )
    return ApiResponse(data=data, message="替换成功，正在解析新文件")


@router.post("/delete", response_model=ApiResponse)
async def upload_delete(
    req: DeleteAttachmentRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """移除附件：删除记录 + MinIO 对象 + 会话级 SQLite 临时表（PRD 3.1.5）。"""
    att = await _owned_attachment(db, user, req.attachment_id)
    await _upload_service.remove_attachment(db, att)
    logger.info(
        "附件移除",
        extra={"user": str(user.id), "resource": f"attachment:{att.id}", "action": "delete"},
    )
    return ApiResponse(data=None, message="附件已移除")
