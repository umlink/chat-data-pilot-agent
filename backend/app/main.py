"""DataPilotAgent 后端入口。"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.router import api_router
from app.core.config import settings
from app.core.database import close_db, init_db
from app.core.redis import close_redis
from app.initial_data import seed
from app.services.log_service import setup_structlog
from app.tasks.worker import Worker

setup_structlog()
# 让 app 日志（worker/tasks/config/executors 等）在 uvicorn root 默认 WARNING 下也能看到
logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("datapilot")

_worker = Worker(count=3)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.AUTO_CREATE_TABLES:
        await init_db()
    await seed()
    await _worker.start()
    logger.info("DataPilotAgent backend 已启动")
    yield
    await _worker.stop()
    await close_db()
    await close_redis()


app = FastAPI(
    title="DataPilotAgent API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api")


# ---------- 统一异常 → 信封格式（CLAUDE.md 4.5） ----------
@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.status_code, "data": None, "message": str(exc.detail)},
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "code": 422,
            "data": None,
            "message": "参数错误",
            "detail": exc.errors(),
        },
    )


@app.get("/", include_in_schema=False)
async def root():
    return {"service": "DataPilotAgent", "docs": "/docs"}


@app.get("/api/health")
async def health():
    return {"code": 0, "data": {"status": "ok"}, "message": "ok"}