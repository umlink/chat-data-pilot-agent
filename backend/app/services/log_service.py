"""日志管理：structlog 结构化输出 + 异步写入 PostgreSQL。
TODO(M1)：接入 Log 表批量写入、日志清理任务。
"""
import logging
import structlog


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


class LogService:
    """业务日志入库（批量写入 + 定期清理）。M1 实现。"""

    async def info(self, category: str, message: str, **context) -> None:
        ...

    async def write_log(self, level: str, category: str, message: str, context: dict) -> None:
        ...

    async def cleanup(self, retention_days: int) -> int:
        raise NotImplementedError("M1")

    async def query(
        self, *, start, end, category, level, keyword, page=1, page_size=20
    ) -> dict:
        raise NotImplementedError("M1")