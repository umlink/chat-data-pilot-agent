"""自动化任务服务：参数注入 / cron 计算 / 任务执行（结果快照落库）。

契约见 docs/定时任务与第三方通知方案.md 2.3-2.6。
本期（Automation 骨架）不含通知发送：notification 字段仅存储，执行不触发通知
（通知接入在后续模块）；不含自然语言解析（parse 在后续模块）。
"""
import asyncio
import datetime
import logging
import re
import time
from typing import Any, Callable
from uuid import UUID
from zoneinfo import ZoneInfo

from croniter import croniter
from sqlalchemy import delete, select

from app.agents.chart_builder import build_chart
from app.core.database import SessionFactory
from app.models.automation import Automation, AutomationRun
from app.services.notification_service import NotificationService
from app.services.sql_engine import SqlEngine

logger = logging.getLogger("datapilot.automation")

# 单次执行超时（秒）：SQL 卡死不允许拖垮调度循环（对齐报告 RUN_TIMEOUT_SECONDS）
RUN_TIMEOUT_SECONDS = 60
# 每个任务保留的运行历史条数（超出删除最旧，对齐报告 RUN_HISTORY_KEEP）
RUN_HISTORY_KEEP = 50
# 调度与内置变量统一时区（方案 §5.3）
DEFAULT_TIMEZONE = "Asia/Shanghai"

_engine = SqlEngine()

# ---------- 参数注入（方案 §2.3） ----------

_VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")

