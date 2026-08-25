from fastapi import APIRouter

from app.schemas.common import ApiResponse

router = APIRouter(prefix="/export", tags=["export"])


@router.get("/formats", response_model=ApiResponse[list])
async def export_formats():
    return ApiResponse(data=[], message="TODO")