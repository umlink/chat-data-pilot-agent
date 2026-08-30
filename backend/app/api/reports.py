"""定时报告 API。
- GET  /api/reports            列表（含 schedule / last_run / next_run / datasource_name）
- POST /api/reports            创建（SQL 必须为单条 SELECT；保存时计算 next_run_at）
- POST /api/reports/update     更新（body 含 id，缺省字段不修改；变更计划后重算 next_run_at）
- POST /api/reports/delete     删除（级联删除运行历史）
- POST /api/reports/{id}/run   立即运行（同步执行，返回本次运行记录）
- GET  /api/reports/{id}/runs  运行历史（含 {table, chart?} 结果快照）
"""
import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.analytics import ReportRun, ScheduledReport
from app.models.datasource import Datasource
from app.models.user import User
from app.schemas.common import ApiResponse
from app.schemas.report import ReportCreate, ReportOut, ReportRunOut, ReportUpdate
from app.services.report_service import (
    refresh_next_run,
    run_report,
    validate_schedule,
)
# sql_engine 的语句分类器（单条 SELECT 判定）：定时报告只允许只读查询
from app.services.sql_engine import _sql_kind as sql_kind

router = APIRouter(prefix="/reports", tags=["reports"])

logger = logging.getLogger("datapilot.report")


class DeleteReportRequest(BaseModel):
    id: str


async def _get_owned_report(db: AsyncSession, user: User, report_id: str) -> ScheduledReport:
    """按 id 取报告并校验归属：不存在 / 非本人统一 404。"""
    try:
        rid = UUID(report_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="报告 ID 非法")
    report = await db.get(ScheduledReport, rid)
    if report is None or report.user_id != user.id:
        raise HTTPException(status_code=404, detail="报告不存在")
    return report


async def _validate_datasource_id(db: AsyncSession, user: User, datasource_id: str) -> UUID:
    """校验数据源 ID 合法且归属当前用户（防止跨用户引用），返回 UUID。"""
    try:
        did = UUID(datasource_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="数据源 ID 非法")
    ds = await db.get(Datasource, did)
    if ds is None or ds.user_id != user.id:
        raise HTTPException(status_code=404, detail="数据源不存在")
    return did


def _ensure_readonly_sql(sql_text: str) -> None:
    """定时报告仅允许单条 SELECT：写操作/多条语句/不可判定语句一律 400。"""
    kind, _risk = sql_kind(sql_text)
    if kind != "select":
        raise HTTPException(
            status_code=400,
            detail="定时报告仅支持单条 SELECT 查询（写操作或多条语句不支持）",
        )


def _to_out(report: ScheduledReport, ds_names: dict[str, str]) -> ReportOut:
    out = ReportOut.model_validate(report)
    name = ds_names.get(str(report.datasource_id)) if report.datasource_id else None
    return out.model_copy(update={"datasource_name": name})


async def _ds_name(db: AsyncSession, datasource_id: UUID | None) -> str | None:
    """按 id 取数据源名（展示用）；不存在返回 None（已删除的数据源仍可运行报告）。"""
    if datasource_id is None:
        return None
    ds = await db.get(Datasource, datasource_id)
    return ds.name if ds else None


