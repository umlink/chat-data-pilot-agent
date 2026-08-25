"""初始化脚本：默认管理员、默认配置、MinIO bucket。幂等。
对应技术方案 4.6。
"""
import logging

from sqlalchemy import select

from app.core.config import settings
from app.core.database import SessionFactory
from app.core.security import hash_password
from app.models.config import Config
from app.models.user import User
from app.services.config_service import DEFAULT_CONFIGS
from app.services.storage_service import ensure_bucket

logger = logging.getLogger("datapilot.init")

DEFAULT_ADMIN_USERNAME = "admin"
DEFAULT_ADMIN_PASSWORD = "Admin@12345"


async def _seed_admin() -> None:
    async with SessionFactory() as db:
        result = await db.execute(select(User).where(User.username == DEFAULT_ADMIN_USERNAME))
        if result.scalar_one_or_none() is not None:
            return
        db.add(User(username=DEFAULT_ADMIN_USERNAME, password_hash=hash_password(DEFAULT_ADMIN_PASSWORD)))
        await db.commit()
        logger.info("已创建默认管理员 %s（首次登录后请修改密码）", DEFAULT_ADMIN_USERNAME)


async def _seed_configs() -> None:
    async with SessionFactory() as db:
        for key, (category, value) in DEFAULT_CONFIGS.items():
            existing = await db.get(Config, key)
            if existing is not None:
                continue
            db.add(Config(key=key, category=category, value=value))
        await db.commit()
        logger.info("默认配置初始化完成")


async def seed() -> None:
    """应用启动时调用（幂等，失败不阻断启动）。"""
    if settings.AUTO_CREATE_TABLES:
        pass  # 建表在 lifespan 中早于 seed 执行
    await _seed_admin()
    await _seed_configs()
    ensure_bucket()