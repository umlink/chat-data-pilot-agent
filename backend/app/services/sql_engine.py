"""SQL 执行引擎：安全判定 + 执行路由（Agent 工具 run_sql 的后端实现）。

契约见 docs/Block与协议规范.md 4.2 与 docs/技术方案设计.md 2.8：
- 仅单条 SELECT 直接执行；写操作（INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE 等）
  抛 `SqlNeedsConfirmation`，由工具层转换为确认卡片（operation=execute_sql）。
- 表路由：SQL 引用 `att_` 前缀表 → 附件引擎临时 SQLite（data/tmp/{session_id}.db）；
  其余走主数据源（Datasource 解密配置 → 原生驱动：postgresql 用 asyncpg / mysql 用 aiomysql）。
- 行数上限 `max_rows`（对应配置 `system.query.max_query_rows`，默认 1000），
  超出则截断并把 `truncated` 置 True。
- 同步块（sqlite3）用 `asyncio.to_thread`，PG/MySQL 用原生异步驱动，均不阻塞事件循环。
"""
import asyncio
import logging
import re
import sqlite3
import time
from pathlib import Path
from typing import Any

import asyncpg
import sqlparse

from app.core.database import SessionFactory
from app.core.security import decrypt_secret
from app.models.datasource import Datasource

logger = logging.getLogger("datapilot.sql_engine")

_TMP_DIR = Path("data/tmp")

# 写操作关键词 → 风险级别
_WRITE_RISK: dict[str, str] = {
    "INSERT": "medium",
    "UPDATE": "medium",
    "DELETE": "medium",
    "TRUNCATE": "high",
    "DROP": "high",
    "ALTER": "high",
    "CREATE": "high",
    "REPLACE": "high",
    "MERGE": "high",
}
# 单/双引号字符串字面量：剥离后扫描写关键字，避免字符串值内的写词误判
_STRING_LITERAL_RE = re.compile(r"'([^']|'')*'|\"([^\"]|\"\")*\"")
# CTE 内写语句扫描：WITH ... AS (...) SELECT 的 CTE 体内可能内嵌写操作（绕过判定）
_CTE_WRITE_RE = re.compile(r"\b(?:%s)\b" % "|".join(sorted(_WRITE_RISK)), re.IGNORECASE)
# 无法判定/明确禁止的语句
_FORBIDDEN = ("COPY", "CALL", "EXECUTE", "VACUUM", "GRANT", "REVOKE", "ATTACH", "DETACH")

_ATT_TABLE_RE = re.compile(r"\batt_[A-Za-z0-9-]+", re.IGNORECASE)
# SQLite 元数据/发现类语句（附件引擎专用）：AI 用它们列出附件表清单 / 查看表结构
_SQLITE_META_RE = re.compile(r"sqlite_master|\bpragma\b", re.IGNORECASE)
# 连接/执行错误脱敏：dsn/url 可能内嵌密码，回显与日志前掩掉 password=... 段
_PASSWORD_RE = re.compile(r"(?i)(password|passwd|pwd)=([^\s'\"@,]+)")


def _safe_error(exc: BaseException) -> str:
    """异常文本脱敏（掩掉 dsn 内嵌密码）后收敛为可读文案。"""
    msg = str(exc).strip() or "未知错误"
    return _PASSWORD_RE.sub(r"\1=***", msg)


class SqlNeedsConfirmation(Exception):
    """写操作/未知语句被安全策略拦截，需转为确认流程。"""

    def __init__(self, sql: str, operation: str = "execute_sql", risk: str = "medium",
                 reason: str = "", datasource_id: str | None = None):
        self.sql = sql
        self.operation = operation
        self.risk = risk
        self.reason = reason or "检测到写操作或多条语句，执行前需要你确认"
        self.datasource_id = datasource_id
        super().__init__(self.reason)

    def summary(self) -> dict[str, Any]:
        return {
            "operation": self.operation,
            "sql": self.sql,
            "risk_level": self.risk,
            "title": "确认执行 SQL",
            "description": self.reason,
            "datasource_id": self.datasource_id,
        }


class SqlRoutingError(Exception):
    """REST/路由层错误（数据源缺失、附件未解析等），生成用户可读的 error block。"""


