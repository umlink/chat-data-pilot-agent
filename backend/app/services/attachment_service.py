"""附件上传与解析引擎（M3）。

管道（docs/Block与协议规范.md 第 5 章）：
上传（流式写 MinIO，见 api/upload.py）-> file_parse 任务（Worker）
-> pandas 解析（CSV / Excel 首 sheet / JSON）-> 类型映射（契约 5.2）
-> 会话级 SQLite（data/tmp/{session_id}.db，表名 att_{attachment_id}）
-> 回填 attachments.parsed_schema。

要点：
- pandas / openpyxl / sqlite3 均为同步重活，一律 asyncio.to_thread 下放线程池；
- 表名 = att_ + 附件 ID 的 hex 形式（去掉连字符），可直接出现在未加引号的 SQL 中；
- 限制：100 万行 / 解析内存 200MB，超限任务 failed 并提示拆分文件（契约 5.3）；
- 列名冲突（SQLite 大小写不敏感）：后出现者加 _2/_3 后缀，parsed_schema 记录原名；
- datetime64 落库为 ISO 8601 TEXT，bool 落库为 0/1 INTEGER。
"""
import asyncio
import csv
import datetime
import io
import json
import logging
import re
import sqlite3
import uuid
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pandas as pd
from minio.error import S3Error
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import SessionFactory
from app.models.datasource import Attachment
from app.models.task import Task
from app.models.user import Session
from app.services.config_service import ConfigService
from app.services.storage_service import StorageService, attachment_key
from app.services.task_service import TaskService
from app.tasks.executors import TaskCancelled

if TYPE_CHECKING:  # 仅类型标注用，避免模块级循环导入
    from app.tasks.executors import ExecCtx

logger = logging.getLogger("datapilot.attachment")

# ---- 限制与常量（契约 5.3 / 技术方案 2.8） ----
MAX_ROWS = 1_000_000  # 单附件最大行数
MAX_PARSE_MEMORY_BYTES = 200 * 1024 * 1024  # 解析内存上限（DataFrame deep 内存）
DOWNLOAD_HARD_CAP_BYTES = 512 * 1024 * 1024  # 下载防御性上限，防止异常超大对象拖垮 Worker
EXPIRE_DAYS = 7  # 附件保留天数
DEFAULT_MAX_SIZE_MB = 20  # 上传大小默认上限（可被 system.upload.max_size_mb 覆盖）
READ_CHUNK = 64 * 1024  # 下载/读取分块

# 扩展名 -> 附件类型（Attachment.file_type，契约 2.10）
EXTENSION_FILE_TYPES: dict[str, str] = {
    ".csv": "csv",
    ".xlsx": "excel",
    ".xls": "excel",
    ".json": "json",
}

# 保守的日期识别：年-月-日 开头（分隔符 - 或 /），可带时间与秒的小数、时区。
# 纯数字（如订单号 20240101）不会被误判。
_DATE_LIKE_RE = re.compile(
    r"^\d{4}[-/]\d{1,2}[-/]\d{1,2}"
    r"([ T]\d{1,2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$"
)
_BOOL_LIKE = {"true", "false"}
# 类型推断的采样行数（超出部分只看样本，保证大文件推断开销可控）
_INFERENCE_SAMPLE = 200


class AttachmentError(Exception):
    """附件业务错误（消息为用户可读中文，status_code 供 API 层转 HTTPException）。"""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


class AttachmentParseError(AttachmentError):
    """解析失败：任务标记 failed，error 即提示信息（契约 5.3）。"""


# ---------- 纯函数（可直接注入 bytes 自测） ----------


def attachment_table_name(attachment_id: str) -> str:
    """att_ + 附件 ID 去连字符的 hex 形式，是合法的未加引号 SQL 表名。"""
    return "att_" + attachment_id.replace("-", "").lower()


def detect_file_type(file_name: str) -> str:
    """按扩展名识别附件类型；不支持的类型抛 AttachmentError。"""
    ext = Path(file_name or "").suffix.lower()
    file_type = EXTENSION_FILE_TYPES.get(ext)
    if file_type is None:
        raise AttachmentError("不支持的文件类型，仅支持 csv / xlsx / xls / json")
    return file_type


