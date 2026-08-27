"""定时报告服务：计划校验 / next_run 计算 / 报告执行（结果快照落库）。

执行链路复用 SqlEngine（仅 SELECT，行数上限同系统配置）与 chart_builder
（chart_config 存在时生成图表快照），结果写入 report_runs（每报告保留最近 50 条）。
契约见 docs/技术方案设计.md 2.3「定时报告」调度语义。
"""
import asyncio
import datetime
import logging
import time
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select

from app.agents.chart_builder import build_chart
from app.core.database import SessionFactory
from app.models.analytics import ReportRun, ScheduledReport
from app.schemas.report import _validate_schedule_fields
from app.services.sql_engine import SqlEngine

logger = logging.getLogger("datapilot.report")

# 单次报告执行超时（秒）：SQL 卡死不允许拖垮调度循环
RUN_TIMEOUT_SECONDS = 60
# 每报告保留的运行历史条数（超出删除最旧）
RUN_HISTORY_KEEP = 50
# 每个周期之间的调度循环由 scheduler 控制，这里只做执行
_engine = SqlEngine()


# ---------- 计划计算 ----------

def validate_schedule(
    schedule_type: str,
    schedule_time: str,
    day_of_week: int | None,
    day_of_month: int | None,
) -> None:
    """计划字段一致性校验（合并终值后调用），失败抛 ValueError（api 层转 400）。"""
    _validate_schedule_fields(schedule_type, schedule_time, day_of_week, day_of_month)