BUILTIN_VARS: dict[str, Callable[[datetime.datetime], str]] = {
    "today": lambda d: d.strftime("%Y-%m-%d"),
    "yesterday": lambda d: (d - datetime.timedelta(days=1)).strftime("%Y-%m-%d"),
    "this_month_start": lambda d: d.replace(day=1).strftime("%Y-%m-%d"),
    "this_month_end": lambda d: (
        d.replace(year=d.year + (d.month // 12), month=d.month % 12 + 1, day=1)
        - datetime.timedelta(days=1)
    ).strftime("%Y-%m-%d"),
    "last_month_start": lambda d: (d.replace(day=1) - datetime.timedelta(days=1)).replace(
        day=1
    ).strftime("%Y-%m-%d"),
    "last_month_end": lambda d: (d.replace(day=1) - datetime.timedelta(days=1)).strftime(
        "%Y-%m-%d"
    ),
    "now": lambda d: d.strftime("%Y-%m-%d %H:%M:%S"),
    "date": lambda d: d.strftime("%Y-%m-%d"),  # today 别名
}


def _resolve_sql(sql: str, defaults: dict, run_at: datetime.datetime) -> str:
    """占位符 ${var} 求值替换：先用户变量（variable_defaults），后内置变量兜底。

    求值结果总按字符串替换；是否加引号由 SQL 作者决定（R5，引擎不补引号）。
    缺失变量抛 ValueError（由调用方置 failed + 失败通知）。
    """
    missing: list[str] = []
    resolved: dict[str, str] = {}
    for name in _VAR_RE.findall(sql):
        if name in defaults:
            resolved[name] = str(defaults[name])
        elif name in BUILTIN_VARS:
            resolved[name] = BUILTIN_VARS[name](run_at)
        else:
            missing.append(name)
    if missing:
        raise ValueError(f"变量未定义: {missing}")
    return _VAR_RE.sub(lambda m: resolved[m.group(1)], sql)


def _sanitize_error(exc: BaseException) -> str:
    """错误文本收敛：脱敏（sql_engine 的错误已脱敏）+ 截断（对齐报告语义）。"""
    from app.services.sql_engine import SqlNeedsConfirmation

    if isinstance(exc, SqlNeedsConfirmation):
        return exc.reason
    msg = str(exc).strip() or "未知错误"
    return msg[:500]


# ---------- 调度（方案 §2.4） ----------

def compute_next(cron_expression: str, now: datetime.datetime | None = None) -> datetime.datetime:
    """按 cron 计算下次运行时间（Asia/Shanghai aware datetime）。

    croniter 遵循标准 cron DOW 语义（0/7=周日），本函数只负责按表达式推进；
    「周一→周日」的 DOW 转换发生在表单/解析器生成 cron 时（方案 §2.4），不在此。
    """
    now = now or datetime.datetime.now(ZoneInfo(DEFAULT_TIMEZONE))
    return croniter(cron_expression, now).get_next(datetime.datetime)


def refresh_next_run(automation: Automation) -> None:
    """按 cron 与 enabled 状态重算 next_run_at（就地修改，调用方提交）。

    禁用 → 置 None（对齐报告 refresh_next_run 语义）：避免重新启用时补跑过期时刻。
    """
    if automation.enabled:
        automation.next_run_at = compute_next(automation.cron_expression)
    else:
        automation.next_run_at = None


# cron DOW 语义：0/7=周日 … 6=周六（标准 cron，见方案 §2.4）
_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"]


def describe_cron(cron_expression: str) -> str:
    """把 5 段 cron 描述为中文（覆盖 daily/weekly/monthly 三种计划形态，方案 §2.4）。

    其余形态（每小时/多点等）不翻译，回退原表达式，避免误导。
    """
    parts = cron_expression.split()
    if len(parts) != 5:
        return cron_expression
    minute, hour, dom, month, dow = parts
    if not (minute.isdigit() and hour.isdigit()):
        return cron_expression
    hh, mm = hour.zfill(2), minute.zfill(2)
    if dom == "*" and month == "*" and dow == "*":
        return f"每天 {hh}:{mm}"
    if dom == "*" and month == "*" and dow not in ("*", "?"):
        days = "、".join("周" + _WEEKDAYS[int(t) % 7] for t in dow.split(",") if t.isdigit())
        if days:
            return f"每{days} {hh}:{mm}"
    if dow == "*" and month == "*" and dom.isdigit():
        return f"每月 {int(dom)} 日 {hh}:{mm}"
    return cron_expression


def schedule_to_cron(schedule: dict) -> str:
    """schedule 语义 → cron 表达式（方案 §2.4）：LLM 只输出语义，cron 由后端生成。

    - type: daily | weekly | monthly；time: HH:MM（24 小时制）；
    - dow: python 语义 0=周一…6=周日 → cron DOW (dow+1)%7（cron 0/7=周日，语义相反）；
    - dom: 1-31。非法 schedule 抛 ValueError（api 层转 400）。
    """
    stype = (schedule or {}).get("type")
    time_str = (schedule.get("time") or "").strip()
    m = re.fullmatch(r"([01]?\d|2[0-3]):([0-5]\d)", time_str)
    if not m:
        raise ValueError("无法解析计划时间（需 HH:MM 24 小时制）")
    hour, minute = int(m.group(1)), int(m.group(2))
    if stype == "daily":
        return f"{minute} {hour} * * *"
    if stype == "weekly":
        dow = schedule.get("dow", 0)
        if not isinstance(dow, int) or not 0 <= dow <= 6:
            raise ValueError("无法解析每周的星期几（0=周一…6=周日）")
        return f"{minute} {hour} * * {(dow + 1) % 7}"
    if stype == "monthly":
        dom = schedule.get("dom", 1)
        if not isinstance(dom, int) or not 1 <= dom <= 31:
            raise ValueError("无法解析每月的日期（1-31）")
        return f"{minute} {hour} {dom} * *"
    raise ValueError("无法解析计划类型（仅支持每天/每周/每月）")


# ---------- 执行（方案 §2.6） ----------

def _normalize_measures(measures: list | None) -> list[dict]:
    """measures 兼容两种形状 → build_chart 需要的 dict[]（{column[, agg, name]}）。

    parse/表单产物为 string[]（列名数组），report 风格为 dict[]（{column,agg,name}）；
    统一归一化，避免 'str' object has no attribute 'get'。
    """
    out: list[dict] = []
    for m in measures or []:
        if isinstance(m, str):
            out.append({"column": m})
        elif isinstance(m, dict) and m.get("column"):
            out.append(m)
    return out


async def _build_chart_snapshot(params: dict, table: dict[str, Any]) -> dict[str, Any] | None:
    """按 params.chart_config 生成图表快照（pandas 聚合为 CPU 密集 → to_thread）。"""
    cfg = params.get("chart_config") or {}
    if not cfg.get("chart_type"):
        return None
    return await asyncio.to_thread(
        build_chart,
        table,
        cfg["chart_type"],
        cfg["dimension"],
        _normalize_measures(cfg.get("measures")),
        cfg.get("title"),
    )


def _final_params_snapshot(params: dict, resolved_sql: str | None) -> dict:
    """注入后的最终参数快照（run.params 契约：含解析后的变量值）。"""
    snapshot = dict(params)
    if resolved_sql is not None:
        snapshot["sql_text"] = resolved_sql
    return snapshot


async def _notify_run_result(
    notification: dict | None,
    automation_name: str,
    status: str,
    error: str | None,
    result: dict[str, Any] | None,
    duration_ms: int,
) -> None:
    """按通知绑定发送运行结果通知（成功/失败，方案 §4.1-4.2）。

    通知失败不阻塞主流程：send_automation_alert 内部收敛异常；本函数自身异常由调用方
    兜底忽略（见 run_automation）。
    """
    if not notification:
        return
    key = "on_success" if status == "success" else "on_failure"
    binding = notification.get(key) or {}
    channel_id = binding.get("channel_id")
    if not binding.get("enabled") or not channel_id:
        return
    if status == "success":
        subject = f"定时任务「{automation_name}」执行成功"
        total = None
        if result and isinstance(result.get("table"), dict):
            total = result["table"].get("total")
        body = (
            f"任务：{automation_name}\n"
            f"状态：成功\n"
            f"结果行数：{total if total is not None else '—'}\n"
            f"耗时：{duration_ms} ms"
        )
        kind = "success"
    else:
        subject = f"定时任务「{automation_name}」执行失败"
        body = f"任务：{automation_name}\n状态：失败\n原因：{error or '未知错误'}"
        kind = "failure"
    await NotificationService().send_automation_alert(channel_id, subject, body, kind=kind)


async def run_automation(automation_id: UUID) -> AutomationRun | None:
    """执行一次自动化任务并落库运行历史；返回本次运行记录（任务不存在返回 None）。

    步骤：建 running 运行记录 → 推进 next_run_at（防重）→ 参数注入 → SQL 执行
    （+ 可选图表）→ 写终态 + 更新任务 last 列 → 裁剪历史。任何执行异常记为
    failed，不向上抛（调度循环与手动触发共用）。本期不触发通知。
    """
    async with SessionFactory() as db:
        automation = await db.get(Automation, automation_id)
        if automation is None:
            return None
        run = AutomationRun(automation_id=automation.id, status="running")
        db.add(run)
        automation.last_run_at = datetime.datetime.now(datetime.timezone.utc)
        automation.last_status = "running"
        # 领取即推进 next_run_at：防止执行期间（最长 60s）调度器下一 tick 重复触发
        refresh_next_run(automation)
        await db.commit()
        await db.refresh(run)
        run_id = run.id

    started = time.perf_counter()
    result: dict[str, Any] | None = None
    error: str | None = None
    async with SessionFactory() as db:
        automation = await db.get(Automation, automation_id)
        if automation is None:  # 执行期间任务被删除：运行记录直接置失败
            run = await db.get(AutomationRun, run_id)
            run.status = "failed"
            run.error = "任务已删除"
            run.finished_at = datetime.datetime.now(datetime.timezone.utc)
            await db.commit()
            return run
        params = automation.params or {}
        sql_text = (params.get("sql_text") or "").strip()
        run_at = datetime.datetime.now(ZoneInfo(DEFAULT_TIMEZONE))
        resolved_sql: str | None = None
        try:
            resolved_sql = _resolve_sql(sql_text, params.get("variable_defaults") or {}, run_at)
        except ValueError as exc:
            error = f"参数注入失败：{_sanitize_error(exc)}"

        if error is None:
            try:
                table = await asyncio.wait_for(
                    _engine.execute(
                        user_id=automation.user_id,
                        session_id=str(automation.id),  # att_ 表路由用
                        sql=resolved_sql,
                        datasource_id=params.get("datasource_id") or None,
                    ),
                    timeout=RUN_TIMEOUT_SECONDS,
                )
                # _meta 为 chat 链路执行元数据，快照不需要（保持 TableContent 契约干净）
                table.pop("_meta", None)
                result = {"table": table}
                chart = await _build_chart_snapshot(params, table)
                if chart is not None:
                    result["chart"] = chart
            except asyncio.TimeoutError:
                error = f"任务执行超时（>{RUN_TIMEOUT_SECONDS}s），请优化 SQL 或收窄时间范围"
            except Exception as exc:  # SqlEngine/图表聚合等业务异常 → failed（含可读原因）
                logger.warning("自动化任务执行失败 %s: %s", automation_id, _sanitize_error(exc))
                error = _sanitize_error(exc)

        duration_ms = int((time.perf_counter() - started) * 1000)
        status = "success" if error is None else "failed"
        run = await db.get(AutomationRun, run_id)
        run.status = status
        run.finished_at = datetime.datetime.now(datetime.timezone.utc)
        run.duration_ms = duration_ms
        run.error = error
        run.result = result
        run.params = _final_params_snapshot(params, resolved_sql)
        automation.last_status = status
        await db.commit()

        # 裁剪历史：保留最近 RUN_HISTORY_KEEP 条
        old_ids = (
            await db.scalars(
                select(AutomationRun.id)
                .where(AutomationRun.automation_id == automation_id)
                .order_by(AutomationRun.started_at.desc())
                .offset(RUN_HISTORY_KEEP)
            )
        ).all()
        if old_ids:
            await db.execute(delete(AutomationRun).where(AutomationRun.id.in_(old_ids)))
            await db.commit()
        # 捕获通知所需快照：退出 DB 会话后再分发，避免网络 I/O（最长 8s）占用/嵌套会话
        notify_args = (
            automation.notification,
            automation.name,
            status,
            error,
            result,
            duration_ms,
        )

    # 通知接入（方案 §4.1-4.2）：成功/失败自动通知；分发异常不影响运行记录
    try:
        await _notify_run_result(*notify_args)
    except Exception as exc:
        logger.warning("自动化通知分发失败 %s: %s", automation_id, _sanitize_error(exc))
    return run


# ---------- 自然语言解析（方案 §2.8） ----------

# LLM 单工具定义：强制 structured 输出（不支持工具调用时降级严格 JSON）
_PARSE_TOOL: dict = {
    "type": "function",
    "function": {
        "name": "parse_automation",
        "description": "把用户的自然语言定时任务描述解析为结构化参数（不猜数据源与渠道 id）。",
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "任务名称（简洁，≤20 字）"},
                "description": {"type": "string", "description": "保留用户原句或精简摘要"},
                "params": {
                    "type": "object",
                    "description": "基于给定数据源表结构构造的单条只读 SELECT",
                    "properties": {
                        "sql_text": {"type": "string"},
                        "chart_config": {
                            "type": "object",
                            "description": "可选图表配置",
                            "properties": {
                                "chart_type": {
                                    "type": "string",
                                    "enum": ["line", "bar", "pie", "scatter", "heatmap"],
                                },
                                "dimension": {"type": "string"},
                                "measures": {"type": "array", "items": {"type": "string"}},
                                "title": {"type": "string"},
                            },
                        },
                        "variable_defaults": {
                            "type": "object",
                            "description": "用户自定义占位符默认值（不含内置变量）",
                        },
                    },
                    "required": ["sql_text"],
                },
                "schedule": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": ["daily", "weekly", "monthly"]},
                        "time": {"type": "string", "description": "HH:MM 24 小时制，如 09:00"},
                        "dow": {
                            "type": "integer", "minimum": 0, "maximum": 6,
                            "description": "仅 weekly：0=周一 … 6=周日",
                        },
                        "dom": {
                            "type": "integer", "minimum": 1, "maximum": 31,
                            "description": "仅 monthly：每月几号",
                        },
                    },
                    "required": ["type", "time"],
                },
                "notification": {
                    "type": "object",
                    "description": "成功/失败是否通知（仅输出 enabled 意图，渠道由用户确认时选择）",
                    "properties": {
                        "on_success": {"type": "object", "properties": {"enabled": {"type": "boolean"}}},
                        "on_failure": {"type": "object", "properties": {"enabled": {"type": "boolean"}}},
                    },
                },
            },
            "required": ["name", "params", "schedule"],
        },
    },
}

