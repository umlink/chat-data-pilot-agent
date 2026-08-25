"""安全模块：密码哈希、JWT、Fernet 敏感字段加密。

约定：
- ENCRYPTION_KEY 未设置时自动生成 Fernet 密钥并持久化到 data/encryption_key（0600）。
- 编码存储值统一加 "enc:" 前缀，便于与未加密数据区分。
"""
import os
from datetime import datetime, timedelta, timezone

import bcrypt
from cryptography.fernet import Fernet
from jose import JWTError, jwt

from .config import settings

ALGORITHM = "HS256"
ENCRYPT_PREFIX = "enc:"
MASKED = "******"
ACCESS_TOKEN_EXPIRE_MINUTES = 24 * 60


# ---------- 密码 ----------
def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


# ---------- JWT ----------
def create_access_token(subject: str, expires_minutes: int = ACCESS_TOKEN_EXPIRE_MINUTES) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=expires_minutes)
    payload = {"sub": subject, "exp": expire}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None


# ---------- Fernet 敏感字段加密 ----------
_fernet: Fernet | None = None


def _load_or_create_key() -> bytes:
    env_key = (settings.ENCRYPTION_KEY or "").strip()
    if env_key:
        return env_key.encode("utf-8")
    key_path = settings.data_dir / "encryption_key"
    if key_path.exists():
        return key_path.read_bytes().strip()
    key = Fernet.generate_key()
    fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, key)
    finally:
        os.close(fd)
    return key


def get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_load_or_create_key())
    return _fernet


def encrypt_secret(plain: str | None) -> str | None:
    if not plain:
        return plain
    return ENCRYPT_PREFIX + get_fernet().encrypt(plain.encode("utf-8")).decode("utf-8")


def decrypt_secret(value: str | None) -> str | None:
    if not value:
        return value
    if value.startswith(ENCRYPT_PREFIX):
        return get_fernet().decrypt(value[len(ENCRYPT_PREFIX):].encode("utf-8")).decode("utf-8")
    return value  # 未加密的存量数据


def is_masked(value: str | None) -> bool:
    return value == MASKED


def upsert_secret(old_stored: str | None, incoming: str | None) -> str | None:
    """前端更新时调用：传入掩码则保留旧密文，传新值则加密存储。"""
    if is_masked(incoming):
        return old_stored
    if incoming == "" or incoming is None:
        return incoming
    return encrypt_secret(incoming)