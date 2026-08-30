"""上下文压缩服务（契约 docs/技术方案设计.md 4.8）。

职责：
1. `context_compaction_executor` —— 任务队列执行器：把「水位线 summary_upto 之后」
   的会话消息交给 LLM 压缩为结构化摘要，与旧摘要合并后写回 sessions 并推进水位线。
2. `should_compact(session_id)` —— 判断未压缩历史是否超过阈值（由 ChatService 在
   每轮结束后调用，触发投递压缩任务）。
3. `load_summary(session_id)` —— 读会话摘要（组装上下文用）。

幂等与并发：任务队列单消费者保证同一会话的压缩任务串行执行；水位线即幂等标记，
压缩完成后推进，失败不推进（下次重试）。会话已删 → 任务 no-op 成功。
"""
import datetime
import json
import logging
import re
from typing import Any
from uuid import UUID

from sqlalchemy import select

from app.core.database import SessionFactory
from app.llm.base import build_llm_provider
from app.llm.tokenizer import token_estimator
from app.models.user import Message, Session
from app.services.config_service import ConfigService

logger = logging.getLogger("datapilot.context")

# 未压缩历史超过该阈值才触发压缩（token，预估口径同消息落库 tokens）
COMPACT_THRESHOLD_TOKENS = 6000
# 摘要本体 token 上限（超出时丢弃 rounds 尾部，保住 topic/关键结论）
SUMMARY_MAX_TOKENS = 1000
# 摘要生成请求 max_tokens（输出侧）：真实历史较长时摘要可能偏大，给足余量防截断
SUMMARY_OUTPUT_TOKENS = 1500

_SUMMARY_SYSTEM = (
    "你负责把一段数据分析对话历史压缩为结构化 JSON 摘要，供后续对话继承上下文。\n"
    "输出必须 ONLY 是合法 JSON 对象（不要 markdown 代码块、不要解释），字段如下：\n"
    '{"topic": "对话主题一句话", "user_goal": "用户的核心目标", '
    '"key_facts": ["关键事实/口径/数据结论，3-6 条"], '
    '"key_decisions": ["已确定的分析口径/选择，2-4 条"], '
    '"rounds": [{"q": "用户问题一行", "a": "AI 结论要点一行"}]}\n'
    "rounds 最多保留 6 轮；每轮 q/a 各不超过 40 字。事实与口径务必准确，不要臆造。"
)


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _message_compact_text(m: Message) -> str:
    """单条消息的压缩文本（与 ChatService._load_history 的摘要口径一致）。"""
    text = ""
    data_lines: list[str] = []
    for b in m.blocks or []:
        btype = b.get("type")
        if btype == "text" and not text:
            text = (b.get("content") or {}).get("text") or ""
        elif btype == "table":
            content = b.get("content") or {}
            cols = ", ".join(c.get("key", "") for c in content.get("columns", []))
            line = f"[数据表] 列: {cols}，共 {content.get('total', 0)} 行"
            if content.get("query"):
                line += f"，查询: {str(content['query'])[:120]}"
            data_lines.append(line)
        elif btype == "chart":
            content = b.get("content") or {}
            data_lines.append(
                f"[图表] {content.get('chart_type', '')}（{content.get('title', '未命名')}）"
            )
    parts = [p for p in ([text, *data_lines] if text else data_lines) if p]
    if m.role == "assistant":
        for call in (m.metadata_ or {}).get("tool_calls") or []:
            name = str(call.get("name") or "")
            if not name:
                continue
            parts.append(f"[工具调用] {name} → {call.get('status', '')}")
    return "\n".join(parts)


async def _unsummarized_messages(session_id: UUID, upto_id: UUID | None) -> list[Message]:
    """水位线之后、待压缩的 user/assistant 消息（升序）。"""
    async with SessionFactory() as db:
        stmt = (
            select(Message)
            .where(Message.session_id == session_id, Message.role.in_(("user", "assistant")))
            .order_by(Message.created_at.asc(), Message.id.asc())
        )
        if upto_id is not None:
            stmt = stmt.where(Message.id > upto_id)
        return list((await db.execute(stmt)).scalars().all())


def _unsummarized_tokens(msgs: list[Message]) -> int:
    return sum(m.tokens or token_estimator.estimate("openai", "gpt-4o", _message_compact_text(m)) for m in msgs)


