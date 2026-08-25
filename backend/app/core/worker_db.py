"""Worker 专用独立数据库引擎。

asyncpg + SQLAlchemy 的 pooled 连接在多个长驻消费协程（greenlet 上下文）间复用会
间歇性死锁（claim 挂起）。Worker 改用 NullPool：每次 checkout 都建立新物理连接，
彻底避免跨任务复用。Worker 吞吐不高（轮询+执行器），代价可接受。
"""
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from .config import settings

worker_engine = create_async_engine(settings.db_url, poolclass=NullPool, echo=False)
worker_sessionfactory = async_sessionmaker(
    worker_engine, class_=AsyncSession, expire_on_commit=False
)


async def dispose_worker_engine() -> None:
    await worker_engine.dispose()