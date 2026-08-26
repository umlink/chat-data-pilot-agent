"""Agent 工具集：OpenAI 格式工具定义 + 执行分发。

契约见 docs/Block与协议规范.md 4.2：
- run_sql / run_python / create_chart / request_confirmation；
- 工具调用与结果只记录在 assistant 消息 metadata.tool_calls（不生成用户可见 block）；
  用户可见内容 = LLM 自然语言（text block）+ 工具副作用（table/chart/confirmation block）；
- request_confirmation 调用后本轮终止（等待用户决策，由 POST /api/chat/execute 驱动后续）。
"""
import asyncio
import json
import logging
import uuid
from typing import Any

from app.agents.chart_builder import ChartError, build_chart
from app.agents.sandbox import run_sandbox
from app.services.sql_engine import SqlEngine, SqlNeedsConfirmation, SqlRoutingError

logger = logging.getLogger("datapilot.agents")

TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "run_sql",
            "description": (
                "执行 SQL 查询。SELECT 语句直接执行；写操作会被安全策略拦截并转为确认流程。"
                "att_ 开头的表属于附件数据，跨源 JOIN 请改用 run_python。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {"type": "string", "description": "完整 SQL 语句"},
                    "datasource_id": {"type": "string", "description": "数据源 ID，省略时用默认主数据源"},
                    "purpose": {"type": "string", "description": "一句话说明（用于审计）"},
                },
                "required": ["sql"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_python",
            "description": (
                "在受限沙箱中执行 Python 分析代码（pandas/numpy）。"
                "输入为已存在的 table block，注入为 DataFrame 变量 df1/df2…；"
                "调用 return_table(df) 可把结果生成新 table block。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "Python 代码"},
                    "input_block_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "引用的 table block id 列表",
                    },
                },
                "required": ["code", "input_block_ids"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_chart",
            "description": (
                "基于已有查询结果生成图表。服务端负责聚合与组装，只指定图表语义。"
                "pie 至多 1 个 measure；heatmap 用 dimension/measures 映射矩阵。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "source_block_id": {"type": "string", "description": "数据来源 table block id"},
                    "chart_type": {
                        "type": "string", "enum": ["line", "bar", "pie", "scatter", "heatmap"],
                    },
                    "dimension": {"type": "string", "description": "x 轴列名（分类/时间）"},
                    "measures": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "column": {"type": "string"},
                                "agg": {"type": "string", "enum": ["sum", "avg", "count", "max", "min"]},
                                "name": {"type": "string", "description": "系列名"},
                            },
                            "required": ["column"],
                        },
                    },
                    "title": {"type": "string"},
                },
                "required": ["source_block_id", "chart_type", "dimension", "measures"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "request_confirmation",
            "description": (
                "危险操作前请求用户确认。调用后本轮对话终止，等待用户在确认卡片上决策。"
                "仅当需要执行写 SQL 等危险操作时使用。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "operation": {
                        "type": "string",
                        "enum": ["execute_sql", "execute_python", "delete_attachment", "truncate_table"],
                    },
                    "title": {"type": "string"},
                    "description": {"type": "string", "description": "必须包含影响范围估算"},
                    "sql": {"type": "string"},
                    "risk_level": {"type": "string", "enum": ["high", "medium"]},
                },
                "required": ["operation", "title", "description", "risk_level"],
            },
        },
    },
]

TOOL_NAMES = {t["function"]["name"] for t in TOOL_DEFINITIONS}


class ToolCtx:
    """一次对话回合的工具上下文：路由信息 + 本回合的 table block 注册表与副作用块。"""

    def __init__(
        self,
        *,
        session_id,
        user_id,
        datasource_id: str | None = None,
        max_query_rows: int = 1000,
    ):
        self.session_id = session_id
        self.user_id = user_id
        self.datasource_id = datasource_id
        self.max_query_rows = max_query_rows
        # block_id -> TableContent（本回合内工具之间共享）
        self.tables: dict[str, dict[str, Any]] = {}
        # 本回合工具产生的副作用 block（table/chart/confirmation），随消息落库
        self.blocks: list[dict[str, Any]] = []
        # 工具调用审计记录（写入消息 metadata.tool_calls）
        self.tool_calls: list[dict[str, Any]] = []
        # 本回合生成的确认卡片 block id（request_confirmation 设置，循环据此终止）
        self.confirmation_block_id: str | None = None

    def register_table(self, block_id: str, table: dict[str, Any]) -> None:
        """注册 table block；丢弃 _meta 等内部字段，保留契约字段。"""
        table.pop("_meta", None)
        self.tables[block_id] = table
        self.blocks.append({
            "id": block_id,
            "type": "table",
            "status": "completed",
            "content": table,
            "created_at": _now_iso(),
        })


