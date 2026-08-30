"""SQLAlchemy 异步引擎与会话管理。"""
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import settings


class Base(DeclarativeBase):
    pass


# 注意：asyncpg 下 pool_pre_ping 会触发 MissingGreenlet（本环境实测），远程连接稳定，关闭之。
engine = create_async_engine(settings.db_url, pool_pre_ping=False, echo=False)
SessionFactory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    """FastAPI 依赖：请求级会话。"""
    async with SessionFactory() as session:
        yield session


async def init_db() -> None:
    """开发期便捷建表（幂等）。正式/生产环境一律走 Alembic（alembic upgrade head）。"""
    from app import models  # noqa: F401 触发模型注册

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def close_db() -> None:
    await engine.dispose()


async def ping_db(db: AsyncSession) -> bool:
    result = await db.execute(text("SELECT 1"))
    return result.scalar() == 1