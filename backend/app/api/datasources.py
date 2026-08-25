from fastapi import APIRouter

from app.schemas.common import ApiResponse

router = APIRouter(prefix="/datasources", tags=["datasources"])


@router.get("", response_model=ApiResponse[list])
async def list_datasources():
    return ApiResponse(data=[], message="TODO")