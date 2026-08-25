"""模板相关请求/响应模型。与 docs/技术方案设计.md 2.3「模板」对齐。

模板 = 可复用的分析配置（数据源 + SQL + 图表配置），全部归属当前用户。
"""
import datetime
import uuid
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TemplateCreate(BaseModel):
    """创建模板。"""

    name: str = Field(..., min_length=1, max_length=100, description="模板名称")
    description: str | None = Field(None, description="模板说明")
    datasource_id: str | None = Field(None, description="关联数据源 ID（可选，须归属当前用户）")
    sql_text: str | None = Field(None, description="可复用的 SQL 语句")
    chart_config: dict[str, Any] | None = Field(
        None, description="图表配置（ChartContent 语义，如 {chart_type, title, ...}）"
    )

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("模板名称不能为空")
        return value


class TemplateUpdate(BaseModel):
    """更新模板（body 含 id）。

    语义：字段为 None（缺省）表示不修改；description / sql_text / datasource_id
    传空字符串表示清空（datasource_id 清空即解除数据源关联）。
    """

    id: str = Field(..., description="模板 ID")
    name: str | None = Field(None, min_length=1, max_length=100)
    description: str | None = None
    datasource_id: str | None = Field(None, description="传空字符串解除关联")
    sql_text: str | None = None
    chart_config: dict[str, Any] | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("模板名称不能为空")
        return value


class TemplateOut(BaseModel):
    """模板出参。"""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None = None
    datasource_id: uuid.UUID | None = None
    sql_text: str | None = None
    chart_config: dict[str, Any] | None = None
    created_at: datetime.datetime | None = None
    updated_at: datetime.datetime | None = None
