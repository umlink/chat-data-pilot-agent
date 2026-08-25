import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Config(Base):
    """系统配置表（热更新：DB -> Redis 缓存 -> Pub/Sub 失效通知）。"""

    __tablename__ = "configs"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    category: Mapped[str] = mapped_column(String(50), nullable=False)  # llm / system
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )