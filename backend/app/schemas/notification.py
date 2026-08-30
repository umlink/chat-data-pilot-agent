"""通知渠道请求/响应模型。契约见 docs/定时任务与第三方通知方案.md §7。"""
import datetime
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Provider = Literal["email", "feishu", "wecom", "dingtalk"]


class ChannelCreate(BaseModel):
    provider: Provider
    name: str = Field(..., min_length=1, max_length=100)
    config: dict = Field(default_factory=dict)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("渠道名称不能为空")
        return value


class ChannelUpdate(BaseModel):
    """更新（缺省不改）。config 敏感字段掩码/留空 = 保留旧值（upsert_secret）。"""

    id: str
    name: str | None = Field(None, min_length=1, max_length=100)
    config: dict | None = None
    enabled: bool | None = None


class ChannelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    provider: str
    name: str
    config: dict  # 出参全掩码敏感字段（api 层回填）
    enabled: bool
    created_at: datetime.datetime | None = None
    updated_at: datetime.datetime | None = None


class ChannelTestRequest(BaseModel):
    """测试发送：channel_id（已有渠道）或 provider+config（新建前临时验证），二选一。"""

    channel_id: str | None = None
    provider: Provider | None = None
    config: dict | None = None
    subject: str = "DataPilotAgent 测试通知"
    body: str = "这是一条来自 DataPilotAgent 的测试消息"


class NotificationLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    channel_id: uuid.UUID | None = None
    subject: str | None = None
    body: str | None = None
    attachment_json: dict | None = None
    status: str
    error: str | None = None
    created_at: datetime.datetime | None = None


class NotificationSendRequest(BaseModel):
    """对话结果主动推送（方案 §3.5/§4.3）：本期无 attachment，仅纯文本。"""

    channel_id: str
    subject: str = Field(..., min_length=1, max_length=200)
    body: str = Field(..., min_length=1)
