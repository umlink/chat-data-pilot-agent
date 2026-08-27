"""DataPilotAgent 后端入口。"""
import logging
import uuid
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
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

# 生产安全（CLAUDE.md 4.6）：SECRET_KEY 必须显式配置为强随机值，默认值仅允许关闭认证时使用。
# 默认密钥可被攻击者用于伪造任意用户 JWT，直接接管系统。
if settings.ENABLE_AUTH and settings.SECRET_KEY == "change-me-in-prod":
    raise RuntimeError(
        "SECRET_KEY 仍为默认值：请在 .env 中配置强随机 SECRET_KEY 后再启动（生产安全要求）"
    )

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


# ---------- 请求级 request_id 贯穿（CLAUDE.md 4.7） ----------
@app.middleware("http")
async def request_context_middleware(request: Request, call_next):
    """生成/透传 request_id，绑定 structlog.contextvars，回写 X-Request-ID 响应头。

    业务日志（LogService.write_log）会自动带上该 request_id 入库，用于请求链路追踪。
    """
    request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex
    structlog.contextvars.bind_contextvars(request_id=request_id)
    try:
        response = await call_next(request)
    finally:
        structlog.contextvars.clear_contextvars()
    response.headers["X-Request-ID"] = request_id
    return response


# ---------- 统一异常 → 信封格式（CLAUDE.md 4.5） ----------
@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.status_code, "data": None, "message": str(exc.detail)},
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    # exc.errors() 的 ctx.error 可能携带不可序列化的异常实例（如 field_validator 抛出的 ValueError），
    # 经 jsonable_encoder 统一转字符串，避免 handler 自身序列化崩溃导致 422 变 500。
    return JSONResponse(
        status_code=422,
        content={
            "code": 422,
            "data": None,
            "message": "参数错误",
            "detail": jsonable_encoder(exc.errors()),
        },
    )


@app.get("/", include_in_schema=False)
async def root():
    return {"service": "DataPilotAgent", "docs": "/docs"}


@app.get("/api/health")
async def health():
    return {"code": 0, "data": {"status": "ok"}, "message": "ok"}