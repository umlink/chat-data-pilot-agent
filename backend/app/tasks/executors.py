"""任务执行器注册表。

执行器签名：`async def (params: dict, ctx: ExecCtx) -> dict`
- ctx.is_cancelled() -> 周期性调用，返回 True 表示已被取消（抛 TaskCancelled 中断）。
- ctx.progress(percent, current_step) -> 推送进度（由 Worker 注入回调：DB progress + Redis 广播）。

M2/M3 将注册：query（Agent 生成/执行）、file_parse（附件解析）等类型。
"""
import asyncio
from typing import Awaitable, Callable

EXECUTORS: dict[str, Callable[[dict, "ExecCtx"], Awaitable[dict]]] = {}

ProgressCb = Callable[[int, "str | None"], Awaitable[None]]


class TaskCancelled(Exception):
    """执行器内部主动放弃（任务被取消）。"""

    pass


class ExecCtx:
    def __init__(
        self,
        task_id: str,
        is_cancelled: Callable[[], Awaitable[bool]] | None = None,
        on_progress: ProgressCb | None = None,
    ):
        self.task_id = task_id
        self._is_cancelled = is_cancelled
        self._on_progress = on_progress

    async def is_cancelled(self) -> bool:
        if self._is_cancelled is None:
            return False
        return await self._is_cancelled()

    async def progress(self, percent: int, current_step: str | None = None) -> None:
        """推进进度；Worker 注入回调后同时落 DB 并广播 SSE。"""
        if self._on_progress is not None:
            await self._on_progress(percent, current_step)


async def _probe(params: dict, ctx: ExecCtx) -> dict:
    """内置自测执行器：按步推进进度，支持取消，验证队列状态机。"""
    steps = max(1, int(params.get("steps", 3)))
    delay = float(params.get("delay", 0.5))
    for i in range(1, steps + 1):
        if await ctx.is_cancelled():
            raise TaskCancelled()
        await ctx.progress(int(i / steps * 100), f"步 {i}/{steps}")
        await asyncio.sleep(delay)
    return {"ok": True, "message": "probe 完成", "steps": steps}


# 注册内置执行器
EXECUTORS["probe"] = _probe


def register_file_parse_executor() -> None:
    """注册附件解析执行器。

    不在模块级调用：attachment_service 顶层依赖本模块的 TaskCancelled，
    模块级注册会形成 attachment_service → executors → attachment_service 循环。
    由 Worker 启动路径（app/tasks/worker.py）显式调用。
    """
    from app.services.attachment_service import file_parse_executor

    EXECUTORS.setdefault("file_parse", file_parse_executor)


def get_executor(task_type: str):
    return EXECUTORS.get(task_type)