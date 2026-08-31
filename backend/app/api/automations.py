"""自动化任务 API（Automation 骨架：不含通知发送与自然语言解析）。
- GET  /api/automations            列表（含 datasource_name / schedule 可读描述）
- POST /api/automations            创建（数据源必填 + cron 校验 + SQL 只读）
- POST /api/automations/update     更新（body 含 id，缺省不改；变更 cron/enabled 重算 next_run_at）
- POST /api/automations/delete     删除（级联删除运行历史）
- POST /api/automations/{id}/run   立即运行（同步，超时 60s，返回本次运行记录）
- GET  /api/automations/{id}/runs  运行历史（含注入后 params 与 result{table, chart?}）
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
from app.models.automation import Automation, AutomationRun
from app.models.datasource import Datasource
from app.models.notification import NotificationChannel
from app.models.user import User
from app.schemas.automation import (
    AutomationCreate,
    AutomationDraft,
    AutomationNotification,
    AutomationOut,
    AutomationParseRequest,
    AutomationRunOut,
    AutomationUpdate,
)
from app.schemas.common import ApiResponse
from app.services.automation_service import (
    describe_cron,
    parse_automation as service_parse_automation,
    refresh_next_run,
    run_automation,
)
from app.services.log_service import LogService
# sql_engine 的语句分类器（单条 SELECT 判定）：自动化任务只允许只读查询（方案 §2.6）
from app.services.sql_engine import _sql_kind as sql_kind

router = APIRouter(prefix="/automations", tags=["automations"])

_log_service = LogService()
logger = logging.getLogger("datapilot.automation")


class DeleteAutomationRequest(BaseModel):
    id: str


async def _get_owned_automation(
    db: AsyncSession, user: User, automation_id: str
) -> Automation:
    """按 id 取任务并校验归属：不存在 / 非本人统一 404。"""
    try:
        rid = UUID(automation_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="任务 ID 非法")
    automation = await db.get(Automation, rid)
    if automation is None or automation.user_id != user.id:
        raise HTTPException(status_code=404, detail="任务不存在")
    return automation


async def _validate_datasource_id_required(
    db: AsyncSession, user: User, datasource_id: str | None
) -> UUID | None:
    """数据源必填校验（方案 §2.6）：定时任务必须显式绑定数据源，不允许空/猜测。

    注意：不复用允许空值的 reports._validate_datasource_id——Automation 需强制非空。
    """
    if not datasource_id or not str(datasource_id).strip():
        raise HTTPException(status_code=400, detail="请选择数据源")
    try:
        did = UUID(str(datasource_id).strip())
    except ValueError:
        raise HTTPException(status_code=400, detail="数据源 ID 非法")
    ds = await db.get(Datasource, did)
    if ds is None or ds.user_id != user.id:
        raise HTTPException(status_code=404, detail="数据源不存在")
    return did


def _ensure_readonly_sql(sql_text: str) -> None:
    """自动化任务仅允许单条 SELECT：写操作/多条语句/不可判定语句一律 400。"""
    kind, _risk = sql_kind(sql_text)
    if kind != "select":
        raise HTTPException(
            status_code=400,
            detail="自动化任务仅支持单条 SELECT 查询（写操作或多条语句不支持）",
        )


async def _validate_params(db: AsyncSession, user: User, params: dict) -> dict:
    """保存/更新时校验 params：SQL 只读 + 数据源必填归属。"""
    sql_text = (params.get("sql_text") or "").strip()
    if not sql_text:
        raise HTTPException(status_code=400, detail="SQL 不能为空")
    _ensure_readonly_sql(sql_text)
    await _validate_datasource_id_required(db, user, params.get("datasource_id"))
    params = dict(params)
    params["sql_text"] = sql_text
    return params


async def _validate_notification(
    db: AsyncSession, user: User, notification: AutomationNotification | None
) -> dict | None:
    """校验通知绑定归属（方案 §2.9）：channel_id 非空时须存在且属于当前用户。

    不要求渠道已启用（允许先绑定后停用）；返回可落库 JSON dict，None 表示无绑定。
    """
    if notification is None:
        return None
    data = notification.model_dump(mode="json")
    for key in ("on_success", "on_failure"):
        binding = data.get(key) or {}
        channel_id = binding.get("channel_id")
        if not channel_id:
            continue
        try:
            cid = UUID(str(channel_id))
        except ValueError:
            raise HTTPException(status_code=400, detail="通知渠道 ID 非法")
        channel = await db.get(NotificationChannel, cid)
        if channel is None or channel.user_id != user.id:
            raise HTTPException(status_code=404, detail="通知渠道不存在")
    return data


def _to_out(automation: Automation, ds_names: dict[str, str]) -> AutomationOut:
    out = AutomationOut.model_validate(automation)
    ds_id = (automation.params or {}).get("datasource_id")
    name = ds_names.get(str(ds_id)) if ds_id else None
    return out.model_copy(
        update={
            "datasource_name": name,
            "readable": describe_cron(automation.cron_expression),
        }
    )


async def _ds_name(db: AsyncSession, datasource_id: str | None) -> str | None:
    """按 id 取数据源名（展示用）；不存在/非法返回 None（不 500，已删数据源仍可运行任务）。"""
    if not datasource_id:
        return None
    try:
        did = UUID(str(datasource_id))
    except ValueError:
        return None
    ds = await db.get(Datasource, did)
    return ds.name if ds else None


@router.get("", response_model=ApiResponse[list[AutomationOut]])
async def list_automations(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    automations = (
        await db.scalars(
            select(Automation)
            .where(Automation.user_id == user.id)
            .order_by(Automation.updated_at.desc())
        )
    ).all()
    ds_names = {
        str(ds.id): ds.name
        for ds in (
            await db.scalars(select(Datasource).where(Datasource.user_id == user.id))
        ).all()
    }
    return ApiResponse(data=[_to_out(a, ds_names) for a in automations])


@router.post("", response_model=ApiResponse[AutomationOut])
async def create_automation(
    req: AutomationCreate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    params = await _validate_params(db, user, req.params)
    notification = await _validate_notification(db, user, req.notification)
    automation = Automation(
        user_id=user.id,
        name=req.name,
        description=req.description,
        action=req.action,
        params=params,
        cron_expression=req.cron_expression,
        timezone=req.timezone,
        enabled=req.enabled,
        notification=notification,
    )
    refresh_next_run(automation)
    db.add(automation)
    await db.commit()
    await db.refresh(automation)
    ds_name = await _ds_name(db, params.get("datasource_id"))
    await _log_service.audit(
        user=user.username, resource="automation", action="create",
        message=f"创建定时任务: {automation.name}",
    )
    return ApiResponse(
        data=_to_out(automation, {str(params["datasource_id"]): ds_name} if ds_name else {}),
        message="定时任务已创建",
    )


@router.post("/parse", response_model=ApiResponse[AutomationDraft])
async def parse_automation(
    req: AutomationParseRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """自然语言解析为待确认草稿（方案 §2.8）：数据源必填 + 归属校验；只读不落库。

    失败（LLM 不可用 / 解析失败）返回 400 可读提示，不落 500；确认走 POST /api/automations。
    """
    did = await _validate_datasource_id_required(db, user, req.datasource_id)
    ds = await db.get(Datasource, did)
    try:
        draft = await service_parse_automation(req.description, str(did), user.id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    draft["datasource_name"] = ds.name
    return ApiResponse(data=draft, message="解析完成，请确认后创建")


@router.post("/update", response_model=ApiResponse[AutomationOut])
async def update_automation(
    req: AutomationUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    automation = await _get_owned_automation(db, user, req.id)
    fields_set = req.model_fields_set

    if req.name is not None:
        name = req.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="任务名称不能为空")
        automation.name = name
    if "description" in fields_set:
        automation.description = req.description
    if "params" in fields_set:
        automation.params = await _validate_params(db, user, req.params or {})
    if req.cron_expression is not None:
        automation.cron_expression = req.cron_expression
    if req.timezone is not None:
        automation.timezone = req.timezone
    if req.enabled is not None:
        automation.enabled = req.enabled
    if "notification" in fields_set:
        automation.notification = await _validate_notification(db, user, req.notification)
    # cron / enabled 变更 → 重算 next_run_at
    if "cron_expression" in fields_set or "enabled" in fields_set:
        refresh_next_run(automation)
    await db.commit()
    await db.refresh(automation)
    ds_name = await _ds_name(db, (automation.params or {}).get("datasource_id"))
    await _log_service.audit(
        user=user.username, resource="automation", action="update",
        message=f"更新定时任务: {automation.name}",
    )
    return ApiResponse(
        data=_to_out(
            automation,
            {str(automation.params["datasource_id"]): ds_name} if ds_name else {},
        ),
        message="定时任务已更新",
    )


@router.post("/delete", response_model=ApiResponse)
async def delete_automation(
    req: DeleteAutomationRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    automation = await _get_owned_automation(db, user, req.id)
    await db.delete(automation)
    await db.commit()
    await _log_service.audit(
        user=user.username, resource="automation", action="delete",
        message=f"删除定时任务: {automation.name}",
    )
    return ApiResponse(data=None, message="定时任务已删除")


@router.post("/{automation_id}/run", response_model=ApiResponse[AutomationRunOut])
async def run_automation_now(
    automation_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """立即运行（同步等待执行完成；执行体内部有 60s 超时与失败收敛）。

    不受 enabled 限制（对齐 reports 的立即运行语义）；运行后 next_run_at 按当前
    enabled 状态重算（禁用则置 None，不排下次）。
    """
    automation = await _get_owned_automation(db, user, automation_id)
    run = await run_automation(automation.id)
    if run is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return ApiResponse(data=AutomationRunOut.model_validate(run), message="运行完成")


@router.get("/{automation_id}/runs", response_model=ApiResponse[list[AutomationRunOut]])
async def list_automation_runs(
    automation_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = Query(20, ge=1, le=100, description="返回条数上限"),
    offset: int = Query(0, ge=0, description="跳过的记录数（分页偏移）"),
):
    # limit+1 探测：多取 1 条供前端判断是否还有下一页（返回条数可能为 limit+1），
    # 避免总条数为 limit 整数倍时前端需多点一次「加载更多」。
    await _get_owned_automation(db, user, automation_id)
    try:
        rid = UUID(automation_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="任务 ID 非法")
    runs = (
        await db.scalars(
            select(AutomationRun)
            .where(AutomationRun.automation_id == rid)
            .order_by(AutomationRun.started_at.desc())
            .offset(offset)
            .limit(limit + 1)
        )
    ).all()
    return ApiResponse(data=[AutomationRunOut.model_validate(r) for r in runs])
