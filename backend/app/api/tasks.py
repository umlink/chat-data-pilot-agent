from fastapi import APIRouter

from app.schemas.common import ApiResponse

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.get("/info", response_model=ApiResponse[dict])
async def task_info():
    return ApiResponse(data={"endpoints": ["/{id}", "/{id}/cancel", "/{id}/stream"]}, message="TODO")