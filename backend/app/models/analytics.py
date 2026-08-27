"""分析沉淀相关模型：收藏图表（看板）、定时报告与运行历史。

契约见 docs/技术方案设计.md 2.2（saved_charts / scheduled_reports / report_runs）。
"""
import datetime
import uuid

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, SmallInteger, String, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class SavedChart(Base):
    """收藏图表：对话中 chart block 的快照（ChartContent 契约 2.5），个人看板数据源。"""

    __tablename__ = "saved_charts"
    __table_args__ = (Index("ix_saved_charts_user_created", "user_id", "created_at"),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    # 溯源会话：会话被删后置 NULL，快照本身保留
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    chart_content: Mapped[dict] = mapped_column(JSONB, nullable=False)
    query: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    user = relationship("User", back_populates="saved_charts")


class ScheduledReport(Base):
    """定时报告：按计划自动执行 SQL 并生成结果快照。"""

    __tablename__ = "scheduled_reports"
    __table_args__ = (
        Index("ix_scheduled_reports_due", "enabled", "next_run_at"),
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
    datasource_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("datasources.id", ondelete="SET NULL"), nullable=True
    )
    # 仅允许单条 SELECT（保存与执行时均校验，见 report_service）
    sql_text: Mapped[str] = mapped_column(String, nullable=False)
    # {chart_type, dimension, measures, title}（可选，同 create_chart 语义）
    chart_config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    schedule_type: Mapped[str] = mapped_column(String(10), nullable=False)  # daily/weekly/monthly
    schedule_time: Mapped[str] = mapped_column(String(5), nullable=False)  # HH:MM（服务器本地时区）
    day_of_week: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)  # weekly：0=周一…6=周日
    day_of_month: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)  # monthly：1-31
    last_run_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_status: Mapped[str | None] = mapped_column(String(20), nullable=True)  # success/failed/running
    next_run_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user = relationship("User", back_populates="scheduled_reports")
    runs = relationship(
        "ReportRun", back_populates="report", cascade="all, delete-orphan", passive_deletes=True
    )


class ReportRun(Base):
    """定时报告运行历史：每次执行的结果快照（table + 可选 chart）。"""

    __tablename__ = "report_runs"
    __table_args__ = (Index("ix_report_runs_report_started", "report_id", "started_at"),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    report_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scheduled_reports.id", ondelete="CASCADE"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False)  # running/success/failed
    started_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    finished_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error: Mapped[str | None] = mapped_column(String, nullable=True)
    # {table: TableContent, chart?: ChartContent}
    result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    report = relationship("ScheduledReport", back_populates="runs")