def compute_next_run(
    schedule_type: str,
    schedule_time: str,
    day_of_week: int | None,
    day_of_month: int | None,
    now: datetime.datetime | None = None,
) -> datetime.datetime:
    """计算下一次运行时间（服务器本地时区；schedule_time 按 HH:MM 解释）。

    语义：daily=每天；weekly=每周 day_of_week（0=周一…6=周日）；monthly=每月
    day_of_month（超过当月天数时取当月最后一天）。已过当日时刻则顺延下一周期。
    """
    validate_schedule(schedule_type, schedule_time, day_of_week, day_of_month)
    now = now or datetime.datetime.now().astimezone()
    hh, mm = (int(x) for x in schedule_time.split(":"))

    def at(base: datetime.datetime) -> datetime.datetime:
        return base.replace(hour=hh, minute=mm, second=0, microsecond=0)

    if schedule_type == "daily":
        candidate = at(now)
        if candidate <= now:
            candidate = at(now + datetime.timedelta(days=1))
        return candidate

    if schedule_type == "weekly":
        # python weekday() 与约定一致：0=周一 … 6=周日
        days_ahead = (day_of_week - now.weekday()) % 7
        candidate = at(now + datetime.timedelta(days=days_ahead))
        if candidate <= now:
            candidate = at(now + datetime.timedelta(days=days_ahead + 7))
        return candidate

    # monthly：本月目标日 → 已过则下月同日；day 超过目标月天数取该月最后一天
    target_day = day_of_month

    def month_last_day(y: int, m: int) -> int:
        if m == 12:
            return 31
        return (datetime.date(y + (m // 12), (m % 12) + 1, 1) - datetime.timedelta(days=1)).day

    y, m = now.year, now.month
    day = min(target_day, month_last_day(y, m))
    candidate = at(now.replace(day=day))
    if candidate <= now:
        ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
        day = min(target_day, month_last_day(ny, nm))
        candidate = at(now.replace(year=ny, month=nm, day=day))
    return candidate


def refresh_next_run(report: ScheduledReport) -> None:
    """按当前计划与 enabled 状态重算 next_run_at（就地修改，由调用方提交）。"""
    if report.enabled:
        report.next_run_at = compute_next_run(
            report.schedule_type,
            report.schedule_time,
            report.day_of_week,
            report.day_of_month,
        )
    else:
        report.next_run_at = None


# ---------- 报告执行 ----------

def _sanitize_error(exc: BaseException) -> str:
    """错误文本收敛：脱敏（sql_engine 的错误已脱敏）+ 截断。"""
    from app.services.sql_engine import SqlNeedsConfirmation

    if isinstance(exc, SqlNeedsConfirmation):
        return exc.reason
    msg = str(exc).strip() or "未知错误"
    return msg[:500]


async def _execute_report_sql(report: ScheduledReport) -> dict[str, Any]:
    """执行报告 SQL（仅 SELECT；写操作被 SqlEngine 拦截抛 SqlNeedsConfirmation）。"""
    table = await asyncio.wait_for(
        _engine.execute(
            user_id=report.user_id,
            session_id=str(report.id),  # att_ 表路由用：报告 SQL 引用附件表会得到可读错误
            sql=report.sql_text,
            datasource_id=str(report.datasource_id) if report.datasource_id else None,
        ),
        timeout=RUN_TIMEOUT_SECONDS,
    )
    # _meta 为 chat 链路的执行元数据，报告快照不需要（保持 TableContent 契约干净）
    table.pop("_meta", None)
    return table


async def _build_chart_snapshot(
    report: ScheduledReport, table: dict[str, Any]
) -> dict[str, Any] | None:
    """按 chart_config 生成图表快照（pandas 聚合为 CPU 密集 → to_thread）。"""
    cfg = report.chart_config or {}
    if not cfg.get("chart_type"):
        return None
    return await asyncio.to_thread(
        build_chart,
        table,
        cfg["chart_type"],
        cfg["dimension"],
        cfg.get("measures") or [],
        cfg.get("title"),
    )


async def run_report(report_id: UUID) -> ReportRun | None:
    """执行一次报告并落库运行历史；返回本次运行记录（报告不存在返回 None）。

    步骤：建 running 运行记录 → 执行 SQL（+ 可选图表）→ 写终态 + 更新报告
    last_run_at/last_status/next_run_at → 裁剪历史。任何执行异常记为 failed，
    不向上抛（调度循环与手动触发共用）。
    """
    async with SessionFactory() as db:
        report = await db.get(ScheduledReport, report_id)
        if report is None:
            return None
        run = ReportRun(report_id=report.id, status="running")
        db.add(run)
        report.last_run_at = datetime.datetime.now(datetime.timezone.utc)
        report.last_status = "running"
        # 领取即推进 next_run_at：防止执行期间（最长 60s）调度器下一 tick 重复触发
        refresh_next_run(report)
        await db.commit()
        await db.refresh(run)
        run_id = run.id

    started = time.perf_counter()
    result: dict[str, Any] | None = None
    error: str | None = None
    async with SessionFactory() as db:
        report = await db.get(ScheduledReport, report_id)
        if report is None:  # 执行期间报告被删除：运行记录直接置失败
            run = await db.get(ReportRun, run_id)
            run.status = "failed"
            run.error = "报告已删除"
            run.finished_at = datetime.datetime.now(datetime.timezone.utc)
            await db.commit()
            return run
        try:
            table = await _execute_report_sql(report)
            result = {"table": table}
            chart = await _build_chart_snapshot(report, table)
            if chart is not None:
                result["chart"] = chart
        except asyncio.TimeoutError:
            error = f"报告执行超时（>{RUN_TIMEOUT_SECONDS}s），请优化 SQL 或收窄时间范围"
        except Exception as exc:  # SqlEngine/图表聚合等业务异常 → failed（含可读原因）
            logger.warning(
                "定时报告执行失败 report=%s: %s", report_id, _sanitize_error(exc)
            )
            error = _sanitize_error(exc)

        duration_ms = int((time.perf_counter() - started) * 1000)
        status = "success" if error is None else "failed"
        run = await db.get(ReportRun, run_id)
        run.status = status
        run.finished_at = datetime.datetime.now(datetime.timezone.utc)
        run.duration_ms = duration_ms
        run.error = error
        run.result = result
        report.last_status = status
        await db.commit()

        # 裁剪历史：保留最近 RUN_HISTORY_KEEP 条
        old_ids = (
            await db.scalars(
                select(ReportRun.id)
                .where(ReportRun.report_id == report_id)
                .order_by(ReportRun.started_at.desc())
                .offset(RUN_HISTORY_KEEP)
            )
        ).all()
        if old_ids:
            await db.execute(delete(ReportRun).where(ReportRun.id.in_(old_ids)))
            await db.commit()
        return run
