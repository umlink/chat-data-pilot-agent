import datetime
import uuid

from sqlalchemy import DateTime, Index, String, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Log(Base):
    """日志表（统一存储：system / application / ai / error / audit）。"""

    __tablename__ = "logs"
    __table_args__ = (
        Index("ix_logs_timestamp_category_level", "timestamp", "category", "level"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    timestamp: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    level: Mapped[str] = mapped_column(String(10), nullable=False)  # DEBUG/INFO/WARNING/ERROR/CRITICAL
    category: Mapped[str] = mapped_column(String(50), nullable=False)  # system/application/ai/error/audit
    message: Mapped[str] = mapped_column(String, nullable=False)
    context: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)