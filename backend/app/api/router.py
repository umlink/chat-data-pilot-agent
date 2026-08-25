"""API 路由汇总。

各子路由文件在对应里程碑填充实现（现阶段为占位）。最终每个模块返回：
  {"code": 0, "data": ..., "message": "ok"}
"""
from fastapi import APIRouter

from app.api import (
    auth,
    chat,
    config,
    datasources,
    export,
    logs,
    sessions,
    tasks,
    templates,
    upload,
)

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(sessions.router)
api_router.include_router(chat.router)
api_router.include_router(datasources.router)
api_router.include_router(upload.router)
api_router.include_router(export.router)
api_router.include_router(tasks.router)
api_router.include_router(config.router)
api_router.include_router(templates.router)
api_router.include_router(logs.router)