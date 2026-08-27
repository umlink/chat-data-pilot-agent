"""DataService：多类型数据源连接测试、Schema 提取、数据预览。

安全约定（CLAUDE.md 4.6）：
- 连接配置中的敏感字段（password/token 等）入库时加密；运行期使用 `decrypt_secret`
  解密后即用即弃（每次调用新建连接），不缓存明文。
- 按 id 取数据源的归属校验由 api 层负责（404），service 只接收已校验的 Datasource 模型。

M3 范围：
- 连接测试：postgresql（asyncpg）、mysql（aiomysql，未安装时给出依赖提示）、
  sqlite（aiosqlite，同上）；文件型（csv/excel/json）返回“需通过附件上传导入”提示。
- Schema 提取与预览：支持 postgresql 与 mysql（information_schema 查询 + 每表 3 行采样），
  其余类型抛 NotImplementedError（清晰中文）。
"""
import json
import logging
import re
from typing import Any

import asyncpg

from app.core.security import decrypt_secret
from app.models.datasource import Datasource
from app.schemas.datasource import FILE_TYPES, SECRET_CONFIG_FIELDS

logger = logging.getLogger("datapilot.data")

# 连接错误脱敏：dsn/url 可能内嵌密码，回显前掩掉 password=... 段，避免凭据泄漏到日志与响应
_PASSWORD_RE = re.compile(r"(?i)(password|passwd|pwd)=([^\s'\"@,]+)")

# 统一连接超时（秒）
CONNECT_TIMEOUT = 10

# Schema 每表采样行数 / 预览默认行数
SAMPLE_ROWS = 3
DEFAULT_PREVIEW_LIMIT = 50

# 元数据 schema 不进 schema 结果
_EXCLUDED_SCHEMAS = ("pg_catalog", "information_schema")