_PARSE_SYSTEM_PROMPT = """你是定时任务配置解析助手，把用户的自然语言描述解析为结构化定时任务参数。
约束：
- 只输出结构化结果（调用 parse_automation 工具或返回严格 JSON），不输出多余文字；
- params.sql_text 必须为基于给定数据源表结构构造的单条只读 SELECT；
- 动态日期用内置占位符：${today} ${yesterday} ${this_month_start} ${this_month_end} ${last_month_start} ${last_month_end} ${now}，禁止硬编码具体日期；
- schedule 只输出语义结构（type/time/dow/dom），不要输出 cron 表达式；
- 不猜测数据源 id 与通知渠道 id（由用户确认时选择）；
- 通知只输出是否启用（enabled），不填 channel_id。"""


async def _build_schema_hint(user_id: UUID, datasource_id: str) -> str:
    """取所选数据源的表结构文本（供 LLM 生成 SQL，方案 §2.8）。

    格式复用 chat 链路 schema 注入（表名/列名/类型/注释）；异常时返回空串，
    由 prompt 兜底「基于常识构造」，不阻断 parse。
    """
    from app.models.datasource import Datasource
    from app.services.data_service import DataService

    ds: Datasource | None = None
    try:
        async with SessionFactory() as db:
            ds = await db.get(Datasource, UUID(datasource_id))
            if ds is None or ds.user_id != user_id or ds.type not in ("postgresql", "mysql"):
                return ""
            schema = await DataService().get_schema(ds)
    except Exception as exc:
        logger.warning("parse schema 获取失败（跳过）: %s", _sanitize_error(exc))
        return ""
    lines = [f"数据源 {ds.name}（{ds.type}）表结构："]
    for table in schema.get("tables", [])[:20]:
        cols = ", ".join(
            f"{c['name']}({c['data_type']})" for c in table.get("columns", [])[:30]
        )
        comment = f" // {table['comment']}" if table.get("comment") else ""
        lines.append(f"- {table['schema']}.{table['name']}: {cols}{comment}")
    return "\n".join(lines)


