"""PostgreSQL 任务队列：单条 UPDATE ... RETURNING 配合 FOR UPDATE SKIP LOCKED 原子出队。

状态机：pending -> running -> success / failed / cancelled。
事务边界：出队（claim）在一个短事务内完成提交；任务逻辑在事务外执行；
成功/失败/取消分别写终态并记录 completed_at。
"""
import datetime
import json
import logging
import uuid
from typing import Any

from sqlalchemy import text

from app.core.worker_db import worker_sessionfactory

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


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


class TaskQueue:
    def __init__(self, session_factory=None):
        # 队列会被 Worker 的长驻消费协程使用，必须用独立 NullPool 引擎（见 worker_db）
        self._session_factory = session_factory or worker_sessionfactory

    async def claim_next(self) -> dict[str, Any] | None:
        """原子领取一个 pending 任务并置为 running。无任务返回 None。"""
        async with self._session_factory() as db:
            result = await db.execute(text(CLAIM_SQL))
            row = result.first()
            if row is None:
                return None
            await db.commit()
            return {
                "id": str(row.id),
                "type": row.type,
                "params": row.params or {},
                "session_id": str(row.session_id) if row.session_id else None,
                "created_at": row.created_at,
            }

    async def update_progress(self, task_id: str, percent: int, current_step: str | None = None) -> None:
        async with self._session_factory() as db:
            await db.execute(
                text("UPDATE tasks SET progress=:p, current_step=:s, updated_at=now() WHERE id=:id"),
                {"p": percent, "s": current_step, "id": uuid.UUID(task_id)},
            )
            await db.commit()

    async def mark_success(self, task_id: str, result: dict) -> None:
        # text() 无类型绑定：JSON 必须显式序列化为字符串并用 ::jsonb 强转，否则 asyncpg 报 DataError
        payload = json.dumps(result, ensure_ascii=False)
        async with self._session_factory() as db:
            await db.execute(
                text(
                    "UPDATE tasks SET status='success', result=CAST(:r AS jsonb), completed_at=now(), "
                    "progress=100, updated_at=now() WHERE id=:id AND status='running'"
                ),
                {"r": payload, "id": uuid.UUID(task_id)},
            )
            await db.commit()

    async def mark_failed(self, task_id: str, error: str) -> None:
        async with self._session_factory() as db:
            await db.execute(
                text(
                    "UPDATE tasks SET status='failed', error=:e, completed_at=now(), "
                    "updated_at=now() WHERE id=:id AND status='running'"
                ),
                {"e": error[:2000], "id": uuid.UUID(task_id)},
            )
            await db.commit()

    async def cancel(self, task_id: str) -> None:
        """服务端把任务标记为 cancelled（执行器定期检查该状态中断）。"""
        async with self._session_factory() as db:
            await db.execute(
                text(
                    "UPDATE tasks SET status='cancelled', completed_at=now(), updated_at=now() "
                    "WHERE id=:id AND status IN ('pending','running')"
                ),
                {"id": uuid.UUID(task_id)},
            )
            await db.commit()

    async def recover_interrupted(self) -> int:
        """启动恢复：把超过阈值仍为 running 的任务重置回 pending（可重试）。"""
        threshold_seconds = 300  # M1 固定兜底；后续由 system.task.timeout_seconds 配置驱动
        async with self._session_factory() as db:
            result = await db.execute(
                text(
                    "UPDATE tasks SET status='pending', started_at=NULL, updated_at=now() "
                    "WHERE status='running' AND started_at < now() - make_interval(secs => :t)"
                ),
                {"t": threshold_seconds},
            )
            await db.commit()
            count = result.rowcount if result.rowcount and result.rowcount >= 0 else 0
            if count:
                logger.warning("已恢复 %d 个中断任务为 pending", count)
            return count or 0