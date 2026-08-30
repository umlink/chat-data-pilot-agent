"""通知服务：渠道发送与测试（Notifier 抽象）。

契约见 docs/定时任务与第三方通知方案.md 2.7 / 4.1-4.2 / 5.5。
提供：
- send_to_channel：手动发送（对话主动推送/立即运行等），落 notification_logs；
- send_automation_alert：自动化运行通知（渠道已停用/删除静默跳过，失败告警走频控）；
- test_config：不落库的连通性测试（建渠道前临时 config 或已有渠道均可）；
- config 辅助：validate_config / encrypt_config / merge_config / decrypt_config / mask_config。
"""
import asyncio
import base64
import hashlib
import hmac
import logging
import time
import urllib.parse
from typing import Protocol
from uuid import UUID

from sqlalchemy import delete, select

from app.core.database import SessionFactory
from app.core.security import MASKED, decrypt_secret, encrypt_secret, upsert_secret
from app.models.notification import NotificationChannel, NotificationLog

logger = logging.getLogger("datapilot.notify")

# 各 provider 敏感字段（入库 enc: 加密 / 出参掩码 / 发送时解密）——方案 §2.1（含 webhook_url）
SENSITIVE_FIELDS: dict[str, tuple[str, ...]] = {
    "feishu": ("webhook_url", "secret"),
    "wecom": ("webhook_url",),
    "dingtalk": ("webhook_url", "secret"),
    "email": ("username", "password"),
}

WEBHOOK_PROVIDERS = ("feishu", "wecom", "dingtalk")

_ERR_TRUNCATE = 500
# 每用户保留的发送记录条数（方案 §5.5：发送记录量大，超出删最旧）
LOG_HISTORY_KEEP = 500


def _truncate(text: str) -> str:
    return (text or "").strip()[:_ERR_TRUNCATE]


def _error_text(exc: Exception) -> str:
    """发送失败的可读错误：异常信息为空时给兜底文案（DNS 解析/超时等异常 str 可能为空）。"""
    msg = _truncate(str(exc))
    return msg or "发送失败（网络异常或渠道不可达）"


# ---------- config 辅助（校验 / 加密 / 合并 / 解密 / 掩码） ----------

def validate_config(provider: str, config: dict) -> dict:
    """校验渠道配置（非法抛 ValueError，api 层转 400）。

    存量值跳过校验：掩码（****** = 更新时保留旧值）与已加密密文（enc: 前缀，旧值在
    创建时已校验过），二者均为「无需重新校验」的已存配置。
    """
    cfg = dict(config)
    if provider in WEBHOOK_PROVIDERS:
        url = (cfg.get("webhook_url") or "").strip()
        if url != MASKED and not url.startswith(("enc:", "http://", "https://")):
            raise ValueError("webhook_url 必须为 http(s):// 前缀")
        if provider == "dingtalk" and not (cfg.get("secret") or "").strip():
            raise ValueError("钉钉渠道需要 secret 用于加签")
    elif provider == "email":
        to_list = [str(t).strip() for t in (cfg.get("to") or []) if str(t).strip()]
        if not to_list:
            raise ValueError("邮箱渠道需要至少 1 个收件人")
        if not (cfg.get("smtp_host") or "").strip():
            raise ValueError("邮箱渠道需要 smtp_host")
        if not (cfg.get("from") or "").strip():
            raise ValueError("邮箱渠道需要 from 发件人")
    return cfg


def encrypt_config(provider: str, config: dict) -> dict:
    """入库前加密敏感字段（含 webhook_url，URL 内嵌鉴权 token/key/access_token）。"""
    out = dict(config)
    for field in SENSITIVE_FIELDS.get(provider, ()):
        value = out.get(field)
        if isinstance(value, str) and value:
            out[field] = encrypt_secret(value)
    return out


def merge_config(provider: str, old_config: dict | None, new_config: dict | None) -> dict:
    """更新时合并 config：敏感字段走 upsert_secret（掩码/空=保留旧值），其余整体替换。"""
    old = dict(old_config or {})
    new = dict(new_config or {})
    merged = dict(old)
    for key, value in new.items():
        if key in SENSITIVE_FIELDS.get(provider, ()):
            old_str = merged.get(key) if isinstance(merged.get(key), str) else None
            in_str = value if isinstance(value, str) else None
            merged[key] = upsert_secret(old_str, in_str)
        else:
            merged[key] = value
    return validate_config(provider, merged)


