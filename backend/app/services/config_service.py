"""配置读写、缓存失效、热更新。

读取：优先 Redis 缓存哈希 config:all，未命中查 PostgreSQL 并回填。
更新：更新 DB → 删除 Redis 对应 key → 发布 Pub/Sub config_changed。
TODO(M1)：完整实现。
"""
from typing import Any

DEFAULT_CONFIGS: dict[str, tuple[str, dict]] = {
    # key -> (category, value)
    "llm.provider": ("llm", {
        "provider": "openai", "model": "gpt-4o", "temperature": 0.5,
        "max_tokens": 4096, "timeout": 60, "retry_count": 1, "stream_enabled": True,
    }),
    "llm.openai": ("llm", {"api_key": "", "base_url": "", "organization": ""}),
    "llm.anthropic": ("llm", {"api_key": "", "base_url": "", "version": "2023-06-01"}),
    "system.query": ("system", {"max_query_rows": 1000}),
    "system.task": ("system", {"timeout_seconds": 300, "max_concurrency": 3}),
    "system.upload": ("system", {"max_size_mb": 20}),
    "system.session": ("system", {"retention_days": 30}),
    "system.sql": ("system", {"safe_mode": "normal"}),
    "system.log": ("system", {"retention_days": 30}),
}


class ConfigService:
    def __init__(self, redis=None, db_session_factory=None):
        self._redis = redis
        self._session_factory = db_session_factory

    async def get(self, key: str) -> dict[str, Any] | None:
        raise NotImplementedError("M1")

    async def get_all(self) -> dict[str, dict[str, Any]]:
        raise NotImplementedError("M1")

    async def set_many(self, updates: dict[str, dict]) -> None:
        raise NotImplementedError("M1")

    async def get_llm_config(self) -> dict:
        raise NotImplementedError("M1")