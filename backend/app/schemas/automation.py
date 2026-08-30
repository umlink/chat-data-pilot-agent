"""自动化任务请求/响应模型。契约见 docs/定时任务与第三方通知方案.md §7。"""
import datetime
import uuid
from typing import Literal

from croniter import croniter
from pydantic import BaseModel, ConfigDict, Field, field_validator

# 动作枚举：sql_report（扩展位 export/webhook 本期只留枚举不实现；notify 不设——通知归 notification 字段）
Action = Literal["sql_report"]

# cron 字符集白名单（防注入，见方案 §2.4）：仅允许数字、空格与 */,-
_CRON_ALLOWED = set("0123456789 */,-")


class ChannelBinding(BaseModel):
    """通知绑定（on_success / on_failure 单渠道）。本期仅存储，通知接入在后续模块。"""

    enabled: bool = False
    channel_id: str | None = None


class AutomationNotification(BaseModel):
    """任务通知配置：成功/失败分别绑定渠道。"""

    on_success: ChannelBinding = Field(default_factory=ChannelBinding)
    on_failure: ChannelBinding = Field(default_factory=ChannelBinding)


def _validate_cron(value: str) -> str:
    """cron 校验：字符集白名单 + 必须 5 段 + croniter.is_valid 兜底。"""
    value = value.strip()
    if not value:
        raise ValueError("cron 表达式不能为空")
    if any(c not in _CRON_ALLOWED for c in value):
        raise ValueError("cron 表达式含非法字符（仅允许数字、空格与 * / , -）")
    if len(value.split()) != 5:
        raise ValueError("cron 表达式必须为 5 段（分 时 日 月 周）")
    if not croniter.is_valid(value):
        raise ValueError("cron 表达式无效")
    return value


class AutomationCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: str | None = None
    action: Action = "sql_report"
    # {datasource_id, sql_text, chart_config, variable_defaults}
    params: dict = Field(default_factory=dict)
    cron_expression: str
    timezone: str = "Asia/Shanghai"
    enabled: bool = True
    notification: AutomationNotification | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("任务名称不能为空")
        return value

    @field_validator("cron_expression")
    @classmethod
    def _cron(cls, value: str) -> str:
        return _validate_cron(value)


class AutomationParseRequest(BaseModel):
    """自然语言解析入参（方案 §2.8）：数据源必填——LLM 须基于其 schema 生成 SQL。"""

    description: str = Field(..., min_length=1, max_length=500)
    datasource_id: str


class AutomationDraft(BaseModel):
    """parse 产物（不落库，前端确认卡展示；cron 已由后端按 §2.4 生成并校验）。

    确认提交走 POST /api/automations（AutomationCreate 结构）：params 内已含
    datasource_id（由后端锁定填入 parse 入参，LLM 不猜数据源）。
    """

    name: str
    description: str | None = None
    params: dict = Field(default_factory=dict)
    cron_expression: str
    timezone: str = "Asia/Shanghai"
    notification: AutomationNotification | None = None
    readable: str | None = None
    datasource_name: str | None = None


class AutomationUpdate(BaseModel):
    """更新（缺省字段不修改）。变更 cron/enabled 后由 service 重算 next_run_at。"""

    id: str
    name: str | None = Field(None, min_length=1, max_length=100)
    description: str | None = None
    params: dict | None = None
    cron_expression: str | None = None
    timezone: str | None = None
    enabled: bool | None = None
    notification: AutomationNotification | None = None

    @field_validator("cron_expression")
    @classmethod
    def _cron(cls, value: str | None) -> str | None:
        return _validate_cron(value) if value is not None else None


class AutomationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None = None
    action: str
    params: dict
    cron_expression: str
    timezone: str
    enabled: bool
    notification: dict | None = None
    last_run_at: datetime.datetime | None = None
    last_status: str | None = None
    next_run_at: datetime.datetime | None = None
    datasource_name: str | None = None  # api 层按归属数据源回填（展示用）
    readable: str | None = None  # cron 中文描述（api 层 describe_cron 回填）
    created_at: datetime.datetime | None = None
    updated_at: datetime.datetime | None = None


class AutomationRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    automation_id: uuid.UUID
    status: str
    started_at: datetime.datetime | None = None
    finished_at: datetime.datetime | None = None
    duration_ms: int | None = None
    error: str | None = None
    params: dict | None = None
    result: dict | None = None
