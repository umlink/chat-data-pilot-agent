"""对话 API（核心）。
- POST /api/chat/stream    发起对话，SSE 流式返回（token/block_start/block_end/error/done）
- POST /api/chat/feedback  消息点赞/点踩
- POST /api/chat/execute   确认卡片决策（confirm/cancel）与执行后续动作（Agent 工具集 #10）
"""
import asyncio
import json
import logging
import uuid
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, rate_limit_chat
from app.core.database import SessionFactory, get_db
from app.models.user import Feedback, Message, Session, User
from app.schemas.common import ApiResponse, MessageRecord
from app.services.chat_service import ChatService, _json_safe
from app.services.sql_engine import SqlEngine, SqlNeedsConfirmation, SqlRoutingError, _safe_error

router = APIRouter(prefix="/chat", tags=["chat"])

logger = logging.getLogger("datapilot.chat")

_chat_service = ChatService()
_sql_engine = SqlEngine()

HEARTBEAT_SECONDS = 15


class ChatStreamRequest(BaseModel):
    session_id: str
    message: str
    attachments: list[str] | None = None
    datasource_id: str | None = None
    action_block_id: str | None = None
    client_msg_id: str | None = None  # 前端乐观消息 id（断线重连幂等，可选）


class FeedbackRequest(BaseModel):
    message_id: str
    rating: int  # 1 / -1
    comment: str | None = None


class ExecuteRequest(BaseModel):
    block_id: str  # confirmation / code block id
    decision: Literal["confirm", "cancel"]
    sql: str | None = None  # 可选：编辑后的 SQL（覆盖确认卡片里的原 SQL / code block 内容）
    datasource_id: str | None = None  # 可选：code block 编辑执行时指定会话级数据源


def _serialize_message(msg: Message) -> dict:
    """消息序列化为 MessageRecord 形状（供前端整体刷新）。"""
    return {
        "id": str(msg.id),
        "session_id": str(msg.session_id),
        "role": msg.role,
        "blocks": [b.dict() if hasattr(b, "dict") else b for b in (msg.blocks or [])],
        "metadata": msg.metadata_ or {},
        "created_at": msg.created_at.isoformat() if msg.created_at else None,
    }


def _sse(event: str, seq: int, data: dict) -> str:
    try:
        payload = json.dumps(data, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError):
        # NaN/Infinity 是非法 JSON token（pandas 聚合等可能产生），净化后兜底发送
        payload = json.dumps(_json_safe(data), ensure_ascii=False, allow_nan=False)
    return f"event: {event}\nid: {seq}\ndata: {payload}\n\n"


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
    user: Annotated[User, Depends(rate_limit_chat)],
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
            user_id=user.id,
            datasource_id=req.datasource_id,
            attachments=req.attachments,
            client_msg_id=req.client_msg_id,
        ).__aiter__()
        nxt: asyncio.Future | None = None
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
            # 客户端断开时 Starlette 会取消本生成器：先取消未完成的 __anext__ 任务再 aclose，
            # 避免生成器仍在 running 时 aclose() 抛 RuntimeError，并让后台 LLM 流及时停止。
            if nxt is not None:
                nxt.cancel()
                await asyncio.gather(nxt, return_exceptions=True)
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
    if req.rating not in (0, 1, -1):
        raise HTTPException(status_code=400, detail="rating 只允许 1、-1 或 0（0=取消反馈）")
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
    if req.rating == 0:
        # 取消反馈：删除该消息已有反馈（前端再次点击同一按钮 = 取消），保持前后端状态一致
        existing = (
            await db.execute(select(Feedback).where(Feedback.message_id == mid).limit(1))
        ).scalar_one_or_none()
        if existing is not None:
            await db.delete(existing)
        await db.commit()
        return ApiResponse(data=None, message="反馈已取消")
    db.add(Feedback(message_id=mid, rating=req.rating, comment=req.comment))
    await db.commit()
    return ApiResponse(data=None, message="反馈已提交")


async def _find_executable_block(
    db: AsyncSession, user: User, block_id: str
) -> tuple[Message, dict]:
    """在归属当前用户的消息中定位可执行 block（confirmation / code）。

    消息 → 会话 → 用户 归属校验，杜绝跨用户执行；
    已处理（确认/拒绝/已执行）的 block 拒绝再次提交，防止写操作重复执行。
    """
    result = await db.execute(
        select(Message)
        .join(Session, Message.session_id == Session.id)
        .where(Session.user_id == user.id)
        .order_by(Message.created_at.desc())
        .limit(50)
    )
    for msg in result.scalars().all():
        for block in msg.blocks or []:
            if block.get("id") == block_id and block.get("type") in ("confirmation", "code"):
                content = block.get("content") or {}
                if block["type"] == "confirmation":
                    # 仅 pending 且未决（confirmed 未写入）的卡片可操作
                    if block.get("status") != "pending" or content.get("confirmed") is not None:
                        raise HTTPException(status_code=409, detail="该确认卡片已处理，请勿重复操作")
                else:
                    exec_status = (content.get("execution") or {}).get("status")
                    if exec_status in ("success", "failed"):
                        raise HTTPException(status_code=409, detail="该代码块已执行，请勿重复执行")
                return msg, block
    raise HTTPException(status_code=404, detail="确认卡片或代码块不存在，或已处理")


