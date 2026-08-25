from fastapi import APIRouter

from app.schemas.common import ApiResponse

router = APIRouter(prefix="/logs", tags=["logs"])


@router.get("", response_model=ApiResponse[list])
async def list_logs():
    return ApiResponse(data=[], message="TODO")