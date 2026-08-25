"""ChatService：对话编排（M2 阶段：自然语言流式 + 消息/Block 持久化）。

契约见 docs/Block与协议规范.md 第 3、4 章：
- 对外以 SSE 事件流产出（token / block_start / block_end / error / done），API 层负责组帧。
- messages.blocks 是唯一事实源：流结束（或失败）后整条消息落库，SSE 只是加速通道。
- usage 取自 LLM 适配器累计值，随 done 事件返回并写入 assistant metadata。

Agent 工具循环（run_sql 等）在 M2 后续接入（见 agents/ 与 #10）。
"""
import datetime
import logging
import uuid
from typing import Any, AsyncGenerator

from sqlalchemy import select

from app.core.database import SessionFactory
from app.llm.base import Usage, build_llm_provider
from app.models.user import Message, Session
from app.services.config_service import ConfigService

logger = logging.getLogger("datapilot.chat")

DEFAULT_TITLES = {"新会话", "新对话", "新聊天"}
HISTORY_ROUNDS = 10  # 最近 10 轮（20 条）进入上下文

SYSTEM_PROMPT = (
    "你是 DataPilotAgent，一个专业的智能数据分析助手。"
    "用简洁、专业的中文回答。"
    "当前版本以自然语言对话与思路澄清为主；"
    "若问题缺少时间范围、指标口径等必要参数，请先向用户澄清再继续。"
)


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _text_block(text: str, status: str = "running") -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "type": "text",
        "status": status,
        "content": {"text": text},
        "created_at": _now_iso(),
    }


def _error_block(code: str, message: str, retryable: bool = False) -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "type": "error",
        "status": "completed",
        "content": {"code": code, "message": message, "retryable": retryable},
        "created_at": _now_iso(),
    }


class ChatService:
    def __init__(self, config_service: ConfigService | None = None):
        self._config = config_service or ConfigService()

    # ---------- 持久化 ----------
    async def _persist_message(
        self,
        session_id,
        role: str,
        blocks: list[dict],
        metadata: dict | None = None,
        message_id: str | None = None,
    ) -> str:
        async with SessionFactory() as db:
            m = Message(
                id=uuid.UUID(message_id) if message_id else None,
                session_id=session_id,
                role=role,
                blocks=blocks,
                metadata_=metadata or {},
            )
            db.add(m)
            await db.commit()
            return str(m.id)

    async def _maybe_update_title(self, session_id, user_text: str) -> None:
        """首条消息把默认标题改为问题摘要（截 20 字）。"""
        async with SessionFactory() as db:
            sess = await db.get(Session, session_id)
            if sess is None or sess.title not in DEFAULT_TITLES:
                return
            count = await db.scalar(
                select(Message.id).where(Message.session_id == session_id).limit(1)
            )
            if count is not None:
                return  # 已有消息，不动标题
            sess.title = user_text.strip()[:20] or sess.title
            await db.commit()

    # ---------- 上下文 ----------
    async def _load_history(self, session_id) -> list[dict[str, str]]:
        """最近 N 轮压缩为 OpenAI 风格消息（只取各消息首个 text block）。"""
        async with SessionFactory() as db:
            result = await db.execute(
                select(Message)
                .where(Message.session_id == session_id)
                .order_by(Message.created_at.desc())
                .limit(HISTORY_ROUNDS * 2)
            )
            rows = list(reversed(result.scalars().all()))
        messages: list[dict[str, str]] = []
        for m in rows:
            if m.role not in ("user", "assistant"):
                continue
            text = ""
            for b in m.blocks or []:
                if b.get("type") == "text":
                    text = (b.get("content") or {}).get("text") or ""
                    break
            if not text:
                continue
            messages.append({"role": m.role, "content": text})
        return messages

    # ---------- 主流程 ----------
    async def stream(
        self,
        *,
        session_id,
        user_text: str,
        datasource_id: str | None = None,
        attachments: list[str] | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """产出 SSE 事件字典：{"event": ..., "data": ...}。"""
        # 1) 用户消息落库（前端已乐观渲染，无需回推事件）
        await self._persist_message(session_id, "user", [_text_block(user_text, "completed")])
        await self._maybe_update_title(session_id, user_text)

        # 2) assistant 消息骨架：首个 text block 作为流式容器
        message_id = str(uuid.uuid4())
        block = _text_block("")
        block_id = block["id"]
        yield {"event": "block_start", "data": {"block_id": block_id, "type": "text", "content": {"text": ""}}}

        # 3) 组装上下文并调用 LLM
        llm_cfg = await self._config.get_llm_config()
        provider = build_llm_provider(llm_cfg)
        history = await self._load_history(session_id)  # 含刚落库的用户消息
        messages = [{"role": "system", "content": SYSTEM_PROMPT}, *history]

        parts: list[str] = []
        try:
            async for chunk in provider.stream_chat(messages):
                parts.append(chunk)
                yield {"event": "token", "data": {"block_id": block_id, "content": chunk}}
        except Exception as exc:
            # 失败路径：text block 置 failed，追加 error block 落库，发 error 事件后结束（无 done）
            logger.exception("LLM 流式调用失败", extra={"session_id": str(session_id)})
            err = _error_block("LLM_ERROR", str(exc)[:500])
            block["status"] = "failed"
            block["content"]["text"] = "".join(parts)
            await self._persist_message(
                session_id, "assistant", [block, err],
                metadata={"usage": {}}, message_id=message_id,
            )
            yield {"event": "block_end", "data": {"block_id": block_id, "status": "failed"}}
            yield {"event": "error", "data": {"code": "LLM_ERROR", "message": str(exc)[:500]}}
            return

        # 4) 成功路径：block 终态 + 消息落库 + done
        usage: Usage = provider.usage
        usage_dict = {
            "prompt_tokens": usage.prompt_tokens,
            "completion_tokens": usage.completion_tokens,
            "total_tokens": usage.total_tokens,
        }
        block["status"] = "completed"
        block["content"]["text"] = "".join(parts)
        await self._persist_message(
            session_id, "assistant", [block],
            metadata={"usage": usage_dict}, message_id=message_id,
        )
        yield {"event": "block_end", "data": {"block_id": block_id, "status": "completed"}}
        yield {"event": "done", "data": {"message_id": message_id, "usage": usage_dict}}