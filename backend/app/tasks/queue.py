"""PostgreSQL 任务队列：FOR UPDATE SKIP LOCKED。
状态机：pending -> running -> success / failed / cancelled。TODO(M1/M5)。
"""
import uuid


class TaskQueue:
    def __init__(self, max_concurrency: int = 3):
        self.max_concurrency = max_concurrency

    async def claim_next(self) -> dict | None:
        """开启事务锁定一个 pending 任务并置为 running（事务外执行）。"""
        raise NotImplementedError("M1")

    async def mark_success(self, task_id, result: dict) -> None:
        raise NotImplementedError("M1")

    async def mark_failed(self, task_id, error: str) -> None:
        raise NotImplementedError("M1")

    async def cancel(self, task_id) -> None:
        raise NotImplementedError("M1")

    async def recover_interrupted(self) -> int:
        """启动恢复：running -> pending（历史遗留）。"""
        raise NotImplementedError("M1")