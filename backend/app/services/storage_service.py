"""对象存储服务（MinIO）。附件上传 / 下载 / 清理。"""
import logging
from typing import AsyncGenerator

from minio import Minio
from minio.error import S3Error

from app.core.config import settings

logger = logging.getLogger("datapilot.storage")


def build_minio_client() -> Minio:
    if not settings.MINIO_ENDPOINT:
        raise RuntimeError("MINIO_ENDPOINT 未配置")
    client = Minio(
        settings.minio_endpoint_hostport,
        access_key=settings.MINIO_ACCESS_KEY,
        secret_key=settings.MINIO_SECRET_KEY,
        secure=False,  # 内网部署走 HTTP；生产按需改为 secure
    )
    return client


def ensure_bucket() -> bool:
    try:
        client = build_minio_client()
        if not client.bucket_exists(settings.MINIO_BUCKET):
            client.make_bucket(settings.MINIO_BUCKET)
            logger.info("MinIO bucket created", bucket=settings.MINIO_BUCKET)
        return True
    except Exception as exc:  # noqa: BLE001 基础设施不可用时降级启动
        logger.warning("MinIO 不可用：%s", exc)
        return False


def attachment_key(session_id: str, attachment_id: str, file_name: str) -> str:
    return f"attachments/{session_id}/{attachment_id}/{file_name}"


class StorageService:
    """附件上传下载。M1 实现（整流式写入/读取、过期清理）。"""

    def __init__(self) -> None:
        self._client: Minio | None = None

    @property
    def client(self) -> Minio:
        if self._client is None:
            self._client = build_minio_client()
        return self._client

    async def upload_stream(self, key: str, data_gen: AsyncGenerator[bytes, None], length: int, content_type: str) -> None:
        raise NotImplementedError("M1")

    async def download_stream(self, key: str) -> AsyncGenerator[bytes, None]:
        raise NotImplementedError("M1")

    async def remove(self, key: str) -> None:
        try:
            self.client.remove_object(settings.MINIO_BUCKET, key)
        except S3Error:
            logger.warning("删除对象失败或不存在", key=key)