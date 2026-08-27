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
import re
import uuid
from typing import Any, AsyncGenerator
from uuid import UUID

from sqlalchemy import select

from app.agents.tools import TOOL_DEFINITIONS, ToolCtx, ToolEngine
from app.core.database import SessionFactory
from app.llm.base import build_llm_provider
from app.models.user import Message, Session
from app.services.config_service import ConfigService
from app.services.data_service import DataService

logger = logging.getLogger("datapilot.chat")

DEFAULT_TITLES = {"新会话", "新对话", "新聊天"}
HISTORY_ROUNDS = 10  # 最近 10 轮（20 条）进入上下文
MAX_TOOL_ROUNDS = 8  # Agent 循环上限（契约 4.1）
CONTEXT_TOKEN_BUDGET = 8000  # 契约 4.4：schema + 历史总量控制在 8K token 内

# 数据源 schema 注入只对单表结构注入的最大表数 / 单行描述长度（防超长 schema 挤占历史预算）
SCHEMA_MAX_TABLES = 20
SCHEMA_MAX_COLUMNS = 30


def _estimate_tokens(text: str) -> int:
    """粗略估算 token 数：中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token，取中值兜底。"""
    return max(1, (len(text) + 1) // 2)


def _json_safe(value: Any) -> Any:
    """递归把非有限浮点数（NaN / ±Infinity）转为 None，保证可写入 PostgreSQL JSONB。

    pandas 沙箱 / 数据库聚合可能出现 NaN（如 0/0、空集比例），JSONB 拒绝这类 token，
    落库前统一净化，避免 INSERT 500 导致整条消息丢失。
    """
    import math

    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value

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
    "澄清时先输出澄清问题文本，然后换行输出一行『可点击选项：』，其后每行一个选项（格式：编号 + 文案，如『1. 近 7 天』），"
    "选项文案会被用户直接点击发送，请确保选项完整可执行；"
    "每次完成分析并输出结论后，同样换行输出一行『可点击选项：』（必须用该标记行，不要用其他文案替代），"
    "其后给出 2-3 个基于当前结果、可直接执行的下一步分析选项"
    "（如按其他维度分组、生成图表、深入某条洞察），格式与澄清选项一致；"
    "对话中用户可能用『改成/不是/换成/用上次/接着/那/它』等指代上一轮分析，先解析指代对象（表、口径、图表）"
    "再基于上轮结果行动，例如『改成按周分组』= 对上一轮查询结果重新按周聚合，不要当成全新问题；"
    "需要数据先 run_sql（结果自动存为 table block）；统计计算用 run_python；"
    "适合可视化时用 create_chart。工具执行完，用中文总结结论、给出数据洞察。"
)


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


# 契约 4.4 澄清机制：LLM 在文本中输出「可点击选项：」标记行，其下为编号选项
_SUGGESTION_HEADER = re.compile(r"^可点击选项[:：]\s*$", re.MULTILINE)


def _extract_suggestions(text: str) -> tuple[str, list[dict[str, str]] | None]:
    """从 LLM 纯文本中解析澄清选项，返回 (净化后的文本, suggestions items 或 None)。

    约定格式：澄清问题文本 + 单独一行「可点击选项：」+ 每行一个选项（`1. 文案` / `1、文案`）。
    命中解析失败（无合法编号行）时整体不生成 suggestions，保留原文本。
    """
    m = _SUGGESTION_HEADER.search(text)
    if not m:
        return text, None
    items: list[dict[str, str]] = []
    for line in text[m.end() :].splitlines():
        # 兼容编号（1. / 1、）与列表（- / • / *）两种选项格式（LLM 输出不稳定时兜底）
        hit = re.match(r"^\s*(?:\d+[.、]|[-•*])\s*(.+)$", line)
        if hit:
            item = hit.group(1).strip()
            if item:
                items.append({"text": item, "message": item})
    if not items:
        return text, None
    clean = text[: m.start()].rstrip()
    return clean, items


def _suggestions_block(items: list[dict[str, str]]) -> dict[str, Any]:
    """生成 suggestions block（契约 2.7：items[{text, message}]）。"""
    return {
        "id": str(uuid.uuid4()),
        "type": "suggestions",
        "status": "completed",
        "content": {"items": items},
    }


