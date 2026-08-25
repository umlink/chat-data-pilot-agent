"""配置读写、缓存失效、热更新。

读取：优先 Redis 缓存哈希 config:all，未命中查 PostgreSQL 并回填。
更新：更新 DB → 删除 Redis config:all → 发布 Pub/Sub config_changed。
敏感字段：入库加密（enc: 前缀），对外掩码，更新保留掩码与旧密文（core/security）。
"""
import json
import logging
from typing import Any

from sqlalchemy import select

from app.core.database import SessionFactory
from app.core.security import MASKED, decrypt_secret, upsert_secret
from app.models.config import Config

logger = logging.getLogger("datapilot.config")

CACHE_KEY = "config:all"
CHANNEL = "config_changed"

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

# 需按敏感字段处理的配置项（入库加密 / 出参掩码 / 运行时解密）
SECRET_FIELDS: dict[str, tuple[str, ...]] = {
    "llm.openai": ("api_key",),
    "llm.anthropic": ("api_key",),
}


def _category_for(key: str, existing: Config | None = None) -> str:
    if key in DEFAULT_CONFIGS:
        return DEFAULT_CONFIGS[key][0]
    if existing is not None:
        return existing.category
    return "custom"


def _merge_value(key: str, row_value: dict, new: dict) -> dict:
    """按字段级合并，敏感字段走 upsert_secret（掩码保留旧密文，新值加密）。"""
    merged = dict(row_value)
    secret_fields = SECRET_FIELDS.get(key, ())
    for field, value in new.items():
        old = merged.get(field)
        if field in secret_fields:
            old_str = old if isinstance(old, str) else None
            in_str = value if isinstance(value, str) else None
            merged[field] = upsert_secret(old_str, in_str)
        else:
            merged[field] = value
    return merged


def mask_value(key: str, value: dict) -> dict:
    """对外返回时掩码敏感字段。"""
    out = dict(value)
    for field in SECRET_FIELDS.get(key, ()):
        if out.get(field):
            out[field] = MASKED
    return out


def mask_all(data: dict[str, dict]) -> dict[str, dict]:
    return {k: mask_value(k, v) for k, v in data.items()}


class ConfigService:
    """配置读写服务。单一实例在 api 层持有；DB 用独立 SessionFactory，不混请求会话。"""

    def __init__(self, redis=None, session_factory=None):
        self._redis = redis
        self._session_factory = session_factory or SessionFactory

    async def _redis_client(self):
        if self._redis is None:
            from app.core.redis import get_redis

            self._redis = await get_redis()
        return self._redis

    async def _load_all_from_db(self) -> dict[str, dict]:
        async with self._session_factory() as db:
            result = await db.execute(select(Config))
            return {r.key: dict(r.value or {}) for r in result.scalars().all()}

    async def _refill_cache(self, data: dict[str, dict]) -> None:
        redis = await self._redis_client()
        try:
            pipe = redis.pipeline()
            await pipe.delete(CACHE_KEY)
            if data:
                await pipe.hset(
                    CACHE_KEY, mapping={k: json.dumps(v, ensure_ascii=False) for k, v in data.items()}
                )
            await pipe.execute()
        except Exception as exc:  # 基础设施不可用不阻断配置读取
            logger.warning("配置缓存回填失败：%s", exc)

    async def get_all(self) -> dict[str, dict[str, Any]]:
        redis = await self._redis_client()
        try:
            raw = await redis.hgetall(CACHE_KEY)
        except Exception as exc:
            logger.warning("Redis 不可用，配置走 DB：%s", exc)
            raw = {}
        if raw:
            return {k: json.loads(v) for k, v in raw.items()}
        data = await self._load_all_from_db()
        await self._refill_cache(data)
        return data

    async def get(self, key: str) -> dict[str, Any] | None:
        return (await self.get_all()).get(key)

    async def set_many(self, updates: dict[str, dict]) -> None:
        """批量更新。未知配置项抛 KeyError（由 API 层转 400）。"""
        if not updates:
            return
        async with self._session_factory() as db:
            for key, new_value in updates.items():
                row = await db.get(Config, key)
                if row is None and key not in DEFAULT_CONFIGS:
                    raise KeyError(f"未知配置项: {key}")
                if row is None:
                    db.add(
                        Config(
                            key=key,
                            category=_category_for(key),
                            value=_merge_value(key, {}, new_value),
                        )
                    )
                else:
                    row.value = _merge_value(key, row.value or {}, new_value)
                    row.category = _category_for(key, row)
            await db.commit()
        redis = await self._redis_client()
        try:
            await redis.delete(CACHE_KEY)
            await redis.publish(CHANNEL, json.dumps({"keys": list(updates)}, ensure_ascii=False))
        except Exception as exc:
            logger.warning("配置缓存失效失败：%s", exc)

    async def get_llm_config(self) -> dict:
        """运行时 LLM 配置：provider 配置 + 所选协议的凭证（敏感字段解密）。"""
        all_cfg = await self.get_all()
        provider_cfg = all_cfg.get("llm.provider") or DEFAULT_CONFIGS["llm.provider"][1]
        provider = (provider_cfg.get("provider") or "openai").lower()
        cred_key = f"llm.{provider}"
        creds = all_cfg.get(cred_key) or dict(DEFAULT_CONFIGS.get(cred_key, ("", {}))[1])
        merged = {**provider_cfg, "provider": provider}
        for field in SECRET_FIELDS.get(cred_key, ()):
            raw = creds.get(field)
            merged[field] = decrypt_secret(raw) if isinstance(raw, str) else ""
        return merged