def _parse_notification_intent(notification: dict) -> dict | None:
    """LLM 只输出通知意图（enabled），channel_id 由用户确认时选择（方案 §2.8）。"""
    on_success = notification.get("on_success") or {}
    on_failure = notification.get("on_failure") or {}
    success_enabled = bool(on_success.get("enabled"))
    failure_enabled = bool(on_failure.get("enabled"))
    if not success_enabled and not failure_enabled:
        return None
    return {
        "on_success": {"enabled": success_enabled, "channel_id": None},
        "on_failure": {"enabled": failure_enabled, "channel_id": None},
    }


def _validate_parse_result(
    raw: dict, datasource_id: str, description: str
) -> dict:
    """校验 LLM 产物并组装 AutomationDraft（方案 §2.8：cron 后端生成、数据源锁定）。

    校验失败抛 ValueError（api 层转 400）。
    """
    from app.services.sql_engine import _sql_kind

    name = str(raw.get("name") or "").strip()
    if not name:
        raise ValueError("无法解析任务名称，请调整措辞或改用表单创建")
    params = raw.get("params") or {}
    sql_text = str(params.get("sql_text") or "").strip()
    if not sql_text:
        raise ValueError("解析结果缺少 SQL，请调整措辞或改用表单创建")
    kind, _risk = _sql_kind(sql_text)
    if kind != "select":
        raise ValueError("定时任务仅支持只读 SELECT 查询，请调整描述")
    params = dict(params)
    params["sql_text"] = sql_text
    params["datasource_id"] = str(datasource_id)  # 数据源锁定：LLM 不猜，后端填入
    if not isinstance(params.get("variable_defaults"), dict):
        params["variable_defaults"] = {}
    if not isinstance(params.get("chart_config"), dict):
        params.pop("chart_config", None)
    cron_expression = schedule_to_cron(raw.get("schedule") or {})
    notification = _parse_notification_intent(raw.get("notification") or {})
    readable = describe_cron(cron_expression)
    if readable == cron_expression:
        readable = name
    else:
        readable = f"{readable} · {name}"
    return {
        "name": name,
        "description": (str(raw.get("description") or "").strip() or None),
        "params": params,
        "cron_expression": cron_expression,
        "timezone": DEFAULT_TIMEZONE,
        "notification": notification,
        "readable": readable,
    }