def _sql_kind(sql: str) -> tuple[str, str]:
    """判定语句类型：返回 ("select" | "write" | "unsupported", risk)。

    用 sqlparse 归一化后仅取第一个语句；多条语句视为不可信（走确认）。
    """
    sql = sqlparse.format(sql.strip(), strip_comments=True).strip("; ")
    statements = [s for s in sqlparse.split(sql) if s.strip()]
    if len(statements) != 1:
        return "unsupported", "high"
    stmt = statements[0]
    normalized = sqlparse.format(stmt, keyword_case="upper", strip_comments=True).strip()
    first = normalized.split()[0].upper() if normalized else ""
    if first == "SELECT" or first == "WITH":
        if first == "WITH" and "AS" in normalized:
            # CTE：仅看首关键字会把 `WITH cte AS (DELETE ...) SELECT *` 误判为 SELECT，
            # 从而绕过写操作确认。剥离字符串字面量后扫描整条语句的写关键字，命中即按写操作处理。
            if _CTE_WRITE_RE.search(_STRING_LITERAL_RE.sub(" ", normalized)):
                return "write", "medium"
            return "select", "medium"
        return "select", "low"
    if first in _FORBIDDEN:
        return "unsupported", "high"
    if first in _WRITE_RISK:
        return "write", _WRITE_RISK[first]
    return "unsupported", "high"


def _decrypt_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """解密数据源连接配置中的敏感字段（enc: 前缀），返回副本。"""
    out = dict(config or {})
    for key in ("password", "token", "api_key", "secret"):
        value = out.get(key)
        if isinstance(value, str):
            out[key] = decrypt_secret(value)
    return out


def _pg_kwargs(config: dict[str, Any]) -> dict[str, Any]:
    dsn = (config.get("dsn") or config.get("url") or "").strip()
    if dsn:
        return {"dsn": dsn}
    host = (config.get("host") or "localhost").strip()
    port = int(config.get("port") or 5432)
    user = (config.get("user") or config.get("username") or "").strip()
    password = config.get("password") or ""
    database = (config.get("database") or config.get("dbname") or "").strip()
    kwargs: dict[str, Any] = {
        "host": host, "port": port, "user": user, "password": password, "database": database,
    }
    if config.get("ssl") is not None:
        kwargs["ssl"] = config["ssl"]
    return kwargs


def _mysql_kwargs(config: dict[str, Any]) -> dict[str, Any]:
    """从结构化 config 构建 aiomysql.connect 关键字参数（MySQL 无 dsn，取分散字段）。"""
    host = (config.get("host") or "localhost").strip()
    port = int(config.get("port") or 3306)
    user = (config.get("user") or config.get("username") or "").strip()
    password = config.get("password") or ""
    database = (config.get("database") or config.get("db") or "").strip()
    kwargs: dict[str, Any] = {"host": host, "port": port, "user": user, "password": password}
    if database:
        kwargs["db"] = database
    if config.get("ssl") is not None:
        kwargs["ssl"] = config["ssl"]
    return kwargs


def _jsonable(value: Any) -> Any:
    """递归转 JSON 可序列化对象（asyncpg/aiomysql/sqlite 返回的专有类型 → 原生类型）。"""
    import datetime
    import decimal
    import math
    import uuid

    if isinstance(value, float) and not math.isfinite(value):
        return None  # JSONB/JSON 拒绝 NaN/Infinity，归一为 NULL
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (bytes, bytearray)):
        # MySQL BINARY/BLOB 等返回 bytes：优先按 UTF-8 还原，失败退化为 repr
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return repr(bytes(value))
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    return str(value)


def _dtype(value: Any) -> str:
    import datetime
    import decimal

    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float, decimal.Decimal)):
        return "number"
    if isinstance(value, datetime.datetime):
        return "date"
    if isinstance(value, datetime.date):
        return "date"
    return "string"


def _make_table(
    columns: list[str],
    rows: list[dict[str, Any]],
    *,
    total: int,
    truncated: bool,
    query: str,
    duration_ms: int,
) -> dict[str, Any]:
    """把查询结果组装为 TableContent（见 schemas/common.py）。"""
    first = next((r for r in rows if any(r.values())), None)
    dtypes = [_dtype(first.get(c)) if first else "string" for c in columns]
    return {
        "columns": [
            {"key": c, "label": c, "dtype": dtypes[i]} for i, c in enumerate(columns)
        ],
        "rows": rows,
        "total": total,
        "truncated": truncated,
        "query": query,
        # 元数据不入 TableContent（前端/LLM 不需要），由调用方拼接
        "_meta": {"duration_ms": duration_ms, "row_count": len(rows)},
    }


