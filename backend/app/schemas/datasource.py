"""数据源相关请求/响应模型。

与 docs/技术方案设计.md 2.3「数据源」API 及 CLAUDE.md 4.6 安全约定对齐：
- type 取值：postgresql / mysql / sqlite / csv / excel / json
- config 中的敏感字段（password / token 等）入库加密、出参掩码、更新时保留掩码
"""
import datetime
import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.security import MASKED

# 数据源类型。csv/excel/json 为文件型（不建立数据库连接，通过附件上传导入）
DatasourceType = Literal["postgresql", "mysql", "sqlite", "csv", "excel", "json"]

# 连接配置中的敏感字段 key（入库 encrypt_secret / 出参掩码 / 更新 upsert_secret 保留掩码）
SECRET_CONFIG_FIELDS: tuple[str, ...] = (
    "password", "token", "secret", "api_key", "access_key", "secret_key",
)

# 文件型数据源
FILE_TYPES: tuple[str, ...] = ("csv", "excel", "json")


def mask_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """递归掩码敏感字段：key 命中且值为非空字符串时置为 MASKED。"""

    def _walk(value: Any) -> Any:
        if isinstance(value, dict):
            return {
                k: (MASKED if (k in SECRET_CONFIG_FIELDS and isinstance(v, str) and v) else _walk(v))
                for k, v in value.items()
            }
        if isinstance(value, list):
            return [_walk(v) for v in value]
        return value

    return _walk(config or {})


class DatasourceCreate(BaseModel):
    """创建数据源。config 为客户端提交的明文配置，敏感字段由后端加密后入库。"""

    name: str = Field(..., min_length=1, max_length=100, description="数据源名称")
    type: DatasourceType
    config: dict[str, Any] = Field(default_factory=dict, description="连接配置")

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("数据源名称不能为空")
        return value


class DatasourceUpdate(BaseModel):
    """更新数据源（部分字段可省略）。config 为增量配置：敏感字段传掩码则保留旧密文。"""

    id: str = Field(..., description="数据源 ID")
    name: str | None = Field(None, min_length=1, max_length=100)
    type: DatasourceType | None = None
    config: dict[str, Any] | None = Field(None, description="增量配置")


class DatasourceOut(BaseModel):
    """数据源出参。config 由 field_validator 统一掩码，避免密文泄漏。"""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    type: str
    config: dict[str, Any]
    # 连接状态（PRD 3.2.3）：unknown / ok / error + 最后检测时间与失败原因（已脱敏）
    status: str = "unknown"
    last_checked_at: datetime.datetime | None = None
    last_error: str | None = None
    server_version: str | None = None
    created_at: datetime.datetime | None = None
    updated_at: datetime.datetime | None = None

    @field_validator("config", mode="before")
    @classmethod
    def _mask_config(cls, value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            return dict(value) if value else {}
        return mask_config(value)


class TestConnectionRequest(BaseModel):
    """连接测试请求体：type + config，不入库、不校验归属。"""

    type: DatasourceType
    config: dict[str, Any] = Field(default_factory=dict, description="测试用连接配置")