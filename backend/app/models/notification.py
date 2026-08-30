"""通知渠道与发送记录模型。契约见 docs/定时任务与第三方通知方案.md 2.1 / docs/技术方案设计.md 2.2。"""
import datetime
import uuid

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class NotificationChannel(Base):
    """第三方推送渠道（邮件 / 飞书 / 企微 / 钉钉），config 敏感字段 enc: 加密。"""

    __tablename__ = "notification_channels"
    __table_args__ = (
        Index("ix_notification_channels_user_created", "user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)  # email/feishu/wecom/dingtalk
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # 敏感字段（webhook_url/secret/username/password）enc: 加密（方案 §2.1）
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user = relationship("User", back_populates="notification_channels")
    logs = relationship("NotificationLog", back_populates="channel", passive_deletes=True)


class NotificationLog(Base):
    """通知发送记录（审计/重试）。渠道删除后 channel_id 置 NULL 保留记录。"""

    __tablename__ = "notification_logs"
    __table_args__ = (
        Index("ix_notification_logs_user_created", "user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    channel_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("notification_channels.id", ondelete="SET NULL"),
        nullable=True,
    )
    subject: Mapped[str | None] = mapped_column(String(500), nullable=True)
    body: Mapped[str | None] = mapped_column(String, nullable=True)
    # {type: link|png, url?}，本期恒空（图表/附件归 R3，方案 §2.7）
    attachment_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False)  # success/failed
    error: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    user = relationship("User", back_populates="notification_logs")
    channel = relationship("NotificationChannel", back_populates="logs")