async def parse_automation(description: str, datasource_id: str, user_id: UUID) -> dict:
    """自然语言解析为待确认草稿（方案 §2.8）；只读不落库。

    优先工具调用（强制 structured），不支持则降级严格 JSON + 截断修复；
    失败抛 ValueError（api 层转 400 可读提示，含 LLM 不可用与解析失败）。
    """
    from app.llm.base import build_llm_provider
    from app.services.config_service import ConfigService
    from app.services.context_service import _parse_summary_json

    schema_hint = await _build_schema_hint(user_id, datasource_id)
    messages = [
        {"role": "system", "content": _PARSE_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"数据源表结构：\n{schema_hint or '（无可用 schema，基于常识构造并注释列名）'}\n\n"
                f"用户描述：{description}"
            ),
        },
    ]
    config = await ConfigService().get_llm_config()
    provider = build_llm_provider(config)
    result = None
    try:
        # 不强制 tool_choice：部分模型（如 deepseek thinking 模式）不支持强制工具选择，
        # 让模型自行决定调用 parse_automation 工具；无工具结果则走文本/chat 降级。
        result = await provider.chat_with_tools(
            messages, [_PARSE_TOOL], temperature=0, max_tokens=1200
        )
    except Exception as exc:
        # 端点不支持工具调用 → 降级严格 JSON；网络/认证错误由下方 chat 再次抛出
        logger.warning("定时任务工具解析失败，降级严格 JSON：%s", _sanitize_error(exc))
    raw: dict | None = None
    if result is not None and getattr(result, "tool_calls", None):
        raw = result.tool_calls[0].arguments
    if raw is None:
        text = (result.text if result is not None else "") or ""
        if not text:
            try:
                text = await provider.chat(messages, temperature=0, max_tokens=1200)
            except Exception as exc:
                logger.warning("定时任务智能解析 LLM 不可用：%s", _sanitize_error(exc))
                raise ValueError("智能解析不可用，请检查 LLM 配置或改用表单创建")
        raw = _parse_summary_json(text)
    if not isinstance(raw, dict) or not raw:
        raise ValueError("无法解析该描述，请调整措辞或改用表单创建")
    return _validate_parse_result(raw, datasource_id, description)
