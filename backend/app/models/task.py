import datetime
import uuid

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Task(Base):
    """任务队列表（PostgreSQL SKIP LOCKED 实现）。"""

    __tablename__ = "tasks"
    __table_args__ = (
        Index("ix_tasks_status_created", "status", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True
    )
    type: Mapped[str] = mapped_column(String(50), nullable=False)  # query / analysis / complex_analysis / file_parse
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending"
    )  # pending/running/success/failed/cancelled
    params: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(String, nullable=True)
    progress: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    current_step: Mapped[str | None] = mapped_column(String(255), nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    started_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    session = relationship("Session", back_populates="tasks")