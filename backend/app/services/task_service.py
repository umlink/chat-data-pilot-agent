"""TaskService：任务创建、状态机、进度推送。
队列实现见 app/tasks（PostgreSQL SKIP LOCKED）。TODO(M1/M5)。
"""


class TaskService:
    async def create(self, *, type: str, session_id=None, params: dict) -> dict:
        raise NotImplementedError("M1")

    async def get(self, task_id: str) -> dict:
        raise NotImplementedError("M1")

    async def cancel(self, task_id: str) -> dict:
        raise NotImplementedError("M1")