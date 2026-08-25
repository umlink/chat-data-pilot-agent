"""导出 API。
- POST /api/export          导出表格 / 图表 / 对话（返回文件流，非 ApiResponse 信封）
- GET  /api/export/formats  支持的 type×format 矩阵（供前端渲染导出菜单）
"""
import io
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from app.api.deps import get_current_user
from app.models.user import User
from app.schemas.common import ApiResponse
from app.schemas.export import ExportRequest
from app.services.export_service import CONTENT_TYPES, SUPPORTED_FORMATS, ExportService

router = APIRouter(prefix="/export", tags=["export"])

_service = ExportService()


def _content_disposition(filename: str) -> str:
    """构造 Content-Disposition：ASCII 回退名 + RFC 5987 UTF-8 文件名。"""
    ascii_part = filename.encode("ascii", "ignore").decode("ascii").strip()
    if not ascii_part:
        fallback = "download"
    elif ascii_part.startswith("_"):
        fallback = f"export{ascii_part}"
    else:
        fallback = ascii_part
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename)}"


@router.get("/formats", response_model=ApiResponse[dict])
async def export_formats(user: Annotated[User, Depends(get_current_user)]):
    """支持的导出组合矩阵（表格 / 图表 / 对话各自的可用格式与 MIME）。"""
    matrix = {export_type: list(fmts) for export_type, fmts in SUPPORTED_FORMATS.items()}
    return ApiResponse(
        data={"formats": matrix, "content_types": CONTENT_TYPES},
        message="ok",
    )


@router.post("")
async def export_data(
    req: ExportRequest,
    user: Annotated[User, Depends(get_current_user)],
) -> StreamingResponse:
    """导出文件流。

    组合非法 / 数据缺失由 service 抛 ValueError，这里统一转 400（中文提示）。
    返回为二进制文件流（Content-Type + Content-Disposition），不走统一信封。
    """
    try:
        content, filename, content_type = await _service.export(
            type=req.type, format=req.format, data=req.data
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return StreamingResponse(
        io.BytesIO(content),
        media_type=content_type,
        headers={"Content-Disposition": _content_disposition(filename)},
    )
