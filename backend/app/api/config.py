from fastapi import APIRouter

from app.schemas.common import ApiResponse

router = APIRouter(prefix="/config", tags=["config"])


@router.get("", response_model=ApiResponse[dict])
async def get_config():
    return ApiResponse(data={}, message="TODO")