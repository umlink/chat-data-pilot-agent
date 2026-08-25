"""会话 API。
- GET /api/sessions              会话列表（支持搜索、分页）
- POST /api/sessions             创建会话
- POST /api/sessions/update      重命名
- POST /api/sessions/delete      删除
- GET /api/sessions/{id}/messages 会话消息
TODO(M3)：实现。
"""
from fastapi import APIRouter

from app.schemas.common import ApiResponse

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.get("", response_model=ApiResponse[list])
async def list_sessions():
    return ApiResponse(data=[], message="TODO")