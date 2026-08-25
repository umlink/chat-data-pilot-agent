"""任务 Worker：count 路并发循环消费任务表。

消费流程（技术方案 2.4）：领取（原子）→ 调执行器（事务外）→ 成功/失败写终态。
连接策略：每个消费协程持有一条专属长连接（见 queue.py 选型说明），所有队列操作共用，
避免共享连接池在任务间交接连接时的间歇性挂起。
取消支持：执行器周期调用 ctx.is_cancelled()，命中抛 TaskCancelled。
进度推送：DB progress 字段 + Redis Pub/Sub `task:{id}`（供 /tasks/{id}/stream 订阅）。
"""
import asyncio
import json
import logging

from app.core.redis import get_redis
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

    def _publish(self, payload: dict) -> None:
        """后台发布进度，绝不阻塞消费循环；SSE 侧有 DB 兜底刷新，失败可自愈。"""
        asyncio.create_task(self._publish_task(payload))

    async def _publish_task(self, payload: dict) -> None:
        try:
            redis = await get_redis()
            await redis.publish(CHANNEL_PREFIX + payload["task_id"], json.dumps(payload, ensure_ascii=False))
        except Exception as exc:
            logger.warning("任务进度广播失败：%s", exc)

    async def _consume(self) -> None:
        # 每个消费者一条专属长连接（见模块文档）
        conn = await self.queue.connect()
        try:
            while not self._stop.is_set():
                try:
                    task = await self.queue.claim_next(conn)
                except Exception:
                    # DB 瞬断等异常不允许杀死消费协程：记录后短暂退避，并重连
                    logger.exception("领取任务失败，退避重连")
                    try:
                        await conn.close()
                    except Exception:
                        pass
                    await asyncio.sleep(1)
                    try:
                        conn = await self.queue.connect()
                    except Exception:
                        await asyncio.sleep(2)
                    continue
                if task is None:
                    await asyncio.sleep(self.poll_seconds)
                    continue
                task_id = task["id"]
                logger.info("任务开始执行", extra={"task_id": task_id, "type": task["type"]})
                self._publish({"task_id": task_id, "status": "running", "percent": 0})
                executor = get_executor(task["type"])
                if executor is None:
                    await self.queue.mark_failed(conn, task_id, f"未知任务类型: {task['type']}")
                    self._publish({"task_id": task_id, "status": "failed"})
                    continue

                async def on_progress(percent: int, step: str | None, _tid=task_id, _conn=conn) -> None:
                    await self.queue.update_progress(_conn, _tid, percent, step)
                    self._publish({
                        "task_id": _tid, "status": "running",
                        "percent": percent, "current_step": step,
                    })

                ctx = ExecCtx(
                    task_id,
                    is_cancelled=lambda t=task_id: self.queue.is_cancelled(conn, t),
                    on_progress=on_progress,
                )
                try:
                    result = await executor(task["params"] or {}, ctx)
                    await self.queue.mark_success(conn, task_id, result)
                    self._publish({"task_id": task_id, "status": "success", "result": result})
                except TaskCancelled:
                    self._publish({"task_id": task_id, "status": "cancelled"})
                    await self.queue.cancel(conn, task_id)
                except Exception as exc:  # 执行器异常 → 任务 failed（日志记录完整堆栈）
                    logger.exception("任务执行出错", extra={"task_id": task_id, "type": task["type"]})
                    await self.queue.mark_failed(conn, task_id, str(exc))
                    self._publish({"task_id": task_id, "status": "failed", "error": str(exc)})
        finally:
            try:
                await conn.close()
            except Exception:
                pass

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
        logger.info("Worker 已停止")