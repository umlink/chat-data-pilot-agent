"""会话 API。
- GET /api/sessions                 列表（搜索、分页，按更新时间倒序）
- POST /api/sessions                创建
- POST /api/sessions/update         重命名
- POST /api/sessions/delete         删除（级联消息、附件、临时库文件）
- GET /api/sessions/{id}/messages   会话消息（Block 契约）
"""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.config import settings
from app.core.database import get_db
from app.models.user import Message, Session, User
from app.schemas.common import ApiResponse, Block, MessageRecord
from app.schemas.session import SessionOut

router = APIRouter(prefix="/sessions", tags=["sessions"])


class CreateSessionRequest(BaseModel):
    title: str = "新对话"


class UpdateSessionRequest(BaseModel):
    id: str
    title: str


class DeleteSessionRequest(BaseModel):
    id: str


def _cleanup_session_files(session_id: str) -> None:
    """删除会话级残留文件（附件临时 SQLite 库）。MinIO 前缀由附件模块负责。"""
    tmp = settings.tmp_dir / f"{session_id}.db"
    try:
        if tmp.exists():
            tmp.unlink()
    except OSError:
        pass


async def _get_owned_session(db: AsyncSession, user: User, session_id: str) -> Session:
    try:
        sid = UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="会话 ID 非法")
    sess = await db.get(Session, sid)
    if sess is None or sess.user_id != user.id:
        raise HTTPException(status_code=404, detail="会话不存在")
    return sess


@router.get("", response_model=ApiResponse[list[SessionOut]])
async def list_sessions(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    q: str = Query("", description="标题关键字"),
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=500),
):
    stmt = select(Session).where(Session.user_id == user.id)
    if q:
        stmt = stmt.where(Session.title.ilike(f"%{q}%"))
    stmt = stmt.order_by(Session.updated_at.desc()).offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(stmt)
    items = result.scalars().all()
    return ApiResponse(data=[SessionOut.model_validate(s) for s in items])


@router.post("", response_model=ApiResponse[SessionOut])
async def create_session(
    req: CreateSessionRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    sess = Session(user_id=user.id, title=req.title.strip() or "新对话")
    db.add(sess)
    await db.commit()
    await db.refresh(sess)
    return ApiResponse(data=SessionOut.model_validate(sess))


@router.post("/update", response_model=ApiResponse[SessionOut])
async def update_session(
    req: UpdateSessionRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    sess = await _get_owned_session(db, user, req.id)
    sess.title = req.title.strip() or sess.title
    await db.commit()
    await db.refresh(sess)
    return ApiResponse(data=SessionOut.model_validate(sess))


@router.post("/delete", response_model=ApiResponse)
async def delete_session(
    req: DeleteSessionRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    sess = await _get_owned_session(db, user, req.id)
    sid = sess.id
    # 消息表无外键，先显式删除；附件表依赖 DB 级 CASCADE；tasks 依赖 ON DELETE SET NULL
    await db.execute(delete(Message).where(Message.session_id == sid))
    await db.delete(sess)
    await db.commit()
    _cleanup_session_files(str(sid))
    return ApiResponse(data=None, message="会话已删除")


@router.get("/{session_id}/messages", response_model=ApiResponse[list[MessageRecord]])
async def session_messages(
    session_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    sess = await _get_owned_session(db, user, session_id)
    result = await db.execute(
        select(Message)
        .where(Message.session_id == sess.id)
        .order_by(Message.created_at.asc())
    )
    messages = result.scalars().all()
    records = [_to_record(m) for m in messages]
    return ApiResponse(data=records)


def _to_record(m: Message) -> MessageRecord:
    blocks = [Block.model_validate(b) for b in (m.blocks or [])]
    return MessageRecord(
        id=str(m.id),
        session_id=str(m.session_id),
        role=m.role,
        blocks=blocks,
        metadata=m.metadata_ or {},
        created_at=m.created_at.isoformat() if m.created_at else None,
    )