def _jsonable(value: Any) -> Any:
    """把驱动返回的非 JSON 原生值（bytes/datetime/Decimal/UUID 等）归一化为可 JSON 序列化值。"""
    try:
        # allow_nan=False：NaN/Infinity 走 except 兜底为字符串，避免产出非法 JSON
        return json.loads(json.dumps(value, default=str, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError):
        return str(value)


def decrypt_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """解密存储配置中的敏感字段（enc: 前缀密文 → 明文），返回副本，不修改原对象。"""
    out = dict(config or {})
    for key in SECRET_CONFIG_FIELDS:
        value = out.get(key)
        if isinstance(value, str):
            out[key] = decrypt_secret(value)
    return out


def _postgres_kwargs(config: dict[str, Any]) -> dict[str, Any]:
    """从结构化 config 构建 asyncpg.connect 关键字参数（dsn 优先于分散字段）。"""
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
        kwargs["ssl"] = config.get("ssl")
    return kwargs


def _mysql_kwargs(config: dict[str, Any]) -> dict[str, Any]:
    """从结构化 config 构建 aiomysql.connect 关键字参数。"""
    host = (config.get("host") or "localhost").strip()
    port = int(config.get("port") or 3306)
    user = (config.get("user") or config.get("username") or "").strip()
    password = config.get("password") or ""
    database = (config.get("database") or config.get("db") or "").strip()
    kwargs: dict[str, Any] = {"host": host, "port": port, "user": user, "password": password}
    if database:
        kwargs["db"] = database
    if config.get("ssl") is not None:
        kwargs["ssl"] = config.get("ssl")
    return kwargs


def _split_table_arg(table: str) -> tuple[str | None, str]:
    """把 'schema.table' 或 'table' 拆成 (schema, name)。"""
    if "." in table:
        schema, _, name = table.rpartition(".")
        return (schema or None), name
    return None, table


class DataService:
    """数据源服务。单一实例由 api 层持有；依赖（Datasource 模型）由调用方注入。"""

    # ---------- 连接测试 ----------
    async def test_connection(self, ds_type: str, config: dict[str, Any]) -> dict[str, Any]:
        """测试连接连通性。config 为客户端提交的明文配置（不入库）。

        返回 {"ok": bool, "error"?: str, "server_version"?: str}。
        """
        if ds_type in FILE_TYPES:
            return {"ok": False, "error": "文件型数据源请通过附件上传导入"}
        try:
            if ds_type == "postgresql":
                return await self._test_postgresql(config)
            if ds_type == "mysql":
                return await self._test_mysql(config)
            if ds_type == "sqlite":
                return await self._test_sqlite(config)
        except Exception as exc:  # 连接失败 / 参数错误 / 驱动缺失统一收敛为可读错误
            # 裸 TimeoutError 等 str() 为空：兜底用异常类名，保证 last_error 不落空
            msg = _PASSWORD_RE.sub(r"\1=***", str(exc)).strip() or type(exc).__name__
            logger.warning("数据源连接测试失败：type=%s error=%s", ds_type, msg)
            return {"ok": False, "error": msg[:300]}
        return {"ok": False, "error": f"暂不支持的数据源类型: {ds_type}"}

    async def _test_postgresql(self, config: dict[str, Any]) -> dict[str, Any]:
        kwargs = _postgres_kwargs(config)
        conn = await asyncpg.connect(timeout=CONNECT_TIMEOUT, **kwargs)
        try:
            sv = conn.get_server_version()
            return {"ok": True, "server_version": f"{sv[0]}.{sv[1]}.{sv[2]}"}
        finally:
            await conn.close()

    async def _test_mysql(self, config: dict[str, Any]) -> dict[str, Any]:
        try:
            import aiomysql
        except ImportError as exc:
            raise RuntimeError(
                "MySQL 连接测试需要 aiomysql，请在 requirements.txt 中新增依赖：aiomysql"
            ) from exc
        kwargs = _mysql_kwargs(config)
        conn = await aiomysql.connect(connect_timeout=CONNECT_TIMEOUT, **kwargs)
        try:
            async with conn.cursor() as cur:
                await cur.execute("SELECT VERSION()")
                row = await cur.fetchone()
            return {"ok": True, "server_version": (row[0] if row and row[0] else "unknown")}
        finally:
            # aiomysql.close() 为同步方法（asyncpg 才是 async），不可 await
            conn.close()

    async def _test_sqlite(self, config: dict[str, Any]) -> dict[str, Any]:
        try:
            import aiosqlite
        except ImportError as exc:
            raise RuntimeError(
                "SQLite 连接/附件解析需要 aiosqlite，请在 requirements.txt 中新增依赖：aiosqlite"
            ) from exc
        path = (config.get("path") or config.get("database") or "").strip()
        if not path:
            raise ValueError("SQLite 需要配置 path（数据库文件路径）")
        conn = await aiosqlite.connect(path, timeout=CONNECT_TIMEOUT)
        try:
            cur = await conn.execute("SELECT sqlite_version()")
            row = await cur.fetchone()
            await cur.close()
            return {"ok": True, "server_version": (row[0] if row and row[0] else "unknown")}
        finally:
            await conn.close()

    # ---------- Schema 提取 / 预览 ----------
    async def get_schema(self, ds: Datasource) -> dict[str, Any]:
        """提取数据源 schema（每表列名 + 类型 + 注释 + 3 行采样）。归属校验由 api 层完成。

        支持 PostgreSQL / MySQL；其余类型抛 NotImplementedError（清晰中文）。
        """
        if ds.type == "postgresql":
            conn = await asyncpg.connect(
                timeout=CONNECT_TIMEOUT, **_postgres_kwargs(decrypt_config(ds.config))
            )
            try:
                tables = await self._pg_schema(conn)
            finally:
                await conn.close()
            return {"datasource_id": str(ds.id), "datasource_type": ds.type, "tables": tables}
        if ds.type == "mysql":
            return await self._mysql_schema(ds)
        raise NotImplementedError(
            f"暂不支持 {ds.type} 数据源的 Schema 提取，当前支持 PostgreSQL / MySQL"
        )

    async def preview(
        self,
        ds: Datasource,
        table: str | None = None,
        limit: int = DEFAULT_PREVIEW_LIMIT,
    ) -> dict[str, Any]:
        """返回目标表前 N 行数据。table 可带 schema 前缀，缺省取数据库第一张用户表。"""
        if ds.type == "postgresql":
            conn = await asyncpg.connect(
                timeout=CONNECT_TIMEOUT, **_postgres_kwargs(decrypt_config(ds.config))
            )
            try:
                data = await self._pg_preview(conn, table=table, limit=limit)
            finally:
                await conn.close()
            return {"datasource_id": str(ds.id), **data}
        if ds.type == "mysql":
            return await self._mysql_preview(ds, table=table, limit=limit)
        raise NotImplementedError(
            f"暂不支持 {ds.type} 数据源的预览，当前支持 PostgreSQL / MySQL"
        )

    # ---------- PostgreSQL 内部实现 ----------
    async def _pg_schema(self, conn: asyncpg.Connection) -> list[dict[str, Any]]:
        rows = await conn.fetch(
            """
            SELECT
                c.table_schema,
                c.table_name,
                c.column_name,
                c.data_type,
                c.is_nullable,
                COALESCE(pg_catalog.col_description(
                    (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass,
                    c.ordinal_position::int
                ), '') AS column_comment,
                COALESCE(obj_description(
                    (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass
                ), '') AS table_comment
            FROM information_schema.columns AS c
            WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY c.table_schema, c.table_name, c.ordinal_position
            """
        )
        tables: dict[tuple[str, str], dict[str, Any]] = {}
        for row in rows:
            key = (row["table_schema"], row["table_name"])
            table = tables.get(key)
            if table is None:
                table = {
                    "schema": row["table_schema"],
                    "name": row["table_name"],
                    "comment": row["table_comment"] or None,
                    "columns": [],
                }
                tables[key] = table
            table["columns"].append(
                {
                    "name": row["column_name"],
                    "data_type": row["data_type"],
                    "comment": row["column_comment"] or None,
                    "is_nullable": row["is_nullable"] == "YES",
                }
            )
        for table in tables.values():
            table["sample"] = await self._pg_sample(conn, table, limit=SAMPLE_ROWS)
        return list(tables.values())

    async def _pg_sample(
        self, conn: asyncpg.Connection, table: dict[str, Any], limit: int
    ) -> list[dict[str, Any]] | None:
        """每表采样至多 limit 行，按列名对齐 SELECT * 与 information_schema 顺序。"""
        sql = f'SELECT * FROM "{table["schema"]}"."{table["name"]}" LIMIT $1'
        try:
            result = await conn.fetch(sql, limit)
        except Exception as exc:
            logger.debug("采样失败 %s.%s：%s", table["schema"], table["name"], exc)
            return None
        columns = [c["name"] for c in table["columns"]]
        return [
            {columns[i]: _jsonable(rec[i]) for i in range(len(columns))}
            for rec in result
        ]

    async def _pg_preview(
        self, conn: asyncpg.Connection, table: str | None, limit: int
    ) -> dict[str, Any]:
        tables = await conn.fetch(
            """
            SELECT table_schema, table_name
            FROM information_schema.tables
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY table_schema, table_name
            """
        )
        if not tables:
            raise ValueError("数据库中暂无可预览的表")
        if table:
            schema, name = _split_table_arg(table)
            candidates = [
                t for t in tables
                if t["table_name"] == name and (schema is None or t["table_schema"] == schema)
            ]
            if not candidates:
                raise ValueError(f"表不存在: {table}")
            target = candidates[0]
        else:
            target = tables[0]
        schema_name = target["table_schema"]
        table_name = target["table_name"]
        sql = f'SELECT * FROM "{schema_name}"."{table_name}" LIMIT $1'
        stmt = await conn.prepare(sql)
        columns = [c.name for c in stmt.description]
        result = await stmt.fetch(limit)
        col_types = await conn.fetch(
            """
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position
            """,
            schema_name,
            table_name,
        )
        types_map = {r["column_name"]: r["data_type"] for r in col_types}
        rows = [
            {col: _jsonable(rec[idx]) for idx, col in enumerate(columns)}
            for rec in result
        ]
        return {
            "table_schema": schema_name,
            "table": table_name,
            "columns": [{"name": col, "data_type": types_map.get(col, "")} for col in columns],
            "rows": rows,
            "count": len(rows),
            "truncated": len(rows) >= limit,
        }

    # ---------- MySQL 内部实现 ----------
    async def _mysql_conn(self, ds: Datasource):
        """建立 aiomysql 连接（配置已解密）。"""
        import aiomysql

        return await aiomysql.connect(
            connect_timeout=CONNECT_TIMEOUT, **_mysql_kwargs(decrypt_config(ds.config))
        )

    @staticmethod
    def _mysql_quote(name: str) -> str:
        """反引号引用 MySQL 标识符（内部反引号转义为双反引号）。"""
        return "`" + name.replace("`", "``") + "`"

    async def _mysql_schema(self, ds: Datasource) -> dict[str, Any]:
        conn = await self._mysql_conn(ds)
        try:
            dbname = _mysql_kwargs(decrypt_config(ds.config)).get("db") or ""
            if not dbname:
                raise ValueError("MySQL 数据源未配置 database")
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT table_name, table_comment
                       FROM information_schema.tables
                       WHERE table_schema = %s
                       ORDER BY table_name""",
                    (dbname,),
                )
                tables_info = {row[0]: (row[1] or "") for row in await cur.fetchall()}
                await cur.execute(
                    """SELECT table_name, column_name, data_type, is_nullable, column_comment
                       FROM information_schema.columns
                       WHERE table_schema = %s
                       ORDER BY table_name, ordinal_position""",
                    (dbname,),
                )
                tables: dict[str, dict[str, Any]] = {}
                for tname, cname, dtype, nullable, comment in await cur.fetchall():
                    table = tables.get(tname)
                    if table is None:
                        table = {
                            "schema": dbname,
                            "name": tname,
                            "comment": tables_info.get(tname) or None,
                            "columns": [],
                        }
                        tables[tname] = table
                    table["columns"].append(
                        {
                            "name": cname,
                            "data_type": dtype,
                            "comment": comment or None,
                            "is_nullable": nullable == "YES",
                        }
                    )
            for table in tables.values():
                table["sample"] = await self._mysql_sample(conn, table, limit=SAMPLE_ROWS)
        finally:
            conn.close()
        return {
            "datasource_id": str(ds.id),
            "datasource_type": ds.type,
            "tables": list(tables.values()),
        }

    async def _mysql_sample(
        self, conn, table: dict[str, Any], limit: int
    ) -> list[dict[str, Any]] | None:
        """每表采样至多 limit 行（列名对齐 SELECT * 与 information_schema 顺序）。"""
        quoted = f"{self._mysql_quote(table['schema'])}.{self._mysql_quote(table['name'])}"
        try:
            async with conn.cursor() as cur:
                await cur.execute(f"SELECT * FROM {quoted} LIMIT {int(limit)}")
                cols = [d[0] for d in cur.description]
                records = await cur.fetchall()
            return [
                {cols[i]: _jsonable(row[i]) for i in range(len(cols))}
                for row in records[:limit]
            ]
        except Exception as exc:
            logger.debug("MySQL 采样失败 %s.%s：%s", table["schema"], table["name"], exc)
            return None

    async def _mysql_preview(
        self, ds: Datasource, table: str | None, limit: int
    ) -> dict[str, Any]:
        conn = await self._mysql_conn(ds)
        try:
            dbname = _mysql_kwargs(decrypt_config(ds.config)).get("db") or ""
            if not dbname:
                raise ValueError("MySQL 数据源未配置 database")
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT table_name
                       FROM information_schema.tables
                       WHERE table_schema = %s
                       ORDER BY table_name""",
                    (dbname,),
                )
                tables = [row[0] for row in await cur.fetchall()]
            if not tables:
                raise ValueError("数据库中暂无可预览的表")
            target = table or tables[0]
            if table:
                if "." in table:
                    schema, _, name = table.rpartition(".")
                    candidates = [t for t in tables if t == name and schema == dbname]
                else:
                    candidates = [t for t in tables if t == table]
                if not candidates:
                    raise ValueError(f"表不存在: {table}")
                target = candidates[0]
            quoted = self._mysql_quote(target)
            async with conn.cursor() as cur:
                await cur.execute(f"SELECT * FROM {quoted} LIMIT {int(limit)}")
                cols = [d[0] for d in cur.description]
                records = await cur.fetchall()
                await cur.execute(
                    """SELECT column_name, data_type
                       FROM information_schema.columns
                       WHERE table_schema = %s AND table_name = %s
                       ORDER BY ordinal_position""",
                    (dbname, target),
                )
                types_map = {row[0]: row[1] for row in await cur.fetchall()}
            rows = [
                {col: _jsonable(rec[idx]) for idx, col in enumerate(cols)}
                for rec in records
            ]
            return {
                "table_schema": dbname,
                "table": target,
                "columns": [{"name": col, "data_type": types_map.get(col, "")} for col in cols],
                "rows": rows,
                "count": len(rows),
                "truncated": len(rows) >= limit,
            }
        finally:
            conn.close()