def _read_csv_header(data: bytes, encoding: str) -> list[str] | None:
    """读取 CSV 首行原始列名，用于还原 pandas 对重复列的 name.1 改写。"""
    try:
        with io.TextIOWrapper(io.BytesIO(data), encoding=encoding, newline="") as text:
            return next(csv.reader(text), None)
    except (UnicodeDecodeError, csv.Error, ValueError, OSError):
        return None


def _parse_csv(data: bytes) -> pd.DataFrame:
    """CSV 解析：UTF-8（含 BOM）优先，失败回退 GBK；重复列名还原为原始值。"""
    for encoding in ("utf-8-sig", "gbk"):
        try:
            df = pd.read_csv(io.BytesIO(data), encoding=encoding)
        except UnicodeDecodeError:
            continue
        header = _read_csv_header(data, encoding)
        if header is not None and len(header) == len(df.columns):
            # pandas 会把重复列名改写成 name.1，这里按位置还原，冲突处理统一交给 _dedupe_columns
            df.columns = header
        return df
    raise AttachmentParseError("CSV 文件编码无法识别（支持 UTF-8 / GBK），请转存为 UTF-8 后重试")


def _read_excel_header(data: bytes, sheet_name: str | None) -> list[Any] | None:
    """读取 Excel 首 sheet 首行原始列名（尽力而为；失败则保留 pandas 的改写列名）。"""
    try:
        import openpyxl

        workbook = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        try:
            sheet = workbook[sheet_name] if sheet_name else workbook.worksheets[0]
            for row in sheet.iter_rows(min_row=1, max_row=1, values_only=True):
                return list(row)
        finally:
            workbook.close()
    except Exception:  # noqa: BLE001 尽力而为的列名还原，任何失败都不影响解析主流程
        return None
    return None


def _parse_excel(data: bytes) -> tuple[pd.DataFrame, str | None]:
    """Excel 解析：默认第一个 sheet，sheet 名记入 parsed_schema。"""
    try:
        book = pd.ExcelFile(io.BytesIO(data))
        sheet_name = book.sheet_names[0] if book.sheet_names else None
        df = book.parse(sheet_name=0)
    except ImportError as exc:
        raise AttachmentParseError(
            "解析 .xls 老格式需要安装 xlrd 依赖，建议在 Excel 中另存为 .xlsx 后重新上传"
        ) from exc
    header = _read_excel_header(data, sheet_name)
    if header is not None and len(header) == len(df.columns):
        df.columns = header  # 还原重复列名（pandas 改写为 name.1）
    return df, sheet_name


def _looks_like_table(df: pd.DataFrame | None) -> bool:
    """列值均为标量（非 dict/list）才视为解析成功，否则触发结构回退。"""
    if df is None or len(df.columns) == 0:
        return False
    for col in df.columns:
        for value in df[col].head(50).dropna():
            if isinstance(value, (dict, list)):
                return False
    return True


def _parse_json(data: bytes) -> pd.DataFrame:
    """JSON 解析：默认结构 -> records 回退 -> 顶层对象内嵌对象数组（如 {"data":[...]}）展开。"""
    buf = io.BytesIO(data)
    for orient in (None, "records"):
        buf.seek(0)
        try:
            df = pd.read_json(buf) if orient is None else pd.read_json(buf, orient=orient)
        except (ValueError, TypeError):
            continue
        if _looks_like_table(df):
            return df
    # 顶层对象包数组：取第一个「对象数组」字段展开（records 结构的常见包装）
    try:
        obj = json.loads(data.decode("utf-8", errors="strict"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise AttachmentParseError(f"JSON 文件格式非法：{exc}") from exc
    if isinstance(obj, dict):
        for value in obj.values():
            if isinstance(value, list) and value and all(isinstance(i, dict) for i in value[:50]):
                df = pd.json_normalize(value)
                if _looks_like_table(df):
                    return df
    raise AttachmentParseError("JSON 结构无法解析为表格（需要对象数组或「列 -> 值列表」结构）")


def parse_file_bytes(file_type: str, file_name: str, data: bytes) -> tuple[pd.DataFrame, str | None]:
    """按附件类型解析字节流，返回 (DataFrame, sheet_name)。

    空文件 / 无法识别的结构抛 AttachmentParseError（任务 failed）。
    """
    try:
        if file_type == "csv":
            df = _parse_csv(data)
            sheet_name = None
        elif file_type == "excel":
            df, sheet_name = _parse_excel(data)
        elif file_type == "json":
            df = _parse_json(data)
            sheet_name = None
        else:
            raise AttachmentParseError(f"不支持的附件类型: {file_type}")
    except AttachmentError:
        raise
    except Exception as exc:  # noqa: BLE001 pandas/openpyxl 异常统一转为可读错误（堆栈由 Worker 记录）
        raise AttachmentParseError(f"文件解析失败（{file_name}）：{exc}") from exc
    if df is None or df.shape[1] == 0:
        raise AttachmentParseError("文件没有可解析的列，请检查文件内容")
    if df.shape[0] == 0 and df.shape[1] == 0:
        raise AttachmentParseError("文件内容为空，无法解析")
    return df, sheet_name


def _infer_semantic_dtypes(df: pd.DataFrame) -> pd.DataFrame:
    """对文本列做保守的日期 / 布尔推断（全部样本命中才转换，避免误伤编号类文本）。"""
    for col in df.columns:
        series = df[col]
        dtype = series.dtype
        if not (pd.api.types.is_object_dtype(dtype) or pd.api.types.is_string_dtype(dtype)):
            continue
        non_null = series.dropna()
        if non_null.empty:
            continue
        # 混入非字符串值（dict 等）的列不推断
        if not non_null.map(lambda v: isinstance(v, str)).all():
            continue
        sample = [v.strip() for v in non_null.head(_INFERENCE_SAMPLE)]
        non_empty = [v for v in sample if v]
        if not non_empty:
            continue
        # 日期：全部样本形如日期才尝试转换，且要求原有非空值全部转换成功（脏数据防御）
        if all(_DATE_LIKE_RE.match(v) for v in non_empty):
            try:
                converted = pd.to_datetime(series, errors="coerce", format="mixed")
            except (ValueError, TypeError, OverflowError):
                converted = None
            if converted is not None and converted.notna().sum() == series.notna().sum():
                df[col] = converted
                continue
        # 布尔：取值仅 true/false（大小写不敏感）
        if {v.lower() for v in non_empty} <= _BOOL_LIKE:
            df[col] = series.map(
                lambda v: None if pd.isna(v) else str(v).strip().lower() == "true"
            )
    return df


def _clean_column_name(raw: object, index: int) -> str:
    """列名清洗：字符串化并去首尾空白；空值 / NaN / Unnamed 列重命名为 col_N。"""
    name = "" if raw is None else str(raw).strip()
    if not name or name.lower() == "nan" or name.lower().startswith("unnamed:"):
        return f"col_{index + 1}"
    return name


def _column_sqlite_type(dtype: Any, all_null: bool) -> tuple[str, str]:
    """pandas dtype -> (语义 dtype, SQLite 类型)，契约 5.2；全空列回退 string。"""
    if all_null:
        return "string", "TEXT"
    if pd.api.types.is_bool_dtype(dtype):
        return "boolean", "INTEGER"
    if pd.api.types.is_datetime64_any_dtype(dtype):
        return "date", "TEXT"
    if pd.api.types.is_integer_dtype(dtype):
        return "number", "INTEGER"
    if pd.api.types.is_float_dtype(dtype):
        return "number", "REAL"
    return "string", "TEXT"


def _normalize_columns(df: pd.DataFrame) -> tuple[pd.DataFrame, list[dict[str, str]]]:
    """列名清洗 + SQLite 大小写冲突处理（后出现者加 _2/_3 后缀，记录原名）。"""
    used: set[str] = set()
    final_names: list[str] = []
    originals: list[str] = []
    for index, raw in enumerate(df.columns):
        base = _clean_column_name(raw, index)
        name = base
        suffix = 2
        while name.casefold() in used:
            name = f"{base}_{suffix}"
            suffix += 1
        used.add(name.casefold())
        final_names.append(name)
        originals.append("" if raw is None else str(raw))
    df.columns = final_names

    columns: list[dict[str, str]] = []
    for name, original, dtype in zip(final_names, originals, df.dtypes):
        all_null = bool(df[name].isna().all())
        semantic, sqlite_type = _column_sqlite_type(dtype, all_null)
        entry: dict[str, str] = {"name": name, "dtype": semantic, "sqlite_type": sqlite_type}
        if original and original != name:
            entry["original_name"] = original
        columns.append(entry)
    return df, columns


def _prepare_for_sqlite(df: pd.DataFrame) -> pd.DataFrame:
    """落库前的值转换：datetime64 -> ISO 8601 文本，bool -> 0/1（空值保持 NULL）。"""
    for col in df.columns:
        dtype = df[col].dtype
        if pd.api.types.is_datetime64_any_dtype(dtype):
            df[col] = df[col].map(lambda v: v.isoformat() if pd.notna(v) else None)
        elif pd.api.types.is_bool_dtype(dtype):
            df[col] = df[col].map(lambda v: None if pd.isna(v) else int(bool(v)))
    return df


def _enforce_limits(df: pd.DataFrame) -> None:
    """行数 / 解析内存限制（契约 5.3），超限抛 AttachmentParseError 提示拆分文件。"""
    if len(df) > MAX_ROWS:
        raise AttachmentParseError(
            f"文件数据量超出限制：{len(df):,} 行（上限 {MAX_ROWS:,} 行），请拆分文件后重新上传"
        )
    memory = int(df.memory_usage(deep=True).sum())
    if memory > MAX_PARSE_MEMORY_BYTES:
        raise AttachmentParseError(
            f"文件解析内存约 {memory // (1024 * 1024)} MB，超出 "
            f"{MAX_PARSE_MEMORY_BYTES // (1024 * 1024)} MB 上限，请拆分文件后重新上传"
        )


def import_dataframe(
    session_id: str,
    attachment_id: str,
    df: pd.DataFrame,
    sheet_name: str | None = None,
) -> dict[str, Any]:
    """类型映射 + 列名冲突处理 + 写入会话级 SQLite；返回 parsed_schema（就地修改 df）。"""
    table_name = attachment_table_name(attachment_id)
    df, columns = _normalize_columns(df)
    _enforce_limits(df)
    df = _infer_semantic_dtypes(df)
    # 推断可能改变 dtype（如文本 -> 日期），按最终 dtype 重算类型映射
    df, columns = _normalize_columns(df)
    df = _prepare_for_sqlite(df)

    db_path = settings.tmp_dir / f"{session_id}.db"
    sqlite_types = {c["name"]: c["sqlite_type"] for c in columns}
    conn = sqlite3.connect(db_path, timeout=60)  # 长超时：同会话并行解析时串行等待
    try:
        df.to_sql(table_name, conn, if_exists="replace", index=False, dtype=sqlite_types)
        conn.commit()
    finally:
        conn.close()

    parsed_schema: dict[str, Any] = {
        "table_name": table_name,
        "row_count": int(len(df)),
        "columns": columns,
    }
    if sheet_name is not None:
        parsed_schema["sheet_name"] = sheet_name
    return parsed_schema


# ---------- Worker 执行器入口 ----------


async def _download_bytes(storage: StorageService, object_key: str) -> bytes:
    """下载附件对象到内存（原始文件受上传上限约束，另有防御性硬上限）。"""
    chunks: list[bytes] = []
    total = 0
    try:
        async for chunk in storage.download_stream(object_key):
            total += len(chunk)
            if total > DOWNLOAD_HARD_CAP_BYTES:
                raise AttachmentParseError("文件超出可解析大小上限，请拆分后重新上传")
            chunks.append(chunk)
    except S3Error as exc:
        raise AttachmentParseError("附件文件在对象存储中不存在或已被清理，请重新上传") from exc
    return b"".join(chunks)


async def file_parse_executor(params: dict, ctx: "ExecCtx") -> dict:
    """file_parse 执行器：下载 -> 解析 -> 会话级 SQLite 落表 -> 回填 parsed_schema。

    任何异常直接抛出，由 Worker 标记任务 failed 并记录 error（AttachmentParseError
    的消息即用户可读提示）。
    """
    attachment_id = str(params.get("attachment_id") or "")
    if not attachment_id:
        raise AttachmentParseError("任务参数缺少 attachment_id")
    try:
        attachment_uuid = uuid.UUID(attachment_id)
    except ValueError as exc:
        raise AttachmentParseError("附件 ID 非法") from exc

    async with SessionFactory() as db:
        att = await db.get(Attachment, attachment_uuid)
    if att is None:
        raise AttachmentParseError(f"附件记录不存在: {attachment_id}")

    storage = StorageService()
    if await ctx.is_cancelled():
        raise TaskCancelled()

    # 阶段 1：下载
    await ctx.progress(5, "下载文件")
    data = await _download_bytes(storage, att.object_key)
    file_size = len(data)
    if await ctx.is_cancelled():
        raise TaskCancelled()

    # 阶段 2：解析（pandas 重活下放线程池）
    await ctx.progress(25, "解析文件")
    df, sheet_name = await asyncio.to_thread(
        parse_file_bytes, att.file_type, att.file_name, data
    )
    del data
    if await ctx.is_cancelled():
        raise TaskCancelled()

    # 阶段 3：写入会话级 SQLite（表名 att_{attachment_id}）
    await ctx.progress(55, "写入临时数据库")
    session_id = str(att.session_id)
    parsed_schema = await asyncio.to_thread(
        import_dataframe, session_id, attachment_id, df, sheet_name
    )
    if await ctx.is_cancelled():
        raise TaskCancelled()

    # 阶段 4：回填 attachments.parsed_schema
    await ctx.progress(90, "更新附件元数据")
    async with SessionFactory() as db:
        att = await db.get(Attachment, attachment_uuid)
        if att is None:
            raise AttachmentParseError(f"附件记录不存在: {attachment_id}")
        att.parsed_schema = parsed_schema
        await db.commit()

    await ctx.progress(100, "解析完成")
    result: dict[str, Any] = {
        "attachment_id": attachment_id,
        "table_name": parsed_schema["table_name"],
        "row_count": parsed_schema["row_count"],
        "column_count": len(parsed_schema["columns"]),
        "file_size": file_size,
    }
    if sheet_name:
        result["sheet_name"] = sheet_name
    logger.info(
        "附件解析完成",
        extra={
            "attachment_id": attachment_id,
            "table_name": parsed_schema["table_name"],
            "row_count": parsed_schema["row_count"],
        },
    )
    return result


# ---------- 请求路径服务（上传 / 状态查询） ----------


def preview_attachment_table(
    session_id: str,
    table_name: str,
    limit: int = 50,
    cached_row_count: int | None = None,
) -> dict[str, Any]:
    """读取会话级 SQLite 附件表前 limit 行（PRD 3.1.5 附件预览，默认前 50 行）。

    只读连接（mode=ro），表名按白名单校验（必须真实存在于该会话库），
    防止任意字符串注入 SQL。行数优先用 parsed_schema 缓存值（附件表解析后
    不再写入，计数恒定），避免超大附件 COUNT(*) 全表开销。
    返回 {columns, rows, row_count, truncated}。
    """
    db_path = settings.tmp_dir / f"{session_id}.db"
    if not db_path.exists():
        raise AttachmentError("附件临时数据不存在，可能已过期清理", status_code=404)
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=30)
    try:
        found = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = ?", (table_name,)
        ).fetchone()
        if not found:
            raise AttachmentError("附件数据表不存在，可能已移除或过期", status_code=404)
        if cached_row_count is None:
            cached_row_count = conn.execute(f'SELECT COUNT(*) FROM "{table_name}"').fetchone()[0]
        columns = [row[1] for row in conn.execute(f'PRAGMA table_info("{table_name}")').fetchall()]
        rows = conn.execute(f'SELECT * FROM "{table_name}" LIMIT ?', (limit,)).fetchall()
    finally:
        conn.close()
    return {
        "columns": columns,
        "rows": [dict(zip(columns, row)) for row in rows],
        "row_count": cached_row_count,
        "truncated": int(cached_row_count) > limit,
    }


def _safe_object_file_name(file_name: str) -> str:
    """对象键中的文件名只保留安全字符，避免路径分隔符等破坏键结构。"""
    cleaned = re.sub(r"[^\w.\-]", "_", file_name).strip("._")
    return cleaned[:120] or "file"


def _derive_status(attachment: Attachment, task: Task | None) -> tuple[str, str | None]:
    """由 parsed_schema + 最新任务推导附件状态（契约 2.10 attachment.status）。"""
    if attachment.parsed_schema:
        return "ready", None
    if task is None:
        return "uploading", None
    if task.status == "failed":
        return "failed", task.error
    if task.status == "cancelled":
        return "failed", "解析任务已取消，请重试"
    return "parsing", None


class AttachmentService:
    """附件上传与状态查询（请求路径）；解析执行走 file_parse_executor（Worker）。"""

    def __init__(
        self,
        storage: StorageService | None = None,
        tasks: TaskService | None = None,
        config: ConfigService | None = None,
    ) -> None:
        self._storage = storage or StorageService()
        self._tasks = tasks or TaskService()
        self._config = config or ConfigService()

    async def max_upload_bytes(self) -> int:
        """上传大小上限（system.upload.max_size_mb，默认 20MB）。"""
        cfg = await self._config.get("system.upload") or {}
        try:
            mb = int(cfg.get("max_size_mb") or DEFAULT_MAX_SIZE_MB)
        except (TypeError, ValueError):
            mb = DEFAULT_MAX_SIZE_MB
        return max(1, mb) * 1024 * 1024

    async def create_upload(
        self,
        db: AsyncSession,
        session: Session,
        file_name: str,
        content_type: str | None,
        data_gen: AsyncGenerator[bytes, None],
        declared_size: int | None,
    ) -> dict[str, Any]:
        """校验扩展名与大小 -> 流式写 MinIO -> 建 Attachment 记录 -> 创建 file_parse 任务。

        返回 {attachment_id, task_id, ...}；失败抛 AttachmentError（status_code 供 API 层使用）。
        """
        file_type = detect_file_type(file_name)
        max_bytes = await self.max_upload_bytes()
        max_mb = max_bytes // (1024 * 1024)
        over_limit_message = f"文件超过大小限制（{max_mb} MB），请压缩或拆分后上传"
        if declared_size is not None and declared_size > max_bytes:
            raise AttachmentError(over_limit_message, status_code=413)

        async def _capped() -> AsyncGenerator[bytes, None]:
            total = 0
            async for chunk in data_gen:
                total += len(chunk)
                if total > max_bytes:
                    raise AttachmentError(over_limit_message, status_code=413)
                yield chunk

        # 大小未知时（理论上 Starlette 总会给出）先读入内存补齐长度，读取过程仍受上限约束
        if declared_size is None:
            buffered = b""
            async for chunk in _capped():
                buffered += chunk
            declared_size = len(buffered)

            async def _single_chunk() -> AsyncGenerator[bytes, None]:
                yield buffered

            data_gen = _single_chunk()

        attachment_id = uuid.uuid4()
        object_key = attachment_key(
            str(session.id), str(attachment_id), _safe_object_file_name(file_name)
        )
        try:
            await self._storage.upload_stream(
                object_key, _capped(), declared_size, content_type or "application/octet-stream"
            )
        except AttachmentError:
            raise
        except S3Error as exc:
            raise AttachmentError("对象存储上传失败，请稍后重试", status_code=502) from exc
        except Exception as exc:  # noqa: BLE001 网络中断等基础设施异常收敛为可读错误
            raise AttachmentError(f"对象存储上传失败：{exc}", status_code=502) from exc

        attachment = Attachment(
            id=attachment_id,
            session_id=session.id,
            file_name=file_name[:255],
            object_key=object_key,
            file_type=file_type,
            expires_at=datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(days=EXPIRE_DAYS),
        )
        db.add(attachment)
        await db.commit()
        await db.refresh(attachment)

        task = await self._tasks.create(
            type="file_parse",
            session_id=str(session.id),
            params={"attachment_id": str(attachment_id)},
        )
        return {
            "attachment_id": str(attachment.id),
            "task_id": task["id"],
            "file_name": attachment.file_name,
            "file_type": attachment.file_type,
            "object_key": attachment.object_key,
            "created_at": attachment.created_at.isoformat()
            if attachment.created_at
            else None,
            "expires_at": attachment.expires_at.isoformat()
            if attachment.expires_at
            else None,
        }

    async def latest_task(self, db: AsyncSession, attachment_id: str) -> Task | None:
        """按 params.attachment_id 反查最新的 file_parse 任务（重试会产生多条）。"""
        stmt = (
            select(Task)
            .where(
                Task.type == "file_parse",
                Task.params["attachment_id"].as_string() == attachment_id,
            )
            .order_by(Task.created_at.desc())
            .limit(1)
        )
        result = await db.execute(stmt)
        return result.scalars().first()

    async def get_status(self, db: AsyncSession, attachment: Attachment) -> dict[str, Any]:
        """附件状态：记录本身 + 关联任务摘要 + parsed_schema。"""
        task = await self.latest_task(db, str(attachment.id))
        status, error = _derive_status(attachment, task)
        task_brief: dict[str, Any] | None = None
        if task is not None:
            task_brief = {
                "task_id": str(task.id),
                "status": task.status,
                "progress": task.progress or 0,
                "current_step": task.current_step,
                "error": task.error,
                "created_at": task.created_at.isoformat() if task.created_at else None,
                "completed_at": task.completed_at.isoformat()
                if task.completed_at
                else None,
            }
        file_size = None
        if isinstance(task and task.result, dict):
            file_size = task.result.get("file_size")  # type: ignore[union-attr]
        return {
            "attachment_id": str(attachment.id),
            "session_id": str(attachment.session_id),
            "file_name": attachment.file_name,
            "file_type": attachment.file_type,
            "status": status,
            "file_size": file_size,
            "error": error,
            "created_at": attachment.created_at.isoformat()
            if attachment.created_at
            else None,
            "expires_at": attachment.expires_at.isoformat()
            if attachment.expires_at
            else None,
            "parsed_schema": attachment.parsed_schema,
            "task": task_brief,
        }

    async def remove_attachment(self, db: AsyncSession, attachment: Attachment) -> None:
        """移除附件：删 MinIO 对象 + 会话级 SQLite 表 + DB 记录（幂等，任一步失败不阻断）。

        PRD 3.1.5「支持附件移除」。历史消息中的 attachment block 保留但引用失效，
        后续查询会得到表不存在错误，符合「已移除」语义。
        """
        try:
            await self._storage.remove(attachment.object_key)
        except Exception:  # noqa: BLE001 对象已不存在等存储异常不阻断记录删除
            logger.warning(
                "附件对象删除失败（忽略）",
                extra={"resource": f"attachment:{attachment.id}", "action": "delete"},
            )
        table_name = (attachment.parsed_schema or {}).get("table_name")
        if table_name:
            db_path = settings.tmp_dir / f"{attachment.session_id}.db"

            def _drop_table() -> None:
                try:
                    conn = sqlite3.connect(db_path, timeout=30)
                    try:
                        conn.execute(f'DROP TABLE IF EXISTS "{table_name}"')
                        conn.commit()
                    finally:
                        conn.close()
                except sqlite3.Error:
                    logger.warning("附件临时表删除失败（忽略）", extra={"table": table_name})

            await asyncio.to_thread(_drop_table)
        await db.delete(attachment)
        await db.commit()
