from fastapi import APIRouter

from app.schemas.common import ApiResponse

router = APIRouter(prefix="/upload", tags=["upload"])


@router.get("/info", response_model=ApiResponse[dict])
async def upload_info():
    return ApiResponse(data={"max_size_mb": 20}, message="TODO")