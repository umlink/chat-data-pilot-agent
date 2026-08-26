from typing import Annotated

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.redis import get_redis
from app.core.security import decode_access_token
from app.models.user import User
from app.services.config_service import ConfigService

bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    if credentials is None:
        raise HTTPException(status_code=401, detail="未登录")
    payload = decode_access_token(credentials.credentials)
    if not payload or not payload.get("sub"):
        raise HTTPException(status_code=401, detail="登录凭证无效或已过期")
    try:
        user = await db.get(User, payload["sub"])
    except Exception:
        raise HTTPException(status_code=401, detail="登录凭证无效")
    if user is None:
        raise HTTPException(status_code=401, detail="用户不存在")
    return user


async def rate_limit_chat(user: Annotated[User, Depends(get_current_user)]) -> User:
    """对话 API 限流：每用户每分钟 N 次（PRD 安全设计，N 可配置 system.ratelimit.per_minute）。

    Redis 不可用时降级放行（基础设施不可用降级，不阻断对话）。
    """
    limit = int((await ConfigService().get("system.ratelimit") or {}).get("per_minute", 10))
    if limit <= 0:
        return user
    try:
        redis = await get_redis()
        key = f"ratelimit:chat:{user.id}"
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, 60)
        if count > limit:
            raise HTTPException(
                status_code=429,
                detail=f"请求过于频繁，请稍后再试（每分钟最多 {limit} 次）",
            )
    except HTTPException:
        raise
    except Exception:
        # Redis 不可用：降级放行（与 config/缓存一致的基础设施降级策略）
        pass
    return user