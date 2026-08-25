"""日志相关响应模型。与 docs/技术方案设计.md 2.3（GET /api/logs）一致。"""
import datetime
import uuid
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class LogOut(BaseModel):
    """单条日志（GET /api/logs 返回的 items 元素）。"""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    timestamp: datetime.datetime
    level: str
    category: str
    message: str
    context: dict[str, Any] = Field(default_factory=dict)