def _trim_summary(summary: dict, max_tokens: int = SUMMARY_MAX_TOKENS) -> dict:
    """摘要超预算时丢弃 rounds 尾部（保 topic / goal / 事实 / 决策）。"""
    if token_estimator.estimate("openai", "gpt-4o", json.dumps(summary, ensure_ascii=False)) <= max_tokens:
        return summary
    rounds = summary.get("rounds") or []
    while rounds and token_estimator.estimate("openai", "gpt-4o", json.dumps(summary, ensure_ascii=False)) > max_tokens:
        rounds = rounds[:-1]
        summary["rounds"] = rounds
    return summary


async def should_compact(session_id: UUID) -> bool:
    """未压缩历史是否超过阈值（ChatService 每轮结束后调用）。"""
    async with SessionFactory() as db:
        sess = await db.get(Session, session_id)
        if sess is None:
            return False
        msgs = await _unsummarized_messages(session_id, sess.summary_upto)
    return _unsummarized_tokens(msgs) >= COMPACT_THRESHOLD_TOKENS


async def load_summary(session_id: UUID) -> dict:
    """读会话摘要（组装上下文 L1 层；无摘要返回空 dict）。"""
    async with SessionFactory() as db:
        sess = await db.get(Session, session_id)
        if sess is None:
            return {}
        return sess.context_summary or {}


def render_summary(summary: dict) -> str:
    """结构化摘要 → 上下文文本（组装上下文 L1 层）。"""
    lines = ["此前对话的压缩背景："]
    if summary.get("topic"):
        lines.append(f"主题：{summary['topic']}")
    if summary.get("user_goal"):
        lines.append(f"用户目标：{summary['user_goal']}")
    if summary.get("key_facts"):
        lines.append("关键事实：" + "；".join(summary["key_facts"]))
    if summary.get("key_decisions"):
        lines.append("已确定口径：" + "；".join(summary["key_decisions"]))
    for r in (summary.get("rounds") or [])[-6:]:
        lines.append(f"- 曾问：{r.get('q', '')} → 结论：{r.get('a', '')}")
    return "\n".join(lines)


async def has_pending_compaction(session_id: UUID) -> bool:
    """该会话是否已有 pending/running 的压缩任务（防重复投递）。"""
    from app.models.task import Task

    async with SessionFactory() as db:
        hit = await db.scalar(
            select(Task.id)
            .where(
                Task.session_id == session_id,
                Task.type == "context_compaction",
                Task.status.in_(("pending", "running")),
            )
            .limit(1)
        )
        return hit is not None


async def context_compaction_executor(params: dict, ctx) -> dict:
    """任务执行器（type=context_compaction）：增量压缩并推进水位线。

    失败不推进水位线 → 任务 failed，下次触发重试；会话已删/无新内容 → no-op 成功。
    """
    del ctx  # 压缩任务不推送进度（无用户可见进度语义）
    session_id = params.get("session_id")
    if not session_id:
        return {"ok": True, "skipped": "missing_session_id"}
    session_id = UUID(session_id)
    async with SessionFactory() as db:
        sess = await db.get(Session, session_id)
        if sess is None:
            return {"ok": True, "skipped": "session_deleted"}
        old_summary = sess.context_summary or {}
        upto = sess.summary_upto
        model = params.get("model") or sess.summary_model or ""
    msgs = await _unsummarized_messages(session_id, upto)
    if not msgs:
        return {"ok": True, "skipped": "no_new_messages"}

    # 组装压缩输入：每轮一对「用户 → AI」
    rounds_text: list[str] = []
    pending_user: str | None = None
    for m in msgs:
        t = _message_compact_text(m)[:600]
        if not t:
            continue
        if m.role == "user":
            pending_user = t
        else:
            rounds_text.append(f"用户：{pending_user or '（追问）'}\nAI：{t}")
            pending_user = None
    if pending_user:
        rounds_text.append(f"用户：{pending_user}")
    if not rounds_text:
        return {"ok": True, "skipped": "no_content"}
    content = "\n\n".join(rounds_text[-12:])  # 最多 12 轮，防输入侧过大

    llm_cfg = await ConfigService().get_llm_config()
    provider = build_llm_provider(llm_cfg)
    provider_model = llm_cfg.get("model") or "unknown"
    raw = await provider.chat(
        [
            {"role": "system", "content": _SUMMARY_SYSTEM},
            {"role": "user", "content": f"历史对话（待压缩新增部分）：\n{content}"},
        ],
        max_tokens=SUMMARY_OUTPUT_TOKENS,
    )
    new_summary = _parse_summary_json(raw)
    if not new_summary:
        # 解析失败：不推进水位线，任务 failed，下次触发重试（防止把历史"压空"）
        logger.warning(
            "压缩摘要解析失败，任务不推进水位线",
            extra={"session_id": str(session_id), "raw_head": raw[:200]},
        )
        raise RuntimeError("LLM 摘要输出非合法 JSON，未推进水位线")

    # 合并：topic/goal 取最新；事实与决策追加去重；rounds 合并去重截断
    merged = {
        "topic": new_summary.get("topic") or old_summary.get("topic") or "",
        "user_goal": new_summary.get("user_goal") or old_summary.get("user_goal") or "",
        "key_facts": _merge_dedup(old_summary.get("key_facts", []), new_summary.get("key_facts", [])),
        "key_decisions": _merge_dedup(old_summary.get("key_decisions", []), new_summary.get("key_decisions", [])),
        "rounds": _merge_dedup(old_summary.get("rounds", []), new_summary.get("rounds", [])),
    }
    merged = _trim_summary(merged)
    summary_tokens = token_estimator.estimate("openai", "gpt-4o", json.dumps(merged, ensure_ascii=False))

    async with SessionFactory() as db:
        sess = await db.get(Session, session_id)
        if sess is None:
            return {"ok": True, "skipped": "session_deleted"}
        sess.context_summary = merged
        sess.summary_upto = msgs[-1].id  # 推进水位线到已压缩的最后一条
        sess.summary_tokens = summary_tokens
        sess.summary_model = provider_model
        sess.summary_at = datetime.datetime.now(datetime.timezone.utc)
        await db.commit()
    logger.info(
        "上下文压缩完成", extra={"session_id": str(session_id), "messages": len(msgs), "tokens": summary_tokens}
    )
    return {"ok": True, "summary_tokens": summary_tokens, "compacted": len(msgs)}


