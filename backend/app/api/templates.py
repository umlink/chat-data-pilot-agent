from fastapi import APIRouter

from app.schemas.common import ApiResponse

router = APIRouter(prefix="/templates", tags=["templates"])


@router.get("", response_model=ApiResponse[list])
async def list_templates():
    return ApiResponse(data=[], message="TODO")