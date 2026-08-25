"""PostgreSQL 任务队列（原生 asyncpg）。

选型原因：SQLAlchemy+asyncpg 的 greenlet 机制在多个长驻消费协程下会死锁；
asyncpg 连接自身任务安全。每个 Worker 消费协程持有**一条长连接**（由 Worker 传入），
避免共享连接池在任务间交接连接时的间歇性挂起。

状态机：pending -> running -> success / failed / cancelled。
出队：单条 UPDATE ... RETURNING 配合 FOR UPDATE SKIP LOCKED 原子领取。
"""
import json
import logging
from typing import Any
from urllib.parse import quote

import asyncpg

from app.core.config import settings

logger = logging.getLogger("datapilot.queue")

CLAIM_SQL = """
UPDATE tasks
SET status = 'running',
    started_at = now(),
    updated_at = now()
WHERE id = (
    SELECT id FROM tasks
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
RETURNING id, type, params, session_id, created_at
"""


def _asyncpg_dsn() -> str:
    if settings.DATABASE_URL:
        return settings.DATABASE_URL.replace("+asyncpg", "")
    pwd = quote(settings.PG_PASSWORD or "", safe="")
    return (
        f"postgresql://{settings.PG_USER}:{pwd}"
        f"@{settings.PG_HOST}:{settings.PG_PORT}/{settings.PG_DB}"
    )


async def _setup_json_codec(conn: asyncpg.Connection) -> None:
    """让 jsonb 列以 Python dict/list 往返，而非原始字符串。"""
    await conn.set_type_codec(
        "jsonb",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )


class TaskQueue:
    """任务队列表操作。所有方法接收消费协程自己的长连接 conn（管理类操作用临时连接）。"""

    async def connect(self) -> asyncpg.Connection:
        """供 Worker 消费协程获取一条专属长连接（jsonb 自动编解码为 dict）。"""
        conn = await asyncpg.connect(_asyncpg_dsn())
        await _setup_json_codec(conn)
        return conn

    async def claim_next(self, conn: asyncpg.Connection) -> dict[str, Any] | None:
        """在给定长连接上原子领取一个 pending 任务并置为 running。无任务返回 None。"""
        row = await conn.fetchrow(CLAIM_SQL)
        if row is None:
            return None
        return {
            "id": str(row["id"]),
            "type": row["type"],
            "params": row["params"] or {},
            "session_id": str(row["session_id"]) if row["session_id"] else None,
            "created_at": row["created_at"],
        }

    async def update_progress(
        self, conn: asyncpg.Connection, task_id: str, percent: int, current_step: str | None = None
    ) -> None:
        await conn.execute(
            "UPDATE tasks SET progress=$1, current_step=$2, updated_at=now() WHERE id=$3::uuid",
            percent, current_step, task_id,
        )

    async def mark_success(self, conn: asyncpg.Connection, task_id: str, result: dict) -> None:
        # 连接已注册 jsonb codec：直接传 dict，由 codec 序列化
        await conn.execute(
            "UPDATE tasks SET status='success', result=$1, completed_at=now(), "
            "progress=100, updated_at=now() WHERE id=$2::uuid AND status='running'",
            result, task_id,
        )

    async def mark_failed(self, conn: asyncpg.Connection, task_id: str, error: str) -> None:
        await conn.execute(
            "UPDATE tasks SET status='failed', error=$1, completed_at=now(), "
            "updated_at=now() WHERE id=$2::uuid AND status='running'",
            error[:2000], task_id,
        )

    async def cancel(self, conn: asyncpg.Connection, task_id: str) -> None:
        """把 pending/running 任务标记为 cancelled（执行器周期检查该状态中断）。"""
        await conn.execute(
            "UPDATE tasks SET status='cancelled', completed_at=now(), updated_at=now() "
            "WHERE id=$1::uuid AND status IN ('pending','running')",
            task_id,
        )

    async def is_cancelled(self, conn: asyncpg.Connection, task_id: str) -> bool:
        status = await conn.fetchval("SELECT status FROM tasks WHERE id=$1::uuid", task_id)
        return status == "cancelled"

    async def recover_interrupted(self) -> int:
        """启动恢复：把超过阈值仍为 running 的任务重置回 pending（可重试）。用临时连接。"""
        threshold_seconds = 300
        conn = await asyncpg.connect(_asyncpg_dsn())
        try:
            result = await conn.execute(
                "UPDATE tasks SET status='pending', started_at=NULL, updated_at=now() "
                "WHERE status='running' AND started_at < now() - make_interval(secs => $1)",
                threshold_seconds,
            )
            count = int(result.split()[-1])
            if count:
                logger.warning("已恢复 %d 个中断任务为 pending", count)
            return count
        finally:
            await conn.close()