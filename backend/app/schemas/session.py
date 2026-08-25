"""会话相关请求/响应模型。与 docs/技术方案设计.md 2.3 一致。"""
import datetime
import uuid

from pydantic import BaseModel, ConfigDict


class SessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    created_at: datetime.datetime | None = None
    updated_at: datetime.datetime | None = None