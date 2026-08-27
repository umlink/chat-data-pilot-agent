"""对象存储服务（MinIO）。附件上传 / 下载 / 清理。

MinIO SDK 是同步的：所有阻塞调用统一经 asyncio.to_thread 下放到线程池，
事件循环只做编排（CLAUDE.md 4.2）。上传侧通过线程安全队列把异步字节流
桥接成 put_object 需要的 read(n) 接口。
"""
import asyncio
import logging
import queue
from collections.abc import AsyncGenerator, Iterable, Iterator

from minio import Minio
from minio.error import S3Error
from urllib3 import PoolManager, Timeout

from app.core.config import settings

logger = logging.getLogger("datapilot.storage")

# 流式上传 / 下载的分块大小
CHUNK_SIZE = 64 * 1024


def build_minio_client() -> Minio:
    if not settings.MINIO_ENDPOINT:
        raise RuntimeError("MINIO_ENDPOINT 未配置")
    client = Minio(
        settings.minio_endpoint_hostport,
        access_key=settings.MINIO_ACCESS_KEY,
        secret_key=settings.MINIO_SECRET_KEY,
        secure=False,  # 内网部署走 HTTP；生产按需改为 secure
        # 连接/读取超时（秒）：minio SDK 无 timeout 构造参数/方法，须经 http_client 注入，
        # 避免 MinIO 挂起时任务长时间阻塞（默认 5 分钟过长）
        http_client=PoolManager(timeout=Timeout(connect=120, read=120), maxsize=10),
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


class _StreamReader:
    """把字节块迭代器适配成 put_object 需要的 read(n) 文件对象接口。"""

    def __init__(self, chunks: Iterable[bytes]) -> None:
        self._chunks: Iterator[bytes] = iter(chunks)
        self._buf = b""

    def read(self, size: int = -1) -> bytes:
        while size < 0 or len(self._buf) < size:
            try:
                self._buf += next(self._chunks)
            except StopIteration:
                break
        if size < 0:
            out, self._buf = self._buf, b""
        else:
            out, self._buf = self._buf[:size], self._buf[size:]
        return out


class StorageService:
    """附件对象的上传 / 下载 / 删除。单实例可复用（MinIO 客户端惰性创建）。"""

    def __init__(self) -> None:
        self._client: Minio | None = None

    @property
    def client(self) -> Minio:
        if self._client is None:
            self._client = build_minio_client()
        return self._client

    async def upload_stream(
        self,
        key: str,
        data_gen: AsyncGenerator[bytes, None],
        length: int,
        content_type: str,
    ) -> None:
        """把异步字节流写入 MinIO。

        生产者（事件循环内消费 data_gen）与消费者（线程池内 put_object）
        经无界线程安全队列桥接；上传上限由调用方（生成器侧）控制，队列不会阻塞。
        """
        q: queue.Queue[bytes | None] = queue.Queue()

        async def _produce() -> None:
            try:
                async for chunk in data_gen:
                    q.put(chunk)
            finally:
                q.put(None)  # 结束哨兵：消费端据此停止读取

        producer = asyncio.create_task(_produce())

        def _chunks() -> Iterator[bytes]:
            while True:
                item = q.get()
                if item is None:
                    return
                yield item

        put_error: BaseException | None = None
        try:
            await asyncio.to_thread(
                self.client.put_object,
                settings.MINIO_BUCKET,
                key,
                _StreamReader(_chunks()),
                length,
                content_type or "application/octet-stream",
            )
        except BaseException as exc:  # noqa: BLE001 统一在下方与生产者异常合并后抛出
            put_error = exc
        # 等待生产者收尾：若数据源自身出错（如超限中断），优先抛业务异常而非上传中断错误
        producer_error: BaseException | None = None
        try:
            await producer
        except BaseException as exc:  # noqa: BLE001 同上，合并决策
            producer_error = exc
        if producer_error is not None:
            raise producer_error
        if put_error is not None:
            raise put_error

    async def download_stream(self, key: str) -> AsyncGenerator[bytes, None]:
        """从 MinIO 流式读取对象内容；对象不存在时抛 S3Error。"""
        response = await asyncio.to_thread(self.client.get_object, settings.MINIO_BUCKET, key)
        try:
            while True:
                chunk = await asyncio.to_thread(response.read, CHUNK_SIZE)
                if not chunk:
                    break
                yield chunk
        finally:
            # urllib3 响应需要显式关闭并归还连接（minio SDK 约定用法）
            await asyncio.to_thread(response.close)
            await asyncio.to_thread(response.release_conn)

    async def remove(self, key: str) -> None:
        try:
            await asyncio.to_thread(self.client.remove_object, settings.MINIO_BUCKET, key)
        except S3Error:
            logger.warning("删除对象失败或不存在", key=key)