class SqlEngine:
    """SQL 执行引擎。会话级调用，不持有跨请求状态。"""

    def __init__(self):
        self._tmp_dir = _TMP_DIR
        self._tmp_dir.mkdir(parents=True, exist_ok=True)

    # ---------- 入口 ----------
    async def execute(
        self,
        *,
        user_id,
        session_id,
        sql: str,
        datasource_id: str | None = None,
        max_rows: int = 1000,
        allow_write: bool = False,
    ) -> dict[str, Any]:
        """执行 SQL，返回 TableContent 字典（含 _meta.duration_ms）。

        默认：写操作/不可信语句抛 SqlNeedsConfirmation；路由失败抛 SqlRoutingError。
        allow_write=True 仅由确认卡片确认后的执行路径使用（跳过安全拦截）。
        """
        sql = sql.strip()
        if not sql:
            raise SqlRoutingError("SQL 语句为空")
        kind, risk = _sql_kind(sql)
        if not allow_write and (kind == "write" or kind == "unsupported"):
            raise SqlNeedsConfirmation(
                sql, operation="execute_sql", risk=risk, datasource_id=datasource_id,
                reason=("检测到写操作或不可判定的 SQL，执行前需你确认"
                        if kind == "write"
                        else "仅支持单条 SELECT；写操作或多条语句需要确认后执行"),
            )

        started = time.perf_counter()
        # att_ 表 / sqlite 元数据语句 → 附件引擎；其余 → 主数据源
        if _ATT_TABLE_RE.search(sql) or _SQLITE_META_RE.search(sql):
            result = await self._execute_sqlite(str(session_id), sql, max_rows, allow_write)
        else:
            result = await self._execute_main(user_id, sql, datasource_id, max_rows, allow_write)
        duration_ms = int((time.perf_counter() - started) * 1000)
        columns = [c["key"] for c in result["columns"]]
        total = result["total"]
        return _make_table(
            columns, result["rows"],
            total=total, truncated=result["truncated"], query=sql, duration_ms=duration_ms,
        )

    # ---------- 附件引擎路由（att_ 表 → 会话临时 SQLite） ----------
    async def _execute_sqlite(
        self, session_id: str, sql: str, max_rows: int, allow_write: bool = False
    ) -> dict[str, Any]:
        db_path = self._tmp_dir / f"{session_id}.db"
        if not db_path.exists():
            raise SqlRoutingError("当前会话还没有可查询的附件数据，请先上传 csv/xlsx/json 文件")
        return await asyncio.to_thread(self._sqlite_query, db_path, sql, max_rows, allow_write)

    def _sqlite_query(
        self, db_path: Path, sql: str, max_rows: int, allow_write: bool = False
    ) -> dict[str, Any]:
        conn = sqlite3.connect(str(db_path))
        try:
            conn.row_factory = sqlite3.Row
            cur = conn.execute(sql)
            # 非查询语句：确认后执行路径放行并提交，返回影响行数
            if cur.description is None:
                if not allow_write:
                    raise SqlNeedsConfirmation(
                        sql, operation="execute_sql", risk="medium",
                        reason="附件引擎仅允许 SELECT 查询",
                    )
                conn.commit()
                return {
                    "columns": [{"key": "affected_rows", "dtype": "number"}],
                    "rows": [{"affected_rows": conn.total_changes}],
                    "total": 1, "truncated": False,
                }
            cols = [d[0] for d in cur.description]
            records = cur.fetchall()
            rows = [
                {c: _jsonable(rec[c]) for c in cols}
                for rec in records[:max_rows]
            ]
            return {
                "columns": [{"key": c, "dtype": "string"} for c in cols],
                "rows": rows,
                "total": len(records),
                "truncated": len(records) > max_rows,
            }
        finally:
            conn.close()

    # ---------- 主数据源路由（按类型分发：postgresql → asyncpg / mysql → aiomysql） ----------
    async def _find_datasource(self, user_id, datasource_id: str | None) -> Datasource:
        async with SessionFactory() as db:
            if datasource_id:
                ds = await db.get(Datasource, datasource_id)
                if ds is None or ds.user_id != user_id:
                    raise SqlRoutingError("数据源不存在或无权访问")
                return ds
            from sqlalchemy import select

            result = await db.execute(
                select(Datasource)
                .where(Datasource.user_id == user_id)
                .order_by(Datasource.created_at.asc())
                .limit(1)
            )
            ds = result.scalar_one_or_none()
            if ds is None:
                raise SqlRoutingError("尚未配置主数据源，请先在“数据源”页添加连接")
            return ds

    async def _execute_main(
        self, user_id, sql: str, datasource_id: str | None, max_rows: int,
        allow_write: bool = False,
    ) -> dict[str, Any]:
        ds = await self._find_datasource(user_id, datasource_id)
        try:
            cfg = _decrypt_config(ds.config)
        except Exception as exc:
            # 密码为旧密钥加密/密文损坏：给可读提示，引导用户在编辑中重输密码保存
            raise SqlRoutingError(
                "数据源凭据解密失败，请在编辑中重新输入密码保存后再试"
            ) from exc
        if ds.type == "mysql":
            return await self._execute_mysql(cfg, sql, max_rows, allow_write)
        if ds.type == "sqlite":
            raise SqlRoutingError(
                "暂不支持 sqlite 数据源查询，请使用 PostgreSQL/MySQL 数据源或上传附件"
            )
        if ds.type != "postgresql":
            raise SqlRoutingError(f"暂不支持 {ds.type} 数据源查询")
        return await self._execute_pg(cfg, sql, max_rows, allow_write)

    async def _execute_pg(
        self, cfg: dict[str, Any], sql: str, max_rows: int, allow_write: bool
    ) -> dict[str, Any]:
        try:
            conn = await asyncpg.connect(timeout=30, **_pg_kwargs(cfg))
        except Exception as exc:
            raise SqlRoutingError(f"连接数据源失败：{_safe_error(exc)}") from exc
        try:
            if allow_write and _sql_kind(sql)[0] != "select":
                # 确认后的写操作：asyncpg execute 返回如 "UPDATE 5" 的状态串
                status = await conn.execute(sql)
                count = 0
                try:
                    count = int(status.split()[-1])
                except (ValueError, IndexError):
                    pass
                return {
                    "columns": [{"key": "affected_rows", "dtype": "number"}],
                    "rows": [{"affected_rows": count}],
                    "total": 1, "truncated": False,
                }
            stmt = await conn.prepare(sql)
            records = await stmt.fetch(max_rows + 1)
            # 空结果时无 Records 可取列名；仍返回空表（columns=[]）供前端渲染“无数据”
            cols = list(records[0].keys()) if records else []
            rows = [
                {c: _jsonable(rec[c]) for c in cols}
                for rec in records[:max_rows]
            ]
            total = len(records)
            truncated = total > max_rows
            if truncated:
                # 契约 2.3：total 为截断前真实行数；count 包装失败时回退为已取回行数（至少这么多）
                try:
                    total = await conn.fetchval(f"SELECT count(*) FROM ({sql.strip().rstrip(';')}) AS _t")
                except Exception:
                    pass
            return {
                "columns": [{"key": c, "dtype": "string"} for c in cols],
                "rows": rows,
                "total": total,
                "truncated": truncated,
            }
        except SqlNeedsConfirmation:
            raise
        except Exception as exc:
            raise SqlRoutingError(
                f"SQL 执行失败：{_safe_error(exc)}"
            ) from exc
        finally:
            await conn.close()

    async def _execute_mysql(
        self, cfg: dict[str, Any], sql: str, max_rows: int, allow_write: bool
    ) -> dict[str, Any]:
        try:
            import aiomysql
        except ImportError as exc:
            raise SqlRoutingError(
                "MySQL 数据源查询需要 aiomysql，请在 requirements.txt 中新增依赖：aiomysql"
            ) from exc
        try:
            conn = await aiomysql.connect(connect_timeout=30, **_mysql_kwargs(cfg))
        except Exception as exc:
            raise SqlRoutingError(f"连接数据源失败：{_safe_error(exc)}") from exc
        try:
            async with conn.cursor() as cur:
                await cur.execute(sql)
                if cur.description is None:
                    # 无结果集语句（写操作/无返回）：确认路径放行并提交，返回影响行数
                    if not allow_write:
                        raise SqlNeedsConfirmation(
                            sql, operation="execute_sql", risk="medium",
                            reason="MySQL 数据源仅允许 SELECT 查询",
                        )
                    await conn.commit()
                    return {
                        "columns": [{"key": "affected_rows", "dtype": "number"}],
                        "rows": [{"affected_rows": cur.rowcount}],
                        "total": 1, "truncated": False,
                    }
                cols = [d[0] for d in cur.description]
                records = await cur.fetchmany(max_rows + 1)
                rows = [
                    {c: _jsonable(row[i]) for i, c in enumerate(cols)}
                    for row in records[:max_rows]
                ]
                total = len(records)
                truncated = total > max_rows
                if truncated:
                    # 契约 2.3：total 为截断前真实行数；count 包装失败时回退为已取回行数
                    try:
                        await cur.execute(
                            f"SELECT COUNT(*) FROM ({sql.strip().rstrip(';')}) AS _t"
                        )
                        count_row = await cur.fetchone()
                        if count_row is not None:
                            total = count_row[0]
                    except Exception:
                        pass
                return {
                    "columns": [{"key": c, "dtype": "string"} for c in cols],
                    "rows": rows,
                    "total": total,
                    "truncated": truncated,
                }
        except SqlNeedsConfirmation:
            raise
        except Exception as exc:
            raise SqlRoutingError(
                f"SQL 执行失败：{_safe_error(exc)}"
            ) from exc
        finally:
            # aiomysql.close() 为同步方法（asyncpg 才是 async），不可 await
            conn.close()