def _summarize_history(msgs: list[dict[str, str]], max_rows: int = 8) -> str:
    """把超出上下文预算的早期轮次压缩为摘要（启发式，无 LLM 调用）。

    每轮取「用户问题 → AI 结论首行」各一行；轮次过多时保留首尾代表行，
    防止摘要本身挤占上下文预算。
    """
    lines: list[str] = []
    for m in msgs:
        first = m["content"].splitlines()[0].strip()[:80]
        if not first:
            continue
        prefix = "用户曾问" if m["role"] == "user" else "AI 要点"
        lines.append(f"{prefix}：{first}")
    if not lines:
        return ""
    if len(lines) > max_rows:
        lines = lines[: max_rows // 2] + ["…（中间轮次略）…"] + lines[-(max_rows // 2):]
    return "更早对话的压缩摘要（已超出上下文预算，仅保留要点）：\n" + "\n".join(lines)


# 从 SQL 中提取 FROM / JOIN 引用的表名（跨方言去修饰符；多数据源场景保守取字面名）
_TABLE_RE = re.compile(r"\b(?:FROM|JOIN)\s+([A-Za-z_][\w.$`\"]*)", re.IGNORECASE)


def _extract_tables(sql: str) -> list[str]:
    """提取 SQL 引用的表名并去重（按出现顺序）。"""
    names: list[str] = []
    for m in _TABLE_RE.finditer(sql):
        name = m.group(1).strip("`\"")
        if name.lower() in ("dual",):
            continue
        if name not in names:
            names.append(name)
    return names


def _build_sources_block(
    tctx: ToolCtx,
    datasource_label: str | None,
    side_blocks: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """根据本回合工具执行轨迹确定性推导『数据来源』证据链（契约 2.11 sources）。

    数据源 = run_sql 调用的 datasource（或会话所选/默认）；表名 = 各 SQL 的 FROM/JOIN 解析；
    查询 = 本回合去重后的 SQL（run_sql 调用 + 副作用 block 的 query）。
    全部从已落库的 tctx 轨迹推导，不依赖 LLM 额外格式化；本回合无任何查询时不生成。
    """
    sqls: list[str] = []
    seen: set[str] = set()
    for call in tctx.tool_calls:
        if call.get("name") == "run_sql" and call.get("status") == "ok":
            sql = str((call.get("arguments") or {}).get("sql") or "").strip()
            if sql and sql not in seen:
                seen.add(sql)
                sqls.append(sql)
    for b in side_blocks:
        if b.get("type") in ("table", "chart"):
            q = str((b.get("content") or {}).get("query") or "").strip()
            if q and q not in seen:
                seen.add(q)
                sqls.append(q)
    if not sqls:
        return None  # 本回合未执行任何查询 → 无证据链可展示
    items: list[dict[str, Any]] = []
    if datasource_label:
        items.append({"label": f"数据源：{datasource_label}"})
    tables: list[str] = []
    for sql in sqls:
        for name in _extract_tables(sql):
            if name not in tables:
                tables.append(name)
    for name in tables:
        items.append({"label": name})
    for i, sql in enumerate(sqls[:5], start=1):
        items.append({"label": f"查询 {i}", "sql": sql})
    return {
        "id": str(uuid.uuid4()),
        "type": "sources",
        "status": "completed",
        "content": {"items": items},
    }


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
                blocks=_json_safe(blocks),
                metadata_=_json_safe(metadata or {}),
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
        「[数据] 表X: 列… 共N行」摘要行（契约 4.4：摘要含列名 + 行数 + 查询语句）；
        assistant 消息的工具调用（metadata.tool_calls）重放为「[工具调用] 名称(参数) → 状态」
        文本行（契约 4.3：tool_calls 记录用于上下文重放与审计）。
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
                    query = content.get("query") or ""
                    line = f"[数据表] 列: {cols}，共 {content.get('total', 0)} 行"
                    if query:
                        line += f"，查询: {str(query)[:120]}"
                    data_lines.append(line)
                elif btype == "chart":
                    content = b.get("content") or {}
                    data_lines.append(f"[图表] {content.get('chart_type', '')}（{content.get('title', '未命名')}）")
            if not text and not data_lines:
                continue
            parts = []
            if text:
                parts.append(text)
            parts.extend(data_lines)
            # 契约 4.3：工具调用重放（结果数据已在 table block 摘要中，无需重复回填全文）
            if m.role == "assistant":
                for call in (m.metadata_ or {}).get("tool_calls") or []:
                    name = str(call.get("name") or "")
                    if not name:
                        continue
                    args = json.dumps(call.get("arguments") or {}, ensure_ascii=False)[:200]
                    parts.append(f"[工具调用] {name}({args}) → {call.get('status', '')}")
            messages.append({"role": m.role, "content": "\n".join(parts)})
        return messages

    # ---------- 数据源 schema 注入（契约 4.4） ----------
    async def _resolve_schema(self, user_id, datasource_id: str | None) -> str:
        """取主数据源（或指定数据源）的表结构文本；异常/非 PostgreSQL 时静默跳过。

        契约 4.4 要求注入表名/列名/类型/注释 + 每表 3 行采样；MVP 只注入表结构，
        采样数据属于「超出预算优先压缩」项（见契约 4.4 上下文预算），故省略。
        """
        from app.models.datasource import Datasource

        try:
            async with SessionFactory() as db:
                if datasource_id:
                    try:
                        ds = await db.get(Datasource, UUID(datasource_id))
                    except ValueError:
                        return ""
                    if ds is None or ds.user_id != user_id:
                        return ""
                else:
                    result = await db.execute(
                        select(Datasource)
                        .where(Datasource.user_id == user_id)
                        .order_by(Datasource.created_at.asc())
                        .limit(1)
                    )
                    ds = result.scalar_one_or_none()
                    if ds is None:
                        return ""
            if ds.type not in ("postgresql", "mysql"):
                return ""
            schema = await DataService().get_schema(ds)
        except Exception as exc:  # schema 注入失败不应阻断对话：降级为不注入
            # 异常详情写入 context（CLAUDE.md 4.7：不把堆栈塞进 message），便于排查密钥/连接类问题
            logger.warning(
                "数据源 schema 注入失败（跳过）",
                extra={"datasource_id": datasource_id, "error": str(exc)[:300]},
            )
            return ""
        lines = [f"数据源 {ds.name}（{ds.type}）表结构："]
        for table in schema.get("tables", [])[:SCHEMA_MAX_TABLES]:
            cols = ", ".join(
                f"{c['name']}({c['data_type']})"
                for c in table.get("columns", [])[:SCHEMA_MAX_COLUMNS]
            )
            comment = f" // {table['comment']}" if table.get("comment") else ""
            lines.append(f"- {table['schema']}.{table['name']}: {cols}{comment}")
        return "\n".join(lines)

    async def _attachment_schema(self, session_id, attachments: list[str]) -> str:
        """把已解析附件（表名 + 列 + 行数）注入系统提示，AI 可直接 run_sql 查询 att_ 表。

        附件归属校验：Attachment.session_id 必须等于当前会话；未解析完成（无 parsed_schema）
        的附件跳过。返回的提示自带换行前导。
        """
        from app.models.datasource import Attachment

        rows: list[Attachment] = []
        async with SessionFactory() as db:
            for aid in attachments[:5]:
                try:
                    att = await db.get(Attachment, UUID(aid))
                except ValueError:
                    continue
                if att is None or str(att.session_id) != str(session_id) or not att.parsed_schema:
                    continue
                rows.append(att)
        if not rows:
            return ""
        lines = ["\n## 附件数据（独立引擎，直接用 run_sql 查询，表名以 att_ 开头）"]
        for att in rows:
            schema = att.parsed_schema or {}
            cols = ", ".join(
                f"{c.get('name')}({c.get('dtype', 'string')})"
                for c in schema.get("columns", [])
            )
            lines.append(
                f"- 附件「{att.file_name}」→ 表 {schema.get('table_name', 'att_?')}，"
                f"{schema.get('row_count', '?')} 行：{cols}"
            )
        return "\n".join(lines)

    async def _resolve_datasource_label(
        self, user_id, datasource_id: str | None
    ) -> str | None:
        """解析数据源展示名（name（type）），用于 sources 证据链；失败/无权返回 None。"""
        from app.models.datasource import Datasource

        try:
            async with SessionFactory() as db:
                if datasource_id:
                    try:
                        ds = await db.get(Datasource, UUID(datasource_id))
                    except ValueError:
                        return None
                    if ds is None or ds.user_id != user_id:
                        return None
                else:
                    result = await db.execute(
                        select(Datasource)
                        .where(Datasource.user_id == user_id)
                        .order_by(Datasource.created_at.asc())
                        .limit(1)
                    )
                    ds = result.scalar_one_or_none()
                    if ds is None:
                        return None
            return f"{ds.name}（{ds.type}）"
        except Exception:
            return None

    # ---------- 主流程 ----------
    async def stream(
        self,
        *,
        session_id,
        user_text: str,
        user_id=None,
        datasource_id: str | None = None,
        attachments: list[str] | None = None,
        client_msg_id: str | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """产出 SSE 事件字典：{"event": ..., "data": ...}。

        流程：用户消息落库 → 组装上下文 → Agent 循环（≤8 轮）：
        每轮 LLM 决策（流式 text + 可选工具调用）；工具副作用生成 table/chart/confirmation block；
        request_confirmation 或纯文本输出 → 终止循环 → 消息落库 + done。
        client_msg_id：前端乐观消息 id，用于断线重连幂等（同一 id 已落库则不再重复执行）。
        """
        # 1) 用户消息落库（前端已乐观渲染，无需回推事件）
        #    幂等：断线重连携带同一 client_msg_id 时，若该用户消息已落库 → 直接提示，避免重复执行/重复落库
        if client_msg_id:
            async with SessionFactory() as db:
                dup = await db.scalar(
                    select(Message.id)
                    .where(
                        Message.session_id == session_id,
                        Message.role == "user",
                        Message.metadata_["client_msg_id"].astext == client_msg_id,
                    )
                    .limit(1)
                )
            if dup:
                yield {"event": "error", "data": {
                    "code": "DUPLICATE_MESSAGE",
                    "message": "该消息已在处理中或已完成，请刷新页面查看最新结果",
                }}
                return
        await self._persist_message(
            session_id, "user", [_text_block(user_text, "completed")],
            metadata={"client_msg_id": client_msg_id} if client_msg_id else None,
        )
        await self._maybe_update_title(session_id, user_text)

        # 2) assistant 消息骨架：text block 作为流式容器
        message_id = str(uuid.uuid4())
        text_block = _text_block("")
        text_block_id = text_block["id"]
        yield _block_start(text_block)

        # 3) 组装上下文（契约 4.4：注入数据源 schema，schema + 历史总量 ≤ 8K token）
        # LLM 配置获取独立保护：密钥解密失败（InvalidToken）等配置问题给出可读提示，
        # 而不是漏到 API 层变成难排查的 INTERNAL_ERROR。
        try:
            llm_cfg = await self._config.get_llm_config()
            provider = build_llm_provider(llm_cfg)
        except Exception as exc:
            logger.exception("LLM 配置获取失败", extra={"session_id": str(session_id)})
            err = _error_block(
                "LLM_CONFIG_ERROR",
                "LLM 配置无效（API Key 缺失或密钥解密失败），请到配置页检查后重试",
            )
            text_block["status"] = "failed"
            await self._persist_message(
                session_id, "assistant", [text_block, err],
                metadata={"usage": {}}, message_id=message_id,
            )
            yield _block_end(text_block, "failed")
            yield {"event": "error", "data": {"code": "LLM_CONFIG_ERROR", "message": str(exc)[:300]}}
            return
        schema_text = await self._resolve_schema(user_id, datasource_id)
        history = await self._load_history(session_id)  # 含刚落库的用户消息
        system = SYSTEM_PROMPT
        if schema_text:
            system += f"\n\n## 数据源结构\n{schema_text}"
        if attachments:
            system += await self._attachment_schema(session_id, attachments)
        if datasource_id:
            system += "\n本次请求指定了数据源，run_sql 时省略 datasource_id 即使用该数据源。"
        messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
        # 历史按 8K token 预算裁剪：从最近往前，超预算的早期轮次截断/压缩为摘要（而非直接丢弃）
        budget = max(1, CONTEXT_TOKEN_BUDGET - _estimate_tokens(system))
        used = 0
        cut = 0
        for i, msg in enumerate(history):
            cost = _estimate_tokens(msg["content"])
            if used + cost > budget:
                room = budget - used
                if room >= 64 and len(msg["content"]) > room * 2:
                    messages.append({"role": msg["role"], "content": msg["content"][: room * 2] + "…（上下文已截断）"})
                cut = i + 1
                break
            messages.append(msg)
            used += cost
        else:
            cut = len(history)
        # 更早轮次压缩为摘要（插在主 system 之后、最新历史之前，保留背景要点）
        if cut < len(history):
            summary = _summarize_history(history[cut:])
            if summary:
                messages.insert(1, {"role": "system", "content": summary})

        max_rows = int((await self._config.get("system.query") or {}).get("max_query_rows", 1000))
        tctx = ToolCtx(
            session_id=session_id,
            user_id=user_id,
            datasource_id=datasource_id,
            max_query_rows=max_rows,
        )
        parts: list[str] = []
        side_blocks: list[dict[str, Any]] = []
        stop_reason = "text"
        try:
            for _round in range(MAX_TOOL_ROUNDS):
                tool_call: dict | None = None
                async for chunk in provider.stream_chat_with_tools(messages, TOOL_DEFINITIONS):
                    if isinstance(chunk, dict):
                        tool_call = chunk.get("__tool_call__")
                        continue
                    parts.append(chunk)
                    # 已出现「可点击选项：」标记：其后的选项行不再流式推送
                    # （将渲染为 suggestions block 按钮，避免实时文本与可点击按钮重复；契约 4.4）
                    if _SUGGESTION_HEADER.search("".join(parts)):
                        continue
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
            # 失败路径：text block 置 failed，追加 error block 落库，发 error 事件后结束（无 done）。
            # LLM 适配器层已按 retry_count 自动重试过（PRD：AI 生成失败自动重试 1 次），
            # 仍失败则置 retryable=True 供前端提供手动重试入口。
            logger.exception("LLM 流式调用失败", extra={"session_id": str(session_id)})
            err = _error_block("LLM_ERROR", str(exc)[:500], retryable=True)
            text_block["status"] = "failed"
            text_block["content"]["text"] = "".join(parts)
            await self._persist_message(
                session_id, "assistant", [text_block, err, *side_blocks],
                metadata={"usage": {}}, message_id=message_id,
            )
            yield _block_end(text_block, "failed")
            yield {"event": "error", "data": {"code": "LLM_ERROR", "message": str(exc)[:500], "retryable": True}}
            return

        # 4) 成功路径：text block 终态 + 工具副作用落库 + done
        usage = provider.usage
        usage_dict = {
            "prompt_tokens": usage.prompt_tokens,
            "completion_tokens": usage.completion_tokens,
            "total_tokens": usage.total_tokens,
        }
        raw_text = "".join(parts)
        clean_text, suggestion_items = _extract_suggestions(raw_text)
        text_block["status"] = "completed"
        text_block["content"]["text"] = clean_text
        metadata: dict[str, Any] = {"usage": usage_dict, "stop_reason": stop_reason}
        if tctx.tool_calls:
            metadata["tool_calls"] = tctx.tool_calls
        # 数据来源证据链（契约 2.11 sources）：从工具执行轨迹确定性推导
        datasource_label = await self._resolve_datasource_label(user_id, datasource_id)
        sources_block = _build_sources_block(tctx, datasource_label, side_blocks)
        blocks = [text_block, *side_blocks]
        if sources_block:
            blocks.append(sources_block)
        if suggestion_items:
            blocks.append(_suggestions_block(suggestion_items))
        await self._persist_message(
            session_id, "assistant", blocks,
            metadata=metadata, message_id=message_id,
        )
        yield _block_end(text_block)
        if sources_block:
            yield _block_start(sources_block)
            yield _block_end(sources_block)
        if suggestion_items:
            sug_block = blocks[-1]
            yield _block_start(sug_block)
            yield _block_end(sug_block)
        yield {"event": "done", "data": {
            "message_id": message_id,
            "usage": usage_dict,
            # 服务端最终文本（已剥离澄清/追问选项段），前端据此覆盖实时流式文本，保证实时与落库一致
            "text": clean_text,
        }}