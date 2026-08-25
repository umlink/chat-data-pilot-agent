from fastapi import APIRouter

from app.schemas.common import ApiResponse

router = APIRouter(prefix="/chat", tags=["chat"])


@router.get("/info", response_model=ApiResponse[dict])
async def chat_info():
    return ApiResponse(data={"endpoints": ["/stream", "/execute", "/feedback"]}, message="TODO")