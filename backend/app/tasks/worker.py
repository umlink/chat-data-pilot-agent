"""任务 Worker：count 路并发循环消费任务表。

消费流程（技术方案 2.4）：
  领取（原子）→ 调执行器（事务外）→ 成功/失败写终态。
取消支持：执行器通过 ctx.is_cancelled() 周期性检查，命中则抛 TaskCancelled。
进度推送：DB progress 字段 + Redis Pub/Sub `task:{id}`（供 /tasks/{id}/stream 订阅）。
"""
import asyncio
import json
import logging
import uuid

from app.core.redis import get_redis
from app.core.worker_db import dispose_worker_engine
from app.models.task import Task
from app.tasks.executors import ExecCtx, TaskCancelled, get_executor
from app.tasks.queue import TaskQueue

logger = logging.getLogger("datapilot.worker")

CHANNEL_PREFIX = "task:"


class Worker:
    def __init__(self, queue: TaskQueue | None = None, count: int = 3, poll_seconds: float = 0.5):
        self.queue = queue or TaskQueue()
        self.count = count
        self.poll_seconds = poll_seconds
        self._tasks: list[asyncio.Task] = []
        self._stop = asyncio.Event()

    async def _is_cancelled(self, task_id: str) -> bool:
        # 从内存快速路径（后续可达）：直接查 DB，简单可靠
        async with self.queue._session_factory() as db:
            t = await db.get(Task, uuid.UUID(task_id))
            return bool(t and t.status == "cancelled")

    async def _publish(self, payload: dict) -> None:
        try:
            redis = await get_redis()
            await redis.publish(CHANNEL_PREFIX + payload["task_id"], json.dumps(payload, ensure_ascii=False))
        except Exception as exc:
            logger.warning("任务进度广播失败：%s", exc)

    async def _consume(self) -> None:
        while not self._stop.is_set():
            try:
                task = await self.queue.claim_next()
            except Exception:
                # DB 瞬断等异常不允许杀死消费协程：记录后短暂退避重试
                logger.exception("领取任务失败，退避重试")
                await asyncio.sleep(1)
                continue
            if task is None:
                await asyncio.sleep(self.poll_seconds)
                continue
            task_id = task["id"]
            logger.info("任务开始执行", task_id=task_id, type=task["type"])
            await self._publish({"task_id": task_id, "status": "running", "percent": 0})
            executor = get_executor(task["type"])
            if executor is None:
                await self.queue.mark_failed(task_id, f"未知任务类型: {task['type']}")
                await self._publish({"task_id": task_id, "status": "failed"})
                continue
            ctx = ExecCtx(task_id, is_cancelled=lambda t=task_id: self._is_cancelled(t))
            try:
                result = await executor(task["params"] or {}, ctx)
                await self.queue.mark_success(task_id, result)
                await self._publish({"task_id": task_id, "status": "success", "result": result})
            except TaskCancelled:
                await self.queue.cancel(task_id)
                await self._publish({"task_id": task_id, "status": "cancelled"})
            except Exception as exc:  # 执行器异常 → 任务 failed（日志记录完整堆栈）
                logger.exception("任务执行出错", task_id=task_id, type=task["type"])
                await self.queue.mark_failed(task_id, str(exc))
                await self._publish({"task_id": task_id, "status": "failed", "error": str(exc)})

    async def start(self) -> None:
        recovered = await self.queue.recover_interrupted()
        if recovered:
            logger.info("启动时恢复 %d 个中断任务", recovered)
        self._stop.clear()
        for i in range(self.count):
            self._tasks.append(asyncio.create_task(self._consume(), name=f"worker-{i}"))
        logger.info("Worker 已启动，并发数=%d", self.count)

    async def stop(self) -> None:
        self._stop.set()
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        await dispose_worker_engine()
        logger.info("Worker 已停止")