@router.get("", response_model=ApiResponse[list[ReportOut]])
async def list_reports(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    reports = (
        await db.scalars(
            select(ScheduledReport)
            .where(ScheduledReport.user_id == user.id)
            .order_by(ScheduledReport.updated_at.desc())
        )
    ).all()
    ds_names = {
        str(ds.id): ds.name
        for ds in (
            await db.scalars(select(Datasource).where(Datasource.user_id == user.id))
        ).all()
    }
    return ApiResponse(data=[_to_out(r, ds_names) for r in reports])


@router.post("", response_model=ApiResponse[ReportOut])
async def create_report(
    req: ReportCreate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    _ensure_readonly_sql(req.sql_text)
    datasource_id: UUID | None = None
    if req.datasource_id and req.datasource_id.strip():
        datasource_id = await _validate_datasource_id(db, user, req.datasource_id.strip())
    report = ScheduledReport(
        user_id=user.id,
        name=req.name,
        datasource_id=datasource_id,
        sql_text=req.sql_text.strip(),
        chart_config=req.chart_config.model_dump(mode="json") if req.chart_config else None,
        enabled=req.enabled,
        schedule_type=req.schedule_type,
        schedule_time=req.schedule_time,
        day_of_week=req.day_of_week,
        day_of_month=req.day_of_month,
    )
    refresh_next_run(report)
    db.add(report)
    await db.commit()
    await db.refresh(report)
    ds_name = await _ds_name(db, report.datasource_id)
    return ApiResponse(data=_to_out(report, {str(report.datasource_id): ds_name} if ds_name else {}), message="报告已创建")


@router.post("/update", response_model=ApiResponse[ReportOut])
async def update_report(
    req: ReportUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    report = await _get_owned_report(db, user, req.id)
    fields_set = req.model_fields_set

    if req.name is not None:
        name = req.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="报告名称不能为空")
        report.name = name
    if req.sql_text is not None:
        _ensure_readonly_sql(req.sql_text)
        report.sql_text = req.sql_text.strip()
    if "datasource_id" in fields_set:
        if not req.datasource_id or not req.datasource_id.strip():
            report.datasource_id = None  # 空字符串 = 解除数据源关联（回退默认数据源）
        else:
            report.datasource_id = await _validate_datasource_id(db, user, req.datasource_id.strip())
    if "chart_config" in fields_set:
        report.chart_config = (
            req.chart_config.model_dump(mode="json") if req.chart_config else None
        )
    if req.enabled is not None:
        report.enabled = req.enabled
    # 计划字段：合并终值后统一校验（部分更新时以库中现值为准补齐）
    if any(k in fields_set for k in ("schedule_type", "schedule_time", "day_of_week", "day_of_month")):
        schedule_type = req.schedule_type or report.schedule_type
        schedule_time = req.schedule_time or report.schedule_time
        day_of_week = req.day_of_week if "day_of_week" in fields_set else report.day_of_week
        day_of_month = req.day_of_month if "day_of_month" in fields_set else report.day_of_month
        try:
            validate_schedule(schedule_type, schedule_time, day_of_week, day_of_month)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        report.schedule_type = schedule_type
        report.schedule_time = schedule_time
        report.day_of_week = day_of_week
        report.day_of_month = day_of_month
    # 计划或启停变更 → 重算 next_run_at
    if any(
        k in fields_set
        for k in ("schedule_type", "schedule_time", "day_of_week", "day_of_month", "enabled")
    ):
        refresh_next_run(report)
    await db.commit()
    await db.refresh(report)
    ds_name = await _ds_name(db, report.datasource_id)
    return ApiResponse(data=_to_out(report, {str(report.datasource_id): ds_name} if ds_name else {}), message="报告已更新")


@router.post("/delete", response_model=ApiResponse)
async def delete_report(
    req: DeleteReportRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    report = await _get_owned_report(db, user, req.id)
    await db.delete(report)
    await db.commit()
    return ApiResponse(data=None, message="报告已删除")


@router.post("/{report_id}/run", response_model=ApiResponse[ReportRunOut])
async def run_report_now(
    report_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """立即运行（同步等待执行完成；执行体内部有 60s 超时与失败收敛）。"""
    report = await _get_owned_report(db, user, report_id)
    _ensure_readonly_sql(report.sql_text)
    run = await run_report(report.id)
    if run is None:
        raise HTTPException(status_code=404, detail="报告不存在")
    return ApiResponse(data=ReportRunOut.model_validate(run), message="运行完成")


@router.get("/{report_id}/runs", response_model=ApiResponse[list[ReportRunOut]])
async def list_report_runs(
    report_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = Query(20, ge=1, le=100, description="返回条数上限"),
    offset: int = Query(0, ge=0, description="跳过条数（分页）"),
):
    await _get_owned_report(db, user, report_id)
    try:
        rid = UUID(report_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="报告 ID 非法")
    runs = (
        await db.scalars(
            select(ReportRun)
            .where(ReportRun.report_id == rid)
            .order_by(ReportRun.started_at.desc())
            .offset(offset)
            .limit(limit)
        )
    ).all()
    return ApiResponse(data=[ReportRunOut.model_validate(r) for r in runs])
