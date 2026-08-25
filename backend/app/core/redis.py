"""异步 Redis 客户端（懒加载单机单例）。

读取走 config 实时缓存；Pub/Sub 用于多实例配置变更广播。
注意：密码含特殊字符（如 `/`）时 URL 拼接易错，故直接按 host/port/password 建连。
"""
from redis import asyncio as aioredis

from .config import settings

_client: aioredis.Redis | None = None


async def get_redis() -> aioredis.Redis:
    """获取全局异步 Redis 客户端（首次调用时建连）。"""
    global _client
    if _client is None:
        if settings.REDIS_URL:
            _client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        else:
            _client = aioredis.Redis(
                host=settings.REDIS_HOST,
                port=settings.REDIS_PORT,
                password=settings.REDIS_PASSWORD or None,
                db=0,
                decode_responses=True,
                encoding="utf-8",
                max_connections=10,
            )
    return _client


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None