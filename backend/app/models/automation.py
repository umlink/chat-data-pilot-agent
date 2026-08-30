"""自动化任务模型：泛化定时任务（动作 + 参数 + cron 调度 + 通知绑定）。

契约见 docs/定时任务与第三方通知方案.md 2.1 / docs/技术方案设计.md 2.2。
本期（Automation 骨架）只建 automations / automation_runs 两张表；
notification_channels / notification_logs 在通知模块落地。
"""
import datetime
import uuid

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Automation(Base):
    """自动化任务：cron 调度 + 动作参数 + 可选通知绑定。"""

    __tablename__ = "automations"
    __table_args__ = (
        Index("ix_automations_due", "enabled", "next_run_at"),
        Index("ix_automations_user_created", "user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(String, nullable=True)  # 自然语言原句（自然语言创建时保留）
    action: Mapped[str] = mapped_column(
        String(30), nullable=False
    )  # sql_report（扩展位：export/webhook）
    # {datasource_id, sql_text, chart_config, variable_defaults}
    params: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    cron_expression: Mapped[str] = mapped_column(String(100), nullable=False)  # 5 段 cron
    timezone: Mapped[str] = mapped_column(String(50), nullable=False, default="Asia/Shanghai")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # {on_success:{enabled,channel_id}, on_failure:{enabled,channel_id}}（通知接入后使用）
    notification: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    last_run_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_status: Mapped[str | None] = mapped_column(
        String(20), nullable=True
    )  # success/failed/running
    next_run_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user = relationship("User", back_populates="automations")
    runs = relationship(
        "AutomationRun",
        back_populates="automation",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class AutomationRun(Base):
    """自动化任务运行历史：每次执行的结果快照（table + 可选 chart）。"""

    __tablename__ = "automation_runs"
    __table_args__ = (
        Index("ix_automation_runs_automation_started", "automation_id", "started_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    automation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("automations.id", ondelete="CASCADE"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False)  # running/success/failed
    started_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    finished_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error: Mapped[str | None] = mapped_column(String, nullable=True)
    params: Mapped[dict | None] = mapped_column(JSONB, nullable=True)  # 本次注入后最终参数快照
    # {table: TableContent, chart?: ChartContent}
    result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    automation = relationship("Automation", back_populates="runs")