def decrypt_config(provider: str, config: dict) -> dict:
    """解密 config 敏感字段（发送时调用；未加密的存量值原样返回）。"""
    out = dict(config)
    for field in SENSITIVE_FIELDS.get(provider, ()):
        value = out.get(field)
        if isinstance(value, str):
            out[field] = decrypt_secret(value)
    return out


def mask_config(provider: str, config: dict) -> dict:
    """出参掩码敏感字段（对外返回，方案 §2.9）。"""
    out = dict(config)
    for field in SENSITIVE_FIELDS.get(provider, ()):
        if out.get(field):
            out[field] = MASKED
    return out


# ---------- Notifier 抽象与实现 ----------

class Notifier(Protocol):
    async def send(self, cfg: dict, subject: str, body: str) -> None: ...


def _dingtalk_sign(secret: str, ts: str) -> str:
    """钉钉加签：hmac-sha256(timestamp+"\\n"+secret) → base64 → urlencode（方案 §2.7）。"""
    string_to_sign = f"{ts}\n{secret}"
    hmac_code = hmac.new(
        secret.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha256
    ).digest()
    return urllib.parse.quote_plus(base64.b64encode(hmac_code))


class WebhookNotifier:
    """飞书/企微/钉钉 共用 HTTP 骨架（载荷与加签差异在此收敛）。"""

    def __init__(self, provider: str):
        self.provider = provider

    async def send(self, cfg: dict, subject: str, body: str) -> None:
        import httpx

        url = cfg["webhook_url"]
        payload = self._build_payload(body)
        if self.provider == "dingtalk":
            url, payload = self._dingtalk_request(url, cfg, payload)
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.post(url, json=payload)
        resp.raise_for_status()
        data = resp.json()
        # 业务码：wecom/dingtalk 用 errcode，飞书用 code；仅当存在且非 0 视为失败
        errcode = data.get("errcode", 0)
        code = data.get("code", 0) if "code" in data else 0
        if errcode != 0 or code != 0:
            raise ValueError(f"渠道返回错误: {data}")

    def _build_payload(self, body: str) -> dict:
        if self.provider == "feishu":
            return {"msg_type": "text", "content": {"text": body}}
        if self.provider == "wecom":
            return {"msgtype": "markdown", "markdown": {"content": body}}
        return {"msgtype": "text", "text": {"content": body}}  # dingtalk

    def _dingtalk_request(self, url: str, cfg: dict, payload: dict) -> tuple[str, dict]:
        ts = str(round(time.time() * 1000))
        secret = (cfg.get("secret") or "").strip()
        if not secret:
            return url, payload
        sign = _dingtalk_sign(secret, ts)
        sep = "&" if "?" in url else "?"
        return f"{url}{sep}timestamp={ts}&sign={sign}", payload


def _send_email_sync(cfg: dict, subject: str, body: str) -> None:
    """SMTP 发送（同步，调用方包 to_thread）。465→SSL；587 且 use_tls→STARTTLS；否则明文。"""
    import smtplib
    from email.mime.text import MIMEText

    host = cfg["smtp_host"]
    port = int(cfg.get("smtp_port") or 465)
    to_list = [str(t).strip() for t in (cfg.get("to") or []) if str(t).strip()]
    if not to_list:
        raise ValueError("邮箱渠道没有收件人")
    msg = MIMEText(body, "html", "utf-8")
    msg["Subject"] = subject
    msg["From"] = cfg["from"]
    msg["To"] = ", ".join(to_list)
    use_tls = bool(cfg.get("use_tls", True))
    if port == 465:
        server = smtplib.SMTP_SSL(host, port, timeout=15)
    elif use_tls:
        server = smtplib.SMTP(host, port, timeout=15)
        server.starttls()
    else:
        server = smtplib.SMTP(host, port, timeout=15)
    try:
        if cfg.get("username"):
            server.login(cfg["username"], cfg.get("password") or "")
        server.sendmail(cfg["from"], to_list, msg.as_string())
    finally:
        try:
            server.quit()
        except Exception:
            server.close()  # 连接已断开时 quit 会抛，close 兜底


class EmailNotifier:
    async def send(self, cfg: dict, subject: str, body: str) -> None:
        await asyncio.to_thread(_send_email_sync, cfg, subject, body)


# ---------- 服务 ----------

class NotificationService:
    """渠道发送与测试。DB 用 SessionFactory 短会话；发送失败只记 log 不抛给调用方。"""

    async def send_to_channel(
        self, channel_id: UUID | str, subject: str, body: str
    ) -> NotificationLog | None:
        """手动发送（对话主动推送 / 测试等）：渠道不存在返回 None，不受 enabled 影响。

        channel_id 接受 UUID 或字符串（automation.notification 中存的是字符串，方案 §2.1）。
        """
        if isinstance(channel_id, str):
            channel_id = UUID(channel_id)
        async with SessionFactory() as db:
            channel = await db.get(NotificationChannel, channel_id)
            if channel is None:
                return None
            user_id = channel.user_id
            provider = channel.provider
            cfg = decrypt_config(provider, dict(channel.config or {}))
        try:
            await self._dispatch(provider, cfg, subject, body)
            status, error = "success", None
        except Exception as exc:
            logger.warning("通知发送失败 channel=%s: %s", channel_id, _truncate(str(exc)))
            status, error = "failed", _error_text(exc)
        return await self._write_log(user_id, channel_id, subject, body, status, error)

    async def send_automation_alert(
        self, channel_id: UUID | str, subject: str, body: str, *, kind: str
    ) -> NotificationLog | None:
        """自动化运行通知（通知接入，方案 §4.1-4.2）。

        - 渠道不存在 / 已停用 → 静默跳过、不写 notification_logs（方案 §2.9）；
        - kind="failure" 走失败告警频控（方案 §5.5：单渠道 1 条/分钟）。
        """
        if isinstance(channel_id, str):
            channel_id = UUID(channel_id)
        async with SessionFactory() as db:
            channel = await db.get(NotificationChannel, channel_id)
            if channel is None or not channel.enabled:
                return None  # 渠道已删除/已停用：静默跳过
            user_id = channel.user_id
            provider = channel.provider
            cfg = decrypt_config(provider, dict(channel.config or {}))
        if kind == "failure" and not await self._allow_failure_alert(channel_id):
            logger.info("失败告警频控跳过 channel=%s", channel_id)
            return None
        try:
            await self._dispatch(provider, cfg, subject, body)
            status, error = "success", None
        except Exception as exc:
            logger.warning("自动化通知发送失败 channel=%s: %s", channel_id, _truncate(str(exc)))
            status, error = "failed", _error_text(exc)
        return await self._write_log(user_id, channel_id, subject, body, status, error)

    @staticmethod
    async def _write_log(
        user_id, channel_id: UUID, subject: str, body: str, status: str, error: str | None
    ) -> NotificationLog:
        """写发送记录 + 裁剪（方案 §5.5：每用户保留最近 LOG_HISTORY_KEEP 条）。"""
        async with SessionFactory() as db:
            log = NotificationLog(
                user_id=user_id,
                channel_id=channel_id,
                subject=subject,
                body=body,
                attachment_json=None,
                status=status,
                error=error,
            )
            db.add(log)
            await db.commit()
            await db.refresh(log)
            # 写入时顺手清理最旧记录
            old_ids = (
                await db.scalars(
                    select(NotificationLog.id)
                    .where(NotificationLog.user_id == user_id)
                    .order_by(NotificationLog.created_at.desc())
                    .offset(LOG_HISTORY_KEEP)
                )
            ).all()
            if old_ids:
                await db.execute(
                    delete(NotificationLog).where(NotificationLog.id.in_(old_ids))
                )
                await db.commit()
            return log

    @staticmethod
    async def _allow_failure_alert(channel_id: UUID) -> bool:
        """失败告警频控：单渠道每 1 分钟最多 1 条（Redis 固定窗口计数，方案 §5.5）。"""
        from app.core.redis import get_redis

        try:
            redis = await get_redis()
            key = f"notify:freq:{channel_id}:{int(time.time() // 60)}"
            count = await redis.incr(key)
            if count == 1:
                await redis.expire(key, 70)
            return count <= 1
        except Exception:
            return True  # 基础设施不可用降级放行，不阻断告警

    async def test_config(
        self, provider: str, config: dict, subject: str, body: str
    ) -> dict:
        """不落库的连通性测试（建渠道前临时 config 或已有渠道 config 均可）。"""
        cfg = decrypt_config(provider, dict(config))
        try:
            await self._dispatch(provider, cfg, subject, body)
            return {"ok": True, "error": None}
        except Exception as exc:
            logger.warning("渠道测试失败 %s: %s", provider, _truncate(str(exc)))
            return {"ok": False, "error": _error_text(exc)}

    @staticmethod
    async def _dispatch(provider: str, cfg: dict, subject: str, body: str) -> None:
        if provider in WEBHOOK_PROVIDERS:
            await WebhookNotifier(provider).send(cfg, subject, body)
        elif provider == "email":
            await EmailNotifier().send(cfg, subject, body)
        else:
            raise ValueError(f"不支持的渠道类型: {provider}")