def _now_iso() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _new_block(block_type: str, content: dict[str, Any], status: str = "completed") -> dict:
    return {
        "id": str(uuid.uuid4()),
        "type": block_type,
        "status": status,
        "content": content,
        "created_at": _now_iso(),
    }


def _summarize_table(table: dict[str, Any], block_id: str) -> str:
    cols = ", ".join(c["key"] for c in table.get("columns", []))
    rows = table.get("rows", [])
    return (
        f"已执行完成（block_id={block_id}，{len(rows)} 行，total={table.get('total', len(rows))}"
        f"{'，已截断' if table.get('truncated') else ''}）。列: {cols}。"
        f"数据已存于 table block {block_id}，后续可用 create_chart 以 source_block_id={block_id} 引用。"
    )


class ToolEngine:
    """工具执行分发。会话级：new 一个实例或复用均可（无跨请求状态）。"""

    def __init__(self, sql_engine: SqlEngine | None = None):
        self._sql = sql_engine or SqlEngine()

    # ---------- 分发 ----------
    async def execute(self, name: str, arguments: dict[str, Any], ctx: ToolCtx) -> dict:
        """执行工具。返回 {"text": str, "stop": bool}；stop=True 表示本轮对话需终止。

        工具异常不会向上抛：转成 text 反馈给 LLM，由 LLM 决定下一步（继续澄清或总结）。
        """
        try:
            if name == "run_sql":
                return await self._run_sql(arguments, ctx)
            if name == "run_python":
                return await self._run_python(arguments, ctx)
            if name == "create_chart":
                return await self._create_chart(arguments, ctx)
            if name == "request_confirmation":
                return await self._request_confirmation(arguments, ctx)
            return {"text": f"未知工具: {name}", "stop": False}
        except SqlNeedsConfirmation as exc:
            return await self._request_confirmation(exc.summary(), ctx)
        except SqlRoutingError as exc:
            return {"text": f"run_sql 执行失败：{exc}", "stop": False}
        except ChartError as exc:
            return {"text": f"create_chart 参数不合法：{exc}", "stop": False}
        except Exception as exc:  # 工具兜底：反馈给 LLM 而非中断流
            logger.exception("工具执行异常", extra={"tool": name})
            return {"text": f"工具执行出错：{exc}", "stop": False}

    # ---------- run_sql ----------
    async def _run_sql(
        self, args: dict[str, Any], ctx: ToolCtx
    ) -> dict:
        sql = str(args.get("sql") or "").strip()
        table = await self._sql.execute(
            user_id=ctx.user_id,
            session_id=ctx.session_id,
            sql=sql,
            datasource_id=args.get("datasource_id") or ctx.datasource_id,
            max_rows=ctx.max_query_rows,
        )
        block_id = str(uuid.uuid4())
        ctx.register_table(block_id, table)
        self._record(ctx, "run_sql", args, "ok")
        # 结果全文回填给 LLM（契约：rows 最多 MAX_QUERY_ROWS 行）
        rows_text = json.dumps(table["rows"], ensure_ascii=False)
        return {
            "text": (
                _summarize_table(table, block_id)
                + f"\n数据（最多 {ctx.max_query_rows} 行）:\n{rows_text}"
            ),
            "stop": False,
        }

    # ---------- run_python ----------
    async def _run_python(self, args: dict[str, Any], ctx: ToolCtx) -> dict:
        code = str(args.get("code") or "").strip()
        input_ids = args.get("input_block_ids") or []
        inserts: list[dict[str, Any]] = []
        missing = [i for i in input_ids if i not in ctx.tables]
        if missing:
            return {"text": f"引用的 table block 不存在（需要先用 run_sql 生成）: {missing}", "stop": False}
        for i, block_id in enumerate(input_ids, start=1):
            t = ctx.tables[block_id]
            inserts.append({
                "name": f"df{i}",
                "block_id": block_id,
                "columns": [c["key"] for c in t.get("columns", [])],
                "rows": t.get("rows", []),
            })
        out = await run_sandbox(code, inserts)
        parts = [f"run_python 完成（{out.get('duration_ms', 0)}ms）"]
        if out.get("text"):
            parts.append(f"print 输出:\n{out['text']}")
        if out.get("error"):
            parts.append(f"执行失败: {out['error']}")
            self._record(ctx, "run_python", args, "error", out["error"])
            return {"text": "\n".join(parts), "stop": False}
        if out.get("result_table_id"):
            block_id = out["result_table_id"]
            t = out.get("result_blocks", {}).get(block_id)
            if t:
                t.setdefault("total", len(t.get("rows", [])))
                t.setdefault("truncated", False)
                t.setdefault("query", None)
                ctx.register_table(block_id, t)
                parts.append(_summarize_table(t, block_id))
        self._record(ctx, "run_python", args, "ok")
        return {"text": "\n".join(parts), "stop": False}

    # ---------- create_chart ----------
    async def _create_chart(self, args: dict[str, Any], ctx: ToolCtx) -> dict:
        source_id = args.get("source_block_id")
        table = ctx.tables.get(source_id)
        if table is None:
            return {"text": f"source_block_id 引用的 table block 不存在: {source_id}", "stop": False}
        chart = await asyncio.to_thread(
            build_chart,
            table,
            args["chart_type"],
            args["dimension"],
            args.get("measures") or [],
            args.get("title"),
        )
        chart["source_block_id"] = source_id
        chart["query"] = table.get("query")
        block = _new_block("chart", chart)
        ctx.blocks.append(block)
        self._record(ctx, "create_chart", args, "ok")
        return {
            "text": (
                f"图表已生成（block_id={block['id']}，chart_type={args['chart_type']}）。"
                f"数据维度 {args['dimension']}，measure {[m.get('column') for m in (args.get('measures') or [])]}"
            ),
            "stop": False,
        }

    # ---------- request_confirmation ----------
    async def _request_confirmation(self, args: dict[str, Any], ctx: ToolCtx) -> dict:
        operation = args.get("operation") or "execute_sql"
        # 记录本次确认针对的数据源：工具显式指定优先，否则用会话所选（execute 时按此路由）
        datasource_id = args.get("datasource_id") or ctx.datasource_id
        content = {
            "operation": operation,
            "title": args.get("title") or "请确认操作",
            "description": args.get("description") or "该操作有副作用，需要你确认",
            "sql": args.get("sql"),
            "risk_level": args.get("risk_level") or "medium",
            "datasource_id": datasource_id,
            "confirmed": None,
            "result_block_id": None,
        }
        block = {
            "id": str(uuid.uuid4()),
            "type": "confirmation",
            "status": "pending",
            "content": content,
            "actions": [
                {"action": "confirm", "label": "确认执行", "payload": {"decision": "confirm"}},
                {"action": "cancel", "label": "取消", "payload": {"decision": "cancel"}},
            ],
            "created_at": _now_iso(),
        }
        ctx.blocks.append(block)
        ctx.confirmation_block_id = block["id"]
        self._record(ctx, "request_confirmation", args, "pending")
        return {
            "text": (
                f"已向用户请求确认（operation={operation}，risk={content['risk_level']}）。"
                "本轮对话到此暂停，等待用户在确认卡片上决策。"
            ),
            "stop": True,
        }

    # ---------- 审计 ----------
    def _record(self, ctx: ToolCtx, name: str, args: dict, status: str, note: str = "") -> None:
        record = {
            "name": name,
            "arguments": args,
            "status": status,
            "ts": _now_iso(),
        }
        if note:
            record["note"] = note[:300]
        ctx.tool_calls.append(record)