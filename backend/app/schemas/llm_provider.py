"""LLM 供应商请求/响应模型。与 frontend/src/types/llmProvider.ts 镜像（改一端须同步另一端）。

- GET  /api/llm/providers              → LlmProvider[]（api_key 掩码）
- POST /api/llm/providers              → 新增（首个自动默认）
- POST /api/llm/providers/update       → 更新（api_key 掩码/空串=保留旧值）
- POST /api/llm/providers/delete       → 删除（删默认自动提升）
- POST /api/llm/providers/{id}/set-default
- POST /api/llm/providers/{id}/test    → { ok, model?, latency_ms?, error? }
"""
import datetime
import uuid
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

PROVIDER_TYPES: tuple[str, ...] = ("openai", "anthropic")

# api_key 掩码（与 CLAUDE.md 4.6 一致的对外掩码约定）
MASKED = "******"


class LlmProviderCreate(BaseModel):
    """新增 LLM 供应商。"""

    name: str = Field(..., min_length=1, max_length=100)
    type: str = Field(..., description="openai / anthropic")
    base_url: str = Field("", max_length=500)
    api_key: str = Field("", max_length=2000)
    models: list[str] = Field(default_factory=list)
    default_model: str = Field("", max_length=100)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("供应商名称不能为空")
        return value

    @field_validator("type")
    @classmethod
    def _check_type(cls, value: str) -> str:
        value = (value or "").strip().lower()
        if value not in PROVIDER_TYPES:
            raise ValueError(f"供应商类型仅支持 {'/'.join(PROVIDER_TYPES)}")
        return value

    @field_validator("base_url")
    @classmethod
    def _strip_url(cls, value: str) -> str:
        return value.strip()


class LlmProviderUpdate(BaseModel):
    """更新 LLM 供应商（body 含 id；缺省字段不修改，api_key 掩码/空串=保留旧值）。"""

    id: str
    name: str | None = Field(None, min_length=1, max_length=100)
    type: str | None = None
    base_url: str | None = None
    api_key: str | None = Field(None, description="留空或掩码 = 保留旧密文")
    models: list[str] | None = None
    default_model: str | None = None

    @field_validator("type")
    @classmethod
    def _check_type(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip().lower()
        if value not in PROVIDER_TYPES:
            raise ValueError(f"供应商类型仅支持 {'/'.join(PROVIDER_TYPES)}")
        return value


class LlmProviderOut(BaseModel):
    """出参：api_key 恒掩码。"""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    type: str
    base_url: str
    api_key: str = MASKED
    models: list[str]
    default_model: str
    is_default: bool
    created_at: datetime.datetime | None = None
    updated_at: datetime.datetime | None = None

    @field_validator("api_key")
    @classmethod
    def _mask_api_key(cls, value: str) -> str:
        # 无论 ORM 存的是密文还是空串，出参一律掩码（CLAUDE.md 4.6）
        return MASKED


class ProviderTestResult(BaseModel):
    """连接测试结果。"""

    ok: bool
    model: str | None = None
    latency_ms: int | None = None
    error: str | None = None
