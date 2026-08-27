"""后台调度器：数据源心跳检测 + 定时报告轮询（随应用 lifespan 启停）。

- 心跳（PRD 3.2.3）：每 DATASOURCE_CHECK_INTERVAL 秒对全部数据库型数据源做一次
  连接检测并写回 status/last_checked_at/last_error/server_version；文件型跳过。
- 报告：每 tick 轮询 enabled 且 next_run_at<=now 的报告，逐个异步执行
  （执行逻辑与失败收敛在 report_service.run_report，这里只做调度与容错）。
- 容错：任何一步异常只记日志，绝不杀死循环（对齐 Worker 的消费循环策略）。
"""
import asyncio
import datetime
import logging
import time

from sqlalchemy import select

from app.core.database import SessionFactory
from app.models.analytics import ScheduledReport
from app.models.datasource import Datasource
from app.schemas.datasource import FILE_TYPES
from app.services.data_service import DataService, decrypt_config
from app.services.report_service import run_report

logger = logging.getLogger("datapilot.scheduler")

# 轮询周期（秒）：报告到期检查粒度
TICK_SECONDS = 30.0
# 数据源心跳间隔（秒）
DATASOURCE_CHECK_INTERVAL = 300.0

_data_service = DataService()


class Scheduler:
    def __init__(
        self,
        tick_seconds: float = TICK_SECONDS,
        datasource_check_seconds: float = DATASOURCE_CHECK_INTERVAL,
    ):
        self.tick_seconds = tick_seconds
        self.datasource_check_seconds = datasource_check_seconds
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        self._stop.clear()
        self._task = asyncio.create_task(self._loop(), name="scheduler")
        logger.info(
            "调度器已启动：报告轮询 %ss / 数据源心跳 %ss", self.tick_seconds, self.datasource_check_seconds
        )

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
        logger.info("调度器已停止")

    async def _loop(self) -> None:
        next_ds_check = 0.0  # monotonic 起点 0：首轮立即心跳一次
        while not self._stop.is_set():
            try:
                now = time.monotonic()
                if now >= next_ds_check:
                    await self._check_datasources()
                    next_ds_check = now + self.datasource_check_seconds
                await self._run_due_reports()
            except asyncio.CancelledError:
                raise
            except Exception:
                # DB 瞬断等异常不允许杀死调度循环
                logger.exception("调度循环异常（已忽略，下一 tick 重试）")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.tick_seconds)
            except asyncio.TimeoutError:
                pass

    # ---------- 数据源心跳 ----------

    async def _check_datasources(self) -> None:
        """对全部数据库型数据源做一次连接检测并写回状态列。"""
        try:
            async with SessionFactory() as db:
                result = await db.execute(select(Datasource))
                items = [
                    (ds.id, ds.type, dict(ds.config or {}))
                    for ds in result.scalars().all()
                    if ds.type not in FILE_TYPES
                ]
        except Exception:
            logger.exception("心跳：读取数据源列表失败")
            return

        if not items:
            return

        async def _one(ds_id, ds_type: str, config: dict) -> tuple:
            try:
                result = await _data_service.test_connection(ds_type, decrypt_config(config))
            except Exception as exc:  # decrypt_config 失败（旧密文）也要落 error 状态
                # InvalidToken 等 str() 为空：兜底用异常类名，保证 last_error 不落空
                detail = str(exc).strip() or type(exc).__name__
                result = {"ok": False, "error": f"凭据解密失败：{detail}"}
            return ds_id, result

        outcomes = await asyncio.gather(*(_one(*it) for it in items))
        try:
            async with SessionFactory() as db:
                for ds_id, result in outcomes:
                    ds = await db.get(Datasource, ds_id)
                    if ds is None:
                        continue
                    ds.status = "ok" if result.get("ok") else "error"
                    ds.last_checked_at = datetime.datetime.now(datetime.timezone.utc)
                    ds.last_error = (result.get("error") or None) if not result.get("ok") else None
                    ds.server_version = result.get("server_version") or ds.server_version
                await db.commit()
        except Exception:
            logger.exception("心跳：写回数据源状态失败")

    # ---------- 定时报告 ----------

    async def _run_due_reports(self) -> None:
        """执行所有到期的报告（并发触发；执行体自身保证状态收敛与异常兜底）。"""
        now = datetime.datetime.now(datetime.timezone.utc)
        try:
            async with SessionFactory() as db:
                due = (
                    await db.scalars(
                        select(ScheduledReport.id).where(
                            ScheduledReport.enabled.is_(True),
                            ScheduledReport.next_run_at.is_not(None),
                            ScheduledReport.next_run_at <= now,
                        )
                    )
                ).all()
        except Exception:
            logger.exception("报告轮询：读取到期报告失败")
            return
        for report_id in due:
            logger.info("定时报告到期执行：%s", report_id)
            # 每个报告独立任务：单个报告卡死/失败不影响其他报告与本轮调度
            asyncio.create_task(self._run_report_safely(report_id))

    @staticmethod
    async def _run_report_safely(report_id) -> None:
        try:
            await run_report(report_id)
        except Exception:
            # run_report 内部已收敛业务异常；这里兜底防御记录类异常
            logger.exception("定时报告执行意外失败 report=%s", report_id)
