"""日志管理：structlog 结构化输出 + 异步写入 PostgreSQL。

- 写入：LogService.write_log（SessionFactory 短会话；写库失败降级不抛出，不影响业务调用方）
- 便捷方法：info / warning / error（按级别）+ ai / audit（按契约必带字段）
- 查询：时间范围 / 分类 / 级别 / message 关键词过滤 + timestamp 倒序分页
- 清理：按保留天数删除过期记录（供定时清理任务调用，PRD 3.6.2 默认 30 天）
"""
import datetime
import logging
from typing import Any

import structlog
from sqlalchemy import delete, func, select

from app.core.database import SessionFactory
from app.models.log import Log
from app.schemas.log import LogOut


def setup_structlog() -> None:
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(ensure_ascii=False),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


logger = logging.getLogger("datapilot.log")

# 日志契约（CLAUDE.md 4.7 / PRD 3.6.1）：分类固定五类，级别含 CRITICAL
LOG_CATEGORIES: tuple[str, ...] = ("system", "application", "ai", "error", "audit")
LOG_LEVELS: tuple[str, ...] = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")

# 分类必带的 context 字段（ai / audit 契约断言）
_REQUIRED_CONTEXT: dict[str, tuple[str, ...]] = {
    "ai": ("model", "tokens", "latency_ms"),
    "audit": ("user", "resource", "action"),
}


def _serialize(log: Log) -> dict[str, Any]:
    """ORM -> API 字典（id/timestamp 转为 JSON 友好类型）。"""
    return LogOut.model_validate(log).model_dump(mode="json")


def _as_utc(dt: datetime.datetime) -> datetime.datetime:
    """naive 时间按 UTC 解释，统一成 aware 后再与 timestamptz 比较。"""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=datetime.timezone.utc)
    return dt


class LogService:
    """业务日志入库（写入 + 查询 + 清理）。DB 一律用 SessionFactory 短会话。"""

    # ---------- 写入 ----------

    async def write_log(
        self, level: str, category: str, message: str, context: dict | None = None
    ) -> None:
        """写一条日志到 logs 表。

        - level 大小写不敏感，入库统一大写；category 必须为固定五类之一。
        - ai / audit 类按契约校验必带 context 字段，缺失抛 ValueError。
        - 写库失败降级：仅本地 logger.warning，不向业务调用方抛异常。
        """
        lvl = str(level).upper()
        if lvl not in LOG_LEVELS:
            raise ValueError(f"日志级别非法: {level}，必须为 {'/'.join(LOG_LEVELS)}")
        if category not in LOG_CATEGORIES:
            raise ValueError(f"日志类别非法: {category}，必须为 {'/'.join(LOG_CATEGORIES)}")
        ctx = dict(context or {})
        for field in _REQUIRED_CONTEXT.get(category, ()):
            if field not in ctx:
                raise ValueError(f"{category} 类日志 context 缺少必带字段: {field}")
        try:
            async with SessionFactory() as db:
                db.add(Log(level=lvl, category=category, message=message, context=ctx))
                await db.commit()
        except Exception as exc:  # 写库失败不能影响业务调用方：降级为本地日志
            logger.warning(
                "日志入库失败（已降级，仅本地输出）level=%s category=%s: %s",
                lvl, category, exc,
            )

    async def info(self, category: str, message: str, **context) -> None:
        """INFO 级便捷写入。"""
        await self.write_log("INFO", category, message, context)

    async def warning(self, category: str, message: str, **context) -> None:
        """WARNING 级便捷写入。"""
        await self.write_log("WARNING", category, message, context)

    async def error(self, category: str, message: str, **context) -> None:
        """ERROR 级便捷写入（异常堆栈等放 context，不塞进 message）。"""
        await self.write_log("ERROR", category, message, context)

    async def ai(
        self,
        model: str,
        tokens: int,
        latency_ms: int | float,
        message: str,
        **context,
    ) -> None:
        """AI 日志：context 必带 model / tokens / latency_ms（CLAUDE.md 4.7）。"""
        ctx = {**context, "model": model, "tokens": tokens, "latency_ms": latency_ms}
        await self.write_log("INFO", "ai", message, ctx)

    async def audit(
        self, user: str, resource: str, action: str, message: str, **context
    ) -> None:
        """审计日志：context 必带 user / resource / action（CLAUDE.md 4.7）。"""
        ctx = {**context, "user": user, "resource": resource, "action": action}
        await self.write_log("INFO", "audit", message, ctx)

    # ---------- 查询 ----------

    async def query(
        self,
        *,
        start: datetime.datetime | None = None,
        end: datetime.datetime | None = None,
        category: str | None = None,
        level: str | None = None,
        keyword: str | None = None,
        page: int = 1,
        page_size: int = 20,
    ) -> dict[str, Any]:
        """过滤 + 分页查询，按 timestamp 倒序。

        keyword 对 message 做 ILIKE 模糊匹配；start/end 为闭区间。
        返回 {"items": [...], "total": int, "page": int, "page_size": int}，
        items 元素为 {id, timestamp, level, category, message, context}。
        """
        if category is not None and category not in LOG_CATEGORIES:
            raise ValueError(f"日志类别非法: {category}，必须为 {'/'.join(LOG_CATEGORIES)}")
        if level is not None and level.upper() not in LOG_LEVELS:
            raise ValueError(f"日志级别非法: {level}，必须为 {'/'.join(LOG_LEVELS)}")
        if page < 1 or page_size < 1:
            raise ValueError("page 与 page_size 必须 >= 1")

        conds = []
        if start is not None:
            conds.append(Log.timestamp >= _as_utc(start))
        if end is not None:
            conds.append(Log.timestamp <= _as_utc(end))
        if category:
            conds.append(Log.category == category)
        if level:
            conds.append(Log.level == level.upper())
        if keyword:
            conds.append(Log.message.ilike(f"%{keyword}%"))

        async with SessionFactory() as db:
            total = await db.scalar(
                select(func.count()).select_from(Log).where(*conds)
            )
            stmt = (
                select(Log)
                .where(*conds)
                .order_by(Log.timestamp.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
            rows = (await db.scalars(stmt)).all()
        return {
            "items": [_serialize(r) for r in rows],
            "total": int(total or 0),
            "page": page,
            "page_size": page_size,
        }

    # ---------- 清理 ----------

    async def cleanup(self, retention_days: int) -> int:
        """删除 timestamp 早于 now - retention_days 的日志，返回删除行数。"""
        if retention_days < 0:
            raise ValueError("retention_days 不能为负数")
        cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(
            days=retention_days
        )
        async with SessionFactory() as db:
            result = await db.execute(delete(Log).where(Log.timestamp < cutoff))
            await db.commit()
            return int(result.rowcount or 0)
