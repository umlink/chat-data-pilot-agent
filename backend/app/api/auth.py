from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.security import create_access_token, hash_password, verify_password
from app.models.user import User
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str = Field(min_length=8, max_length=64)


class UserInfo(BaseModel):
    id: str
    username: str


@router.post("/login", response_model=ApiResponse[dict])
async def login(req: LoginRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    result = await db.execute(select(User).where(User.username == req.username))
    user = result.scalar_one_or_none()
    if user is None or not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    token = create_access_token(str(user.id))
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