async def _execute_code_block(
    db: AsyncSession,
    user: User,
    msg: Message,
    block: dict,
    req: ExecuteRequest,
) -> dict:
    """执行 code block（编辑后执行 SQL，契约 3.1.3 / 6.2 code 流转）。

    仅支持 SELECT（allow_write=False）：写操作由 sql_engine 安全拦截（SqlNeedsConfirmation）。
    成功 → execution.success + 追加 table block（parent_block_id 关联回代码块）；
    失败 → execution.failed + 错误原因回填，随完整 message 一并返回（200）。
    """
    content = block["content"]
    if content.get("language") != "sql":
        raise HTTPException(status_code=400, detail="当前仅支持执行 SQL 代码块（Python 编辑执行待开放）")
    sql = (req.sql or "").strip() or (content.get("code") or "").strip()
    if not sql:
        raise HTTPException(status_code=400, detail="SQL 为空，无法执行")

    blocks = list(msg.blocks or [])
    block_idx = blocks.index(block)
    try:
        table = await _sql_engine.execute(
            user_id=user.id,
            session_id=str(msg.session_id),
            sql=sql,
            datasource_id=req.datasource_id,
            max_rows=1000,
            allow_write=False,
        )
    except (SqlRoutingError, SqlNeedsConfirmation) as exc:
        # 路由/安全拦截：回填失败状态并持久化，前端随 message 整体刷新可见
        content["execution"] = {"status": "failed", "error": str(exc)}
        block["content"] = content
        blocks[block_idx] = block
        msg.blocks = blocks
        await db.commit()
        return _serialize_message(msg)
    except Exception as exc:
        logger.exception("code block SQL 执行失败", extra={"block_id": req.block_id})
        content["execution"] = {"status": "failed", "error": f"SQL 执行失败：{_safe_error(exc)}"}
        block["content"] = content
        blocks[block_idx] = block
        msg.blocks = blocks
        await db.commit()
        return _serialize_message(msg)

    meta = table.pop("_meta", None)
    result_block = {
        "id": str(uuid.uuid4()),
        "type": "table",
        "status": "completed",
        "content": table,
        "parent_block_id": req.block_id,
        "created_at": None,
    }
    content["execution"] = {
        "status": "success",
        "duration_ms": meta.get("duration_ms", 0) if meta else 0,
    }
    block["content"] = content
    blocks[block_idx] = block
    blocks.append(result_block)
    msg.blocks = blocks
    await db.commit()
    return _serialize_message(msg)


@router.post("/execute", response_model=ApiResponse)
async def chat_execute(
    req: ExecuteRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """确认卡片决策与代码块编辑执行。

    - code block：直接执行编辑后的 SQL（仅 SELECT），结果回填 execution 并追加 table block。
    - confirmation：cancel 标记拒绝；confirm 按 operation 执行并回填结果 block。
    """
    msg, block = await _find_executable_block(db, user, req.block_id)
    if block["type"] == "code":
        message = await _execute_code_block(db, user, msg, block, req)
        return ApiResponse(data={"message": message}, message="执行完成")

    content = block["content"]
    blocks = list(msg.blocks or [])
    block_idx = blocks.index(block)

    if req.decision == "cancel":
        block["status"] = "rejected"
        content["confirmed"] = False
        msg.blocks = blocks
        await db.commit()
        return ApiResponse(data={"message": _serialize_message(msg)}, message="已取消操作")

    # ---------- confirm ----------
    operation = content.get("operation")
    if operation == "execute_sql":
        sql = (req.sql or "").strip() or (content.get("sql") or "").strip()
        if not sql:
            raise HTTPException(status_code=400, detail="SQL 为空，无法执行")
        try:
            table = await _sql_engine.execute(
                user_id=user.id,
                session_id=str(msg.session_id),
                sql=sql,
                # 按确认卡片记录的数据源执行（旧卡片无此字段 → None 走默认主数据源）
                datasource_id=content.get("datasource_id") or None,
                max_rows=1000,
                allow_write=True,
            )
        except SqlRoutingError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except Exception as exc:
            logger.exception("确认后 SQL 执行失败", extra={"block_id": req.block_id})
            raise HTTPException(
                status_code=400, detail=f"SQL 执行失败：{_safe_error(exc)}"
            )
        meta = table.pop("_meta", None)
        result_block = {
            "id": str(uuid.uuid4()),
            "type": "table",
            "status": "completed",
            "content": table,
            "parent_block_id": req.block_id,
            "created_at": None,
        }
        content["confirmed"] = True
        content["result_block_id"] = result_block["id"]
        block["status"] = "completed"
        blocks[block_idx] = block
        blocks.append(result_block)
        msg.blocks = blocks
        await db.commit()
        return ApiResponse(
            data={"message": _serialize_message(msg), "result_block_id": result_block["id"]},
            message=f"执行完成（{meta.get('duration_ms', 0)}ms）" if meta else "执行完成",
        )

    raise HTTPException(
        status_code=400,
        detail=f"确认类型 {operation} 待对应模块接入后开放（当前支持 execute_sql）",
    )