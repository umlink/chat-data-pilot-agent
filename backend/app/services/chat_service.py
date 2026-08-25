"""ChatService：对话编排（M2：Agent 循环 + 工具集）。

契约见 docs/Block与协议规范.md 第 3、4 章：
- 对外以 SSE 事件流产出（token / block_start / block_end / error / done），API 层负责组帧。
- messages.blocks 是唯一事实源：流结束（或失败）后整条消息落库，SSE 只是加速通道。
- 编排模型（4.1）：Agent 循环 + 工具调用，上限 8 轮；
  工具调用与结果记录在 assistant 消息 metadata.tool_calls（不生成用户可见 block）；
  用户可见内容 = LLM 自然语言（text block）+ 工具副作用（table/chart/confirmation block）；
  request_confirmation 调用后本轮终止，等待 POST /api/chat/execute 决策驱动后续。
- usage 取自 LLM 适配器累计值（多轮累计），随 done 事件返回并写入 assistant metadata。
- 已知限制：历史重放只含 text block（table/chart 压缩为摘要行，见 _load_history），
  工具调用不重放（数据已持久化在 block 中，后续轮次可重新查询）。
"""
import datetime
import json
import logging
import uuid
from typing import Any, AsyncGenerator

from sqlalchemy import select

from app.agents.tools import TOOL_DEFINITIONS, ToolCtx, ToolEngine
from app.core.database import SessionFactory
from app.llm.base import Usage, build_llm_provider
from app.models.user import Message, Session
from app.services.config_service import ConfigService

logger = logging.getLogger("datapilot.chat")

DEFAULT_TITLES = {"新会话", "新对话", "新聊天"}
HISTORY_ROUNDS = 10  # 最近 10 轮（20 条）进入上下文
MAX_TOOL_ROUNDS = 8  # Agent 循环上限（契约 4.1）

SYSTEM_PROMPT = (
    "你是 DataPilotAgent，一个专业的智能数据分析助手。用简洁、专业的中文回答。\n"
    "可用工具：\n"
    "1. run_sql：对数据源执行 SQL。SELECT 直接执行；写操作会被安全策略拦截并转为确认卡片。"
    "att_ 开头的表是附件数据，跨源合并请用 run_python。\n"
    "2. run_python：受限沙箱执行 pandas/numpy 代码，输入是 run_sql 产出的 table block（注入为 df1/df2…），"
    "调用 return_table(df) 生成新表。\n"
    "3. create_chart：基于 table block 生成图表（line/bar/pie/scatter/heatmap），指定 dimension 与 measures 即可。\n"
    "4. request_confirmation：危险写操作前请求用户确认；调用后本轮对话终止。\n"
    "工作方式：问题缺少必要参数（时间范围、指标口径等）时先澄清再行动，不要臆测；"
    "需要数据先 run_sql（结果自动存为 table block）；统计计算用 run_python；"
    "适合可视化时用 create_chart。工具执行完，用中文总结结论、给出数据洞察。"
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


def _block_start(block: dict[str, Any]) -> dict[str, Any]:
    return {
        "event": "block_start",
        "data": {
            "block_id": block["id"],
            "type": block["type"],
            "status": block["status"],
            "content": block["content"],
        },
    }


def _block_end(block: dict[str, Any], status: str | None = None) -> dict[str, Any]:
    return {
        "event": "block_end",
        "data": {"block_id": block["id"], "status": status or block["status"]},
    }


class ChatService:
    def __init__(self, config_service: ConfigService | None = None,
                 tool_engine: ToolEngine | None = None):
        self._config = config_service or ConfigService()
        self._tools = tool_engine or ToolEngine()

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
        """最近 N 轮压缩为 OpenAI 风格消息。

        取各消息首个 text block 作为正文；table/chart 等数据 block 压缩为
        「[数据] 表X: 列… 共N行」摘要行（契约 4.4：更早的 table/chart 压缩进上下文）。
        """
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
            data_lines: list[str] = []
            for b in m.blocks or []:
                btype = b.get("type")
                if btype == "text" and not text:
                    text = (b.get("content") or {}).get("text") or ""
                elif btype == "table":
                    content = b.get("content") or {}
                    cols = ", ".join(c.get("key", "") for c in content.get("columns", []))
                    data_lines.append(f"[数据表] 列: {cols}，共 {content.get('total', 0)} 行")
                elif btype == "chart":
                    content = b.get("content") or {}
                    data_lines.append(f"[图表] {content.get('chart_type', '')}（{content.get('title', '未命名')}）")
            if not text and not data_lines:
                continue
            parts = []
            if text:
                parts.append(text)
            parts.extend(data_lines)
            messages.append({"role": m.role, "content": "\n".join(parts)})
        return messages

    # ---------- 主流程 ----------
    async def stream(
        self,
        *,
        session_id,
        user_text: str,
        user_id=None,
        datasource_id: str | None = None,
        attachments: list[str] | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """产出 SSE 事件字典：{"event": ..., "data": ...}。

        流程：用户消息落库 → 组装上下文 → Agent 循环（≤8 轮）：
        每轮 LLM 决策（流式 text + 可选工具调用）；工具副作用生成 table/chart/confirmation block；
        request_confirmation 或纯文本输出 → 终止循环 → 消息落库 + done。
        """
        # 1) 用户消息落库（前端已乐观渲染，无需回推事件）
        await self._persist_message(session_id, "user", [_text_block(user_text, "completed")])
        await self._maybe_update_title(session_id, user_text)

        # 2) assistant 消息骨架：text block 作为流式容器
        message_id = str(uuid.uuid4())
        text_block = _text_block("")
        text_block_id = text_block["id"]
        yield _block_start(text_block)

        # 3) 组装上下文
        llm_cfg = await self._config.get_llm_config()
        provider = build_llm_provider(llm_cfg)
        history = await self._load_history(session_id)  # 含刚落库的用户消息
        system = SYSTEM_PROMPT
        if attachments:
            system += (
                "\n本次会话附带了附件数据（表名以 att_ 开头，位于独立引擎，"
                "跨源 JOIN 请用 run_python 合并）。"
            )
        if datasource_id:
            system += "\n本次请求指定了数据源，run_sql 时省略 datasource_id 即使用该数据源。"
        messages: list[dict[str, Any]] = [{"role": "system", "content": system}, *history]

        max_rows = int((await self._config.get("system.query") or {}).get("max_query_rows", 1000))
        tctx = ToolCtx(
            session_id=session_id,
            user_id=user_id,
            datasource_id=datasource_id,
            max_query_rows=max_rows,
        )
        parts: list[str] = []
        side_blocks: list[dict[str, Any]] = []
        usage = Usage()
        stop_reason = "text"
        try:
            for _round in range(MAX_TOOL_ROUNDS):
                tool_call: dict | None = None
                async for chunk in provider.stream_chat_with_tools(messages, TOOL_DEFINITIONS):
                    if isinstance(chunk, dict):
                        tool_call = chunk.get("__tool_call__")
                    else:
                        parts.append(chunk)
                        yield {"event": "token", "data": {"block_id": text_block_id, "content": chunk}}

                if tool_call is None:
                    break  # 纯文本输出 → 本轮结束
                name = tool_call.get("name", "")
                arguments = tool_call.get("arguments") or {}
                # 工具调用与结果以 OpenAI 协议消息回填（适配器负责协议转换）
                messages.append({
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": tool_call.get("id", ""),
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)},
                    }],
                })
                logger.info("Agent 工具调用", extra={"tool": name, "session_id": str(session_id)})
                out = await self._tools.execute(name, arguments, tctx)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.get("id", ""),
                    "content": out["text"],
                })
                for block in tctx.blocks:
                    side_blocks.append(block)
                    yield _block_start(block)
                    if block["type"] != "confirmation":
                        yield _block_end(block)
                tctx.blocks.clear()
                if out.get("stop"):
                    stop_reason = "confirmation"
                    break
            else:
                stop_reason = "max_rounds"
        except Exception as exc:
            # 失败路径：text block 置 failed，追加 error block 落库，发 error 事件后结束（无 done）
            logger.exception("LLM 流式调用失败", extra={"session_id": str(session_id)})
            err = _error_block("LLM_ERROR", str(exc)[:500])
            text_block["status"] = "failed"
            text_block["content"]["text"] = "".join(parts)
            await self._persist_message(
                session_id, "assistant", [text_block, err, *side_blocks],
                metadata={"usage": {}}, message_id=message_id,
            )
            yield _block_end(text_block, "failed")
            yield {"event": "error", "data": {"code": "LLM_ERROR", "message": str(exc)[:500]}}
            return

        # 4) 成功路径：text block 终态 + 工具副作用落库 + done
        usage = provider.usage
        usage_dict = {
            "prompt_tokens": usage.prompt_tokens,
            "completion_tokens": usage.completion_tokens,
            "total_tokens": usage.total_tokens,
        }
        text_block["status"] = "completed"
        text_block["content"]["text"] = "".join(parts)
        metadata: dict[str, Any] = {"usage": usage_dict, "stop_reason": stop_reason}
        if tctx.tool_calls:
            metadata["tool_calls"] = tctx.tool_calls
        blocks = [text_block, *side_blocks]
        await self._persist_message(
            session_id, "assistant", blocks,
            metadata=metadata, message_id=message_id,
        )
        yield _block_end(text_block)
        yield {"event": "done", "data": {"message_id": message_id, "usage": usage_dict}}