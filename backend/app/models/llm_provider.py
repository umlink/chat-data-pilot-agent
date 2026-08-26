import datetime
import uuid

from sqlalchemy import Boolean, DateTime, String, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class LlmProvider(Base):
    """LLM 供应商（多实例，支持多 provider 并存与默认切换，全局共享与 configs 一致）。

    运行时 LLM 配置来源：is_default 的 provider（ConfigService.get_llm_config 优先本表，
    表空时回退旧 configs 键 llm.provider / llm.openai / llm.anthropic）。
    """

    __tablename__ = "llm_providers"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    type: Mapped[str] = mapped_column(String(20), nullable=False)  # openai / anthropic
    base_url: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    # 敏感字段：入库加密（enc: 前缀 Fernet），出参恒掩码 ******
    api_key: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    models: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    default_model: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    is_default: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
