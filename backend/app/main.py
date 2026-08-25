"""DataPilotAgent 后端入口。"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.config import settings
from app.core.database import close_db, init_db
from app.initial_data import seed
from app.services.log_service import setup_structlog

setup_structlog()
logger = logging.getLogger("datapilot")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.AUTO_CREATE_TABLES:
        await init_db()
    await seed()
    logger.info("DataPilotAgent backend 已启动")
    yield
    await close_db()


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


@app.get("/", include_in_schema=False)
async def root():
    return {"service": "DataPilotAgent", "docs": "/docs"}


@app.get("/api/health")
async def health():
    return {"code": 0, "data": {"status": "ok"}, "message": "ok"}