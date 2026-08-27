"""收藏图表（看板）请求/响应模型。契约见 docs/技术方案设计.md 2.3「收藏图表」。"""
import datetime
import uuid
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.common import ChartContent


class SavedChartCreate(BaseModel):
    """收藏图表：chart_content 为契约 2.5 ChartContent 快照（含本地展示层配置）。"""

    title: str = Field(..., min_length=1, max_length=200)
    session_id: Optional[str] = Field(None, description="溯源会话 ID（会话删除后快照保留）")
    chart_content: ChartContent
    query: Optional[str] = None

    @field_validator("title")
    @classmethod
    def _strip_title(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("标题不能为空")
        return value


class SavedChartUpdate(BaseModel):
    """重命名。"""

    id: str
    title: str = Field(..., min_length=1, max_length=200)


class SavedChartOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    session_id: Optional[uuid.UUID] = None
    title: str
    chart_content: ChartContent
    query: Optional[str] = None
    created_at: Optional[datetime.datetime] = None
