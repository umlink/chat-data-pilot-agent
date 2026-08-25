from typing import Annotated

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import decode_access_token
from app.models.user import User

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