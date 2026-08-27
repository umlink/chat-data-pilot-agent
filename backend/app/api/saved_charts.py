"""收藏图表 API（分析结果沉淀 / 个人看板）。
- GET  /api/saved-charts         列表（按 created_at 倒序）
- POST /api/saved-charts         收藏（chart_content 为契约 2.5 快照）
- POST /api/saved-charts/update  重命名（body 含 id）
- POST /api/saved-charts/delete  取消收藏（body 含 id）
"""
import logging
from typing import Annotated, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.analytics import SavedChart
from app.models.user import User
from app.schemas.common import ApiResponse
from app.schemas.saved_chart import SavedChartCreate, SavedChartOut, SavedChartUpdate

router = APIRouter(prefix="/saved-charts", tags=["saved-charts"])

logger = logging.getLogger("datapilot.saved_chart")


class DeleteSavedChartRequest(BaseModel):
    id: str


async def _get_owned_chart(db: AsyncSession, user: User, chart_id: str) -> SavedChart:
    """按 id 取收藏并校验归属：不存在 / 非本人统一 404。"""
    try:
        cid = UUID(chart_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="收藏 ID 非法")
    chart = await db.get(SavedChart, cid)
    if chart is None or chart.user_id != user.id:
        raise HTTPException(status_code=404, detail="收藏不存在")
    return chart


async def _resolve_session_id(db: AsyncSession, user: User, session_id: Optional[str]) -> UUID | None:
    """溯源会话 ID 校验：非本人/不存在时静默置空（收藏不应因会话失效而失败）。"""
    if not session_id or not session_id.strip():
        return None
    from app.models.user import Session

    try:
        sid = UUID(session_id)
    except ValueError:
        return None
    s = await db.get(Session, sid)
    if s is None or s.user_id != user.id:
        return None
    return sid


@router.get("", response_model=ApiResponse[list[SavedChartOut]])
async def list_saved_charts(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(
        select(SavedChart)
        .where(SavedChart.user_id == user.id)
        .order_by(SavedChart.created_at.desc())
    )
    items = result.scalars().all()
    return ApiResponse(data=[SavedChartOut.model_validate(c) for c in items])


@router.post("", response_model=ApiResponse[SavedChartOut])
async def create_saved_chart(
    req: SavedChartCreate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    session_id = await _resolve_session_id(db, user, req.session_id)
    chart = SavedChart(
        user_id=user.id,
        session_id=session_id,
        title=req.title,
        chart_content=req.chart_content.model_dump(mode="json"),
        query=req.query,
    )
    db.add(chart)
    await db.commit()
    await db.refresh(chart)
    return ApiResponse(data=SavedChartOut.model_validate(chart), message="已收藏到看板")


@router.post("/update", response_model=ApiResponse[SavedChartOut])
async def update_saved_chart(
    req: SavedChartUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    chart = await _get_owned_chart(db, user, req.id)
    title = req.title.strip()
    if title:
        chart.title = title
    await db.commit()
    await db.refresh(chart)
    return ApiResponse(data=SavedChartOut.model_validate(chart), message="已更新")


@router.post("/delete", response_model=ApiResponse)
async def delete_saved_chart(
    req: DeleteSavedChartRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    chart = await _get_owned_chart(db, user, req.id)
    await db.delete(chart)
    await db.commit()
    return ApiResponse(data=None, message="已取消收藏")