def _parse_summary_json(raw: str) -> dict:
    """解析 LLM 摘要输出：容忍代码块包裹与首尾噪声，容忍 JSON 被截断（补全后重试）。

    返回空 dict 表示彻底解析失败，调用方应视为任务失败（不推进水位线）。
    """
    text = (raw or "").strip()
    if text.startswith("```"):
        # 去掉 markdown 代码围栏
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    obj = None
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        obj = None
    if not isinstance(obj, dict):
        # 纯 JSON 解析失败：优先提取首个 {...} 块（夹带说明文字）；无闭合块则对全文
        # 做截断修复（LLM 输出被 max_tokens 截断时 JSON 无闭合括号，正则匹配不到）
        m = re.search(r"\{.*\}", text, re.DOTALL)
        candidate = m.group(0) if m else text
        try:
            obj = json.loads(candidate)
        except json.JSONDecodeError:
            obj = _repair_truncated_json(candidate)
    if isinstance(obj, dict) and obj:
        return obj
    return {}


def _repair_truncated_json(text: str) -> dict | None:
    """截断 JSON 修复：去尾逗号 → 补未闭合字符串引号 → 按括号栈补全 ] / } → 再解析。

    失败返回 None（调用方视为任务失败，不推进水位线）。
    """
    text = text.rstrip()
    # 1) 截断常发生在某个值后的逗号处：去掉尾部逗号，避免补全后出现尾逗号
    text = re.sub(r",+\s*$", "", text)
    # 2) 未闭合字符串：结尾落在字符串内部时补上闭合引号
    if _ends_inside_string(text):
        text += '"'
    # 3) 按括号栈补全（跳过字符串内的括号）
    pairs = {"{": "}", "[": "]"}
    stack: list[str] = []
    in_str = False
    escaped = False
    for ch in text:
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack and pairs[stack[-1]] == ch:
                stack.pop()
            else:
                return None  # 括号错配，无法可靠修复
    if not stack:
        return None
    repaired = text + "".join(pairs[c] for c in reversed(stack))
    try:
        obj = json.loads(repaired)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        return None


def _ends_inside_string(text: str) -> bool:
    """文本是否在未闭合的 JSON 字符串内（未转义引号数为奇数）。"""
    in_str = False
    escaped = False
    for ch in text:
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
        elif ch == '"':
            in_str = not in_str
    return in_str


def _merge_dedup(old: list, new: list) -> list:
    """按值去重合并（str 直接比；dict 按 json 序列化比），保留新在前、总长截断。"""
    seen: set[str] = set()
    out: list[Any] = []
    for item in [*new, *old]:
        if not item:
            continue
        key = item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out[:20]
