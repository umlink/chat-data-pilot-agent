"""对话 API（核心）。
- POST /api/chat/stream    发起对话，SSE 流式返回（token/block_start/block_end/error/done）
- POST /api/chat/feedback  消息点赞/点踩
- POST /api/chat/execute   执行编辑后的 SQL / 确认卡片动作（待 Agent 工具集 #10 接入）
"""
import asyncio
import json
import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import SessionFactory, get_db
from app.models.user import Feedback, Message, Session, User
from app.schemas.common import ApiResponse
from app.services.chat_service import ChatService

router = APIRouter(prefix="/chat", tags=["chat"])

logger = logging.getLogger("datapilot.chat")

_chat_service = ChatService()

HEARTBEAT_SECONDS = 15


class ChatStreamRequest(BaseModel):
    session_id: str
    message: str
    attachments: list[str] | None = None
    datasource_id: str | None = None
    action_block_id: str | None = None


class FeedbackRequest(BaseModel):
    message_id: str
    rating: int  # 1 / -1
    comment: str | None = None


def _sse(event: str, seq: int, data: dict) -> str:
    return f"event: {event}\nid: {seq}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _own_session(db: AsyncSession, user: User, session_id: str) -> Session:
    try:
        sid = UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="会话 ID 非法")
    sess = await db.get(Session, sid)
    if sess is None or sess.user_id != user.id:
        raise HTTPException(status_code=404, detail="会话不存在")
    return sess


@router.post("/stream")
async def chat_stream(
    req: ChatStreamRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="消息不能为空")
    await _own_session(db, user, req.session_id)

    async def event_source():
        """事件组帧：单调 id、15s 心跳注释行；done/error 后由服务端自然结束并关流。"""
        seq = 0
        agen = _chat_service.stream(
            session_id=req.session_id,
            user_text=req.message,
            datasource_id=req.datasource_id,
            attachments=req.attachments,
        ).__aiter__()
        try:
            while True:
                nxt = asyncio.ensure_future(agen.__anext__())
                # 空闲 15s 发心跳注释行，不取消进行中的事件（LLM 流可能长时间无 token）
                while True:
                    done, _ = await asyncio.wait({nxt}, timeout=HEARTBEAT_SECONDS)
                    if done:
                        break
                    yield ": ping\n\n"
                try:
                    evt = nxt.result()
                except StopAsyncIteration:
                    break
                seq += 1
                yield _sse(evt["event"], seq, evt["data"])
        except Exception:
            logger.exception("SSE 事件源异常", extra={"session_id": req.session_id})
            seq += 1
            yield _sse("error", seq, {"code": "INTERNAL_ERROR", "message": "服务内部错误，请重试"})
        finally:
            await agen.aclose()

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/feedback", response_model=ApiResponse)
async def chat_feedback(
    req: FeedbackRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    if req.rating not in (1, -1):
        raise HTTPException(status_code=400, detail="rating 只允许 1 或 -1")
    try:
        mid = UUID(req.message_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="消息 ID 非法")
    # 消息归属校验：消息 -> 会话 -> 用户
    result = await db.execute(
        select(Message).join(Session, Message.session_id == Session.id).where(
            Message.id == mid, Session.user_id == user.id
        )
    )
    msg = result.scalar_one_or_none()
    if msg is None:
        raise HTTPException(status_code=404, detail="消息不存在")
    db.add(Feedback(message_id=mid, rating=req.rating, comment=req.comment))
    await db.commit()
    return ApiResponse(data=None, message="反馈已提交")


@router.post("/execute", response_model=ApiResponse)
async def chat_execute(
    req: dict,
    user: Annotated[User, Depends(get_current_user)],
):
    # 编辑后执行 SQL / 确认卡片动作依赖 Agent 工具集与数据源引擎（#10 / M3）
    raise HTTPException(status_code=501, detail="执行类动作将在 Agent 工具集接入后开放")