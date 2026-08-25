"""日志 API。
- GET /api/logs           查询日志（时间范围 / 分类 / 级别 / 关键词过滤 + 分页）
- POST /api/logs/export   导出日志 CSV（同样的过滤参数，不分页）

CSV 导出为文件下载，走 StreamingResponse（UTF-8 BOM 头，Excel 打开中文不乱码），
属于文件流约定，不套 ApiResponse 信封。
"""
import csv
import io
import json
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.api.deps import get_current_user
from app.models.user import User
from app.schemas.common import ApiResponse
from app.services.log_service import LOG_CATEGORIES, LOG_LEVELS, LogService

router = APIRouter(prefix="/logs", tags=["logs"])

_log_service = LogService()

# 导出分批大小与总上限：流式输出避免一次性载入超大结果集
EXPORT_BATCH_SIZE = 2000
EXPORT_MAX_ROWS = 100_000


def _validate_filters(
    category: str | None, level: str | None
) -> tuple[str | None, str | None]:
    """校验过滤参数（CLAUDE.md 4.5：参数不合法统一 400）。level 大小写不敏感。"""
    if category is not None and category not in LOG_CATEGORIES:
        raise HTTPException(
            status_code=400,
            detail=f"日志类别非法: {category}，必须为 {'/'.join(LOG_CATEGORIES)}",
        )
    if level is not None and level.upper() not in LOG_LEVELS:
        raise HTTPException(
            status_code=400,
            detail=f"日志级别非法: {level}，必须为 {'/'.join(LOG_LEVELS)}",
        )
    return category, level.upper() if level else None


@router.get("", response_model=ApiResponse[dict])
async def list_logs(
    user: Annotated[User, Depends(get_current_user)],
    start: datetime | None = Query(None, description="起始时间（ISO 8601，含）"),
    end: datetime | None = Query(None, description="结束时间（ISO 8601，含）"),
    category: str | None = Query(None, description="system/application/ai/error/audit"),
    level: str | None = Query(
        None, description="DEBUG/INFO/WARNING/ERROR/CRITICAL（大小写不敏感）"
    ),
    keyword: str | None = Query(None, description="message 模糊匹配关键词"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=500),
):
    """查询日志（timestamp 倒序分页，返回 query 的分页结构）。"""
    category, level = _validate_filters(category, level)
    data = await _log_service.query(
        start=start,
        end=end,
        category=category,
        level=level,
        keyword=keyword,
        page=page,
        page_size=page_size,
    )
    return ApiResponse(data=data)


async def _csv_rows(
    *,
    start: datetime | None,
    end: datetime | None,
    category: str | None,
    level: str | None,
    keyword: str | None,
) -> AsyncIterator[str]:
    """按批拉取并逐行产出 CSV 文本。首块带 UTF-8 BOM + 表头。"""
    header = io.StringIO()
    header.write("\ufeff")  # UTF-8 BOM：保证 Excel 以 UTF-8 打开，中文不乱码
    csv.writer(header).writerow(["timestamp", "level", "category", "message", "context"])
    yield header.getvalue()

    page, exported = 1, 0
    while exported < EXPORT_MAX_ROWS:
        result = await _log_service.query(
            start=start,
            end=end,
            category=category,
            level=level,
            keyword=keyword,
            page=page,
            page_size=EXPORT_BATCH_SIZE,
        )
        if not result["items"]:
            break
        for item in result["items"]:
            buf = io.StringIO()
            csv.writer(buf).writerow(
                [
                    item["timestamp"],
                    item["level"],
                    item["category"],
                    item["message"],
                    json.dumps(item["context"], ensure_ascii=False),
                ]
            )
            yield buf.getvalue()
            exported += 1
        if exported >= result["total"]:
            break
        page += 1


@router.post("/export")
async def export_logs(
    user: Annotated[User, Depends(get_current_user)],
    start: datetime | None = Query(None, description="起始时间（ISO 8601，含）"),
    end: datetime | None = Query(None, description="结束时间（ISO 8601，含）"),
    category: str | None = Query(None, description="system/application/ai/error/audit"),
    level: str | None = Query(
        None, description="DEBUG/INFO/WARNING/ERROR/CRITICAL（大小写不敏感）"
    ),
    keyword: str | None = Query(None, description="message 模糊匹配关键词"),
):
    """导出日志 CSV：同样的过滤参数（不分页），列 timestamp,level,category,message,context。"""
    category, level = _validate_filters(category, level)
    filename = f"logs_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    return StreamingResponse(
        _csv_rows(
            start=start, end=end, category=category, level=level, keyword=keyword
        ),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
