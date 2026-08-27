"""任务 API。
- GET /api/tasks/{id}            任务状态快照
- POST /api/tasks/{id}/cancel    取消任务（pending/running）
- GET /api/tasks/{id}/stream     SSE 订阅任务进度（task_status 事件，15s 心跳）
"""
import asyncio
import json
import logging
from time import monotonic
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from app.api.deps import get_current_user
from app.core.redis import get_redis
from app.models.user import User
from app.schemas.common import ApiResponse
from app.services.task_service import TaskService
from app.tasks.worker import CHANNEL_PREFIX

router = APIRouter(prefix="/tasks", tags=["tasks"])

logger = logging.getLogger("datapilot.tasks")

_task_service = TaskService()

TERMINAL = {"success", "failed", "cancelled"}
HEARTBEAT_SECONDS = 15


def _sse(event: str, seq: int, data: dict) -> str:
    return f"event: {event}\nid: {seq}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _task_event(snapshot: dict) -> dict:
    return {
        "task_id": snapshot["id"],
        "status": snapshot["status"],
        "percent": snapshot["progress"],
        "current_step": snapshot["current_step"],
        "error": snapshot.get("error"),
        "result": snapshot.get("result"),
    }


async def _event_generator(task_id: str, user_id: str):
    redis = await get_redis()
    pubsub = redis.pubsub()
    await pubsub.subscribe(CHANNEL_PREFIX + task_id)
    seq = 0
    last_ping = monotonic()
    refreshed = 0
    try:
        # 先发当前快照，避免错过订阅前的终态
        try:
            snap = await _task_service.get(task_id, user_id)
        except KeyError:
            return
        seq += 1
        yield _sse("task_status", seq, _task_event(snap))
        if snap["status"] in TERMINAL:
            return
        while True:
            msg = await pubsub.get_message(ignore_subscribe_messages=True)
            if msg is not None and msg.get("type") == "message":
                payload = json.loads(msg["data"])
                seq += 1
                yield _sse("task_status", seq, payload)
                if payload.get("status") in TERMINAL:
                    return
            else:
                # 心跳 + DB 状态兜底刷新（每 20 轮约 5s）
                if monotonic() - last_ping >= HEARTBEAT_SECONDS:
                    yield ": ping\n\n"
                    last_ping = monotonic()
                refreshed += 1
                if refreshed % 20 == 0:
                    snap = await _task_service.get(task_id, user_id)
                    if snap["status"] in TERMINAL:
                        seq += 1
                        yield _sse("task_status", seq, _task_event(snap))
                        return
                await asyncio.sleep(0.25)
    finally:
        await pubsub.unsubscribe(CHANNEL_PREFIX + task_id)
        await pubsub.aclose()


@router.get("/{task_id}", response_model=ApiResponse[dict])
async def get_task(task_id: str, user: Annotated[User, Depends(get_current_user)]):
    try:
        snap = await _task_service.get(task_id, str(user.id))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return ApiResponse(data=snap)


@router.post("/{task_id}/cancel", response_model=ApiResponse[dict])
async def cancel_task(
    task_id: str,
    user: Annotated[User, Depends(get_current_user)],
):
    try:
        snap = await _task_service.cancel(task_id, str(user.id))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return ApiResponse(data=snap, message="取消已提交")


@router.get("/{task_id}/stream", include_in_schema=False)
async def stream_task(task_id: str, user: Annotated[User, Depends(get_current_user)]):
    try:
        await _task_service.get(task_id, str(user.id))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return StreamingResponse(
        _event_generator(task_id, str(user.id)),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )