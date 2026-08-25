"""应用配置（Pydantic Settings）。

读取顺序：
1. 环境变量
2. .env 文件（backend/.env 或项目根 .env）

基础设施（PostgreSQL / Redis / MinIO）均使用远程实例，连接信息来自根目录 .env。
"""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ---- 基础设施（远程） ----
    PG_HOST: str = "localhost"
    PG_PORT: int = 5432
    PG_DB: str = "datapilot"
    PG_USER: str = "datapilot"
    PG_PASSWORD: str = ""
    DATABASE_URL: str | None = None  # 显式覆盖时优先

    REDIS_HOST: str = "localhost"
    REDIS_PORT: int = 6379
    REDIS_PASSWORD: str = ""
    REDIS_URL: str | None = None

    MINIO_ENDPOINT: str = ""
    MINIO_ACCESS_KEY: str = ""
    MINIO_SECRET_KEY: str = ""
    MINIO_BUCKET: str = "datapilot"

    # ---- 应用 ----
    SECRET_KEY: str = "change-me-in-prod"
    ENCRYPTION_KEY: str = ""  # Fernet 密钥；未设置时自动生成并持久化到 data/ 下
    ENABLE_AUTH: bool = True
    APP_DATA_DIR: str = "./data"
    AUTO_CREATE_TABLES: bool = True  # 开发期自动建表；迁移切换为 Alembic
    CORS_ORIGINS: list[str] = [
        "http://localhost:5173",
        "http://localhost:4173",
        "http://localhost:8080",
        "http://localhost:80",
    ]

    # ---- 派生连接串 ----
    @property
    def db_url(self) -> str:
        if self.DATABASE_URL:
            return self.DATABASE_URL
        return (
            f"postgresql+asyncpg://{self.PG_USER}:{self.PG_PASSWORD}"
            f"@{self.PG_HOST}:{self.PG_PORT}/{self.PG_DB}"
        )

    @property
    def redis_url(self) -> str:
        if self.REDIS_URL:
            return self.REDIS_URL
        auth = f":{self.REDIS_PASSWORD}@" if self.REDIS_PASSWORD else ""
        return f"redis://{auth}{self.REDIS_HOST}:{self.REDIS_PORT}/0"

    @property
    def minio_endpoint_hostport(self) -> str:
        """MinIO Python 客户端需要 host:port（无 scheme）。"""
        if "://" in self.MINIO_ENDPOINT:
            return self.MINIO_ENDPOINT.split("://", 1)[1]
        return self.MINIO_ENDPOINT

    @property
    def data_dir(self) -> Path:
        p = Path(self.APP_DATA_DIR).resolve()
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def tmp_dir(self) -> Path:
        """会话级附件 SQLite 临时库目录。"""
        p = self.data_dir / "tmp"
        p.mkdir(parents=True, exist_ok=True)
        return p


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()