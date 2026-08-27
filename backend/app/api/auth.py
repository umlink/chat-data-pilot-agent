from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.redis import get_redis
from app.core.security import create_access_token, hash_password, verify_password
from app.models.user import User
from app.schemas.common import ApiResponse
from app.services.log_service import LogService

router = APIRouter(prefix="/auth", tags=["auth"])

_log_service = LogService()

# 登录限流（CLAUDE.md 4.6：每 IP 每分钟 5 次）
LOGIN_RATE_LIMIT = 5
LOGIN_RATE_WINDOW_SECONDS = 60


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str = Field(min_length=8, max_length=64)


class UserInfo(BaseModel):
    id: str
    username: str


async def _rate_limit_login(request: Request) -> None:
    """登录接口限流：每 IP 每分钟 N 次。Redis 不可用时降级放行（与对话限流一致）。"""
    ip = request.client.host if request.client else "unknown"
    try:
        redis = await get_redis()
        key = f"ratelimit:login:{ip}"
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, LOGIN_RATE_WINDOW_SECONDS)
        if count > LOGIN_RATE_LIMIT:
            raise HTTPException(status_code=429, detail="登录尝试过于频繁，请 1 分钟后再试")
    except HTTPException:
        raise
    except Exception:
        # Redis 不可用：降级放行（不阻断登录）
        pass


@router.post("/login", response_model=ApiResponse[dict])
async def login(
    req: LoginRequest,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await _rate_limit_login(request)
    result = await db.execute(select(User).where(User.username == req.username))
    user = result.scalar_one_or_none()
    if user is None or not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    token = create_access_token(str(user.id))
    await _log_service.info(
        "application", "用户登录", user=req.username, resource="auth", action="login"
    )
    return ApiResponse(data={"token": token, "user": UserInfo(id=str(user.id), username=user.username)})


@router.get("/me", response_model=ApiResponse[UserInfo])
async def me(user: Annotated[User, Depends(get_current_user)]):
    return ApiResponse(data=UserInfo(id=str(user.id), username=user.username))


@router.post("/change-password", response_model=ApiResponse)
async def change_password(
    req: ChangePasswordRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    if not verify_password(req.old_password, user.password_hash):
        raise HTTPException(status_code=400, detail="原密码错误")
    user.password_hash = hash_password(req.new_password)
    await db.commit()
    return ApiResponse(data=None, message="密码已修改")