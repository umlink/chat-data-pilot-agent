"""模板 API（可复用的分析配置，全部归属当前用户）。
- GET  /api/templates          列表（按 updated_at 倒序，支持 keyword 过滤名称）
- POST /api/templates          创建
- POST /api/templates/update   更新（body 含 id；缺省字段不修改，空字符串清空）
- POST /api/templates/delete   删除（body 含 id；校验归属）
"""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.datasource import Datasource, Template
from app.models.user import User
from app.schemas.common import ApiResponse
from app.schemas.template import TemplateCreate, TemplateOut, TemplateUpdate

router = APIRouter(prefix="/templates", tags=["templates"])


class DeleteTemplateRequest(BaseModel):
    id: str


async def _get_owned_template(db: AsyncSession, user: User, template_id: str) -> Template:
    """按 id 取模板并校验归属：不存在 / 非本人统一 404。"""
    try:
        tid = UUID(template_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="模板 ID 非法")
    template = await db.get(Template, tid)
    if template is None or template.user_id != user.id:
        raise HTTPException(status_code=404, detail="模板不存在")
    return template


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


@router.get("", response_model=ApiResponse[list[TemplateOut]])
async def list_templates(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    keyword: str = Query("", description="按模板名称过滤的关键字"),
):
    keyword = keyword.strip()
    stmt = select(Template).where(Template.user_id == user.id)
    if keyword:
        stmt = stmt.where(Template.name.ilike(f"%{keyword}%"))
    stmt = stmt.order_by(Template.updated_at.desc())
    result = await db.execute(stmt)
    items = result.scalars().all()
    return ApiResponse(data=[TemplateOut.model_validate(t) for t in items])


@router.post("", response_model=ApiResponse[TemplateOut])
async def create_template(
    req: TemplateCreate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    datasource_id: UUID | None = None
    if req.datasource_id and req.datasource_id.strip():
        datasource_id = await _validate_datasource_id(db, user, req.datasource_id.strip())
    template = Template(
        user_id=user.id,
        name=req.name,
        description=req.description,
        datasource_id=datasource_id,
        sql_text=req.sql_text,
        chart_config=req.chart_config,
    )
    db.add(template)
    await db.commit()
    await db.refresh(template)
    return ApiResponse(data=TemplateOut.model_validate(template), message="模板已创建")


@router.post("/update", response_model=ApiResponse[TemplateOut])
async def update_template(
    req: TemplateUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    template = await _get_owned_template(db, user, req.id)
    if req.name is not None:
        template.name = req.name
    if req.description is not None:
        template.description = req.description.strip() or None
    if req.datasource_id is not None:
        if not req.datasource_id.strip():
            template.datasource_id = None  # 空字符串 = 解除数据源关联
        else:
            template.datasource_id = await _validate_datasource_id(
                db, user, req.datasource_id.strip()
            )
    if req.sql_text is not None:
        template.sql_text = req.sql_text.strip() or None
    if req.chart_config is not None:
        template.chart_config = req.chart_config
    await db.commit()
    await db.refresh(template)
    return ApiResponse(data=TemplateOut.model_validate(template), message="模板已更新")


@router.post("/delete", response_model=ApiResponse)
async def delete_template(
    req: DeleteTemplateRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    template = await _get_owned_template(db, user, req.id)
    await db.delete(template)
    await db.commit()
    return ApiResponse(data=None, message="模板已删除")
