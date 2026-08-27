"""定时报告请求/响应模型。契约见 docs/技术方案设计.md 2.3「定时报告」。"""
import datetime
import re
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ScheduleType = Literal["daily", "weekly", "monthly"]
ChartType = Literal["line", "bar", "pie", "scatter", "heatmap"]
AggType = Literal["sum", "avg", "count", "max", "min"]

# HH:MM（24 小时制）
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


class ReportMeasure(BaseModel):
    """指标列（同 create_chart 工具语义，见 chart_builder）。"""

    column: str = Field(..., min_length=1)
    agg: AggType | None = None
    name: str | None = None


class ReportChartConfig(BaseModel):
    """报告图表配置：执行 SQL 后按 dimension/measures 聚合生成图表快照。"""

    chart_type: ChartType
    dimension: str = Field(..., min_length=1)
    measures: list[ReportMeasure] = Field(..., min_length=1)
    title: str | None = None


def _validate_schedule_fields(
    schedule_type: str,
    schedule_time: str,
    day_of_week: int | None,
    day_of_month: int | None,
) -> None:
    """计划字段一致性校验（创建/更新共用），失败抛 ValueError（api 层转 400）。"""
    if not _TIME_RE.match(schedule_time or ""):
        raise ValueError("schedule_time 必须为 HH:MM（24 小时制）")
    if schedule_type == "weekly":
        if day_of_week is None or not 0 <= day_of_week <= 6:
            raise ValueError("weekly 计划需要 day_of_week（0=周一 … 6=周日）")
    if schedule_type == "monthly":
        if day_of_month is None or not 1 <= day_of_month <= 31:
            raise ValueError("monthly 计划需要 day_of_month（1-31）")


class ReportCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    datasource_id: str | None = None
    sql_text: str = Field(..., min_length=1)
    chart_config: ReportChartConfig | None = None
    enabled: bool = True
    schedule_type: ScheduleType
    schedule_time: str
    day_of_week: int | None = Field(None, ge=0, le=6)
    day_of_month: int | None = Field(None, ge=1, le=31)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("报告名称不能为空")
        return value

    @model_validator(mode="after")
    def _check_schedule(self) -> "ReportCreate":
        _validate_schedule_fields(
            self.schedule_type, self.schedule_time, self.day_of_week, self.day_of_month
        )
        return self


class ReportUpdate(BaseModel):
    """更新（缺省字段不修改）。变更计划相关字段后由 service 重算 next_run_at。"""

    id: str
    name: str | None = Field(None, min_length=1, max_length=100)
    datasource_id: str | None = None
    sql_text: str | None = Field(None, min_length=1)
    chart_config: ReportChartConfig | None = None
    enabled: bool | None = None
    schedule_type: ScheduleType | None = None
    schedule_time: str | None = None
    day_of_week: int | None = Field(None, ge=0, le=6)
    day_of_month: int | None = Field(None, ge=1, le=31)


class ReportOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    datasource_id: uuid.UUID | None = None
    datasource_name: str | None = None  # api 层按归属数据源回填（展示用）
    sql_text: str
    chart_config: dict | None = None
    enabled: bool
    schedule_type: str
    schedule_time: str
    day_of_week: int | None = None
    day_of_month: int | None = None
    last_run_at: datetime.datetime | None = None
    last_status: str | None = None
    next_run_at: datetime.datetime | None = None
    created_at: datetime.datetime | None = None
    updated_at: datetime.datetime | None = None


class ReportRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    report_id: uuid.UUID
    status: str
    started_at: datetime.datetime | None = None
    finished_at: datetime.datetime | None = None
    duration_ms: int | None = None
    error: str | None = None
    result: dict | None = None
