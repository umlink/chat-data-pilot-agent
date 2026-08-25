"""TaskService：任务创建、状态查询、取消。队列并发出队见 app/tasks。

任务状态机：pending -> running -> success / failed / cancelled。
"""
import datetime
import uuid
from typing import Any

from sqlalchemy import select

from app.core.database import SessionFactory
from app.models.task import Task


def _snapshot(t: Task) -> dict[str, Any]:
    return {
        "id": str(t.id),
        "session_id": str(t.session_id) if t.session_id else None,
        "type": t.type,
        "status": t.status,
        "params": t.params or {},
        "result": t.result,
        "error": t.error,
        "progress": t.progress,
        "current_step": t.current_step,
        "retry_count": t.retry_count,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
        "started_at": t.started_at.isoformat() if t.started_at else None,
        "completed_at": t.completed_at.isoformat() if t.completed_at else None,
    }


class TaskService:
    async def create(self, *, type: str, session_id: str | None = None, params: dict | None = None) -> dict:
        async with SessionFactory() as db:
            t = Task(
                type=type,
                session_id=uuid.UUID(session_id) if session_id else None,
                params=params or {},
            )
            db.add(t)
            await db.commit()
            await db.refresh(t)
            return _snapshot(t)

    async def get(self, task_id: str) -> dict:
        try:
            tid = uuid.UUID(task_id)
        except ValueError:
            raise KeyError("任务 ID 非法")
        async with SessionFactory() as db:
            t = await db.get(Task, tid)
            if t is None:
                raise KeyError("任务不存在")
            return _snapshot(t)

    async def cancel(self, task_id: str) -> dict:
        try:
            tid = uuid.UUID(task_id)
        except ValueError:
            raise KeyError("任务 ID 非法")
        async with SessionFactory() as db:
            t = await db.get(Task, tid)
            if t is None:
                raise KeyError("任务不存在")
            if t.status in ("success", "failed", "cancelled"):
                return _snapshot(t)  # 终态不可再取消
            t.status = "cancelled"
            t.completed_at = datetime.datetime.now(datetime.timezone.utc)
            await db.commit()
            await db.refresh(t)
            return _snapshot(t)