"""用量统计 API：Token 消耗聚合（数据源：logs 表 category='ai'，CLAUDE.md 4.7 契约字段）。
- GET /api/stats/tokens?days=30 — 汇总 / 按日序列 / 按模型分布（无数据日期补 0）
"""
import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import BigInteger, Float, cast, func, select

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.log import Log
from app.models.user import User
from app.schemas.common import ApiResponse
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/stats", tags=["stats"])

# logs.context 中 ai 契约字段（model / tokens / latency_ms）
_TOKENS_EXPR = cast(Log.context["tokens"].astext, BigInteger)
_LATENCY_EXPR = cast(Log.context["latency_ms"].astext, Float)
_MODEL_EXPR = Log.context["model"].astext


def _round_latency(value: float | None) -> float:
    """延迟均值保留整数级精度；无数据返回 0。"""
    return round(float(value or 0))


@router.get("/tokens", response_model=ApiResponse[dict])
async def token_stats(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    days: int = Query(30, ge=1, le=365, description="统计天数（从今天往前推）"),
):
    now = datetime.datetime.now(datetime.timezone.utc)
    cutoff = now - datetime.timedelta(days=days - 1)
    day0 = cutoff.date()  # 含今天共 days 天

    conds = [Log.category == "ai", Log.timestamp >= cutoff.replace(hour=0, minute=0, second=0)]

    # 按日聚合（date_trunc 于 timestamptz 按 UTC 取日）
    day_col = func.date_trunc("day", Log.timestamp).label("day")
    daily_rows = (
        await db.execute(
            select(
                day_col,
                func.sum(_TOKENS_EXPR).label("tokens"),
                func.count().label("calls"),
                func.avg(_LATENCY_EXPR).label("avg_latency"),
            )
            .where(*conds)
            .group_by(day_col)
            .order_by(day_col)
        )
    ).all()
    by_date = {
        row.day.date().isoformat(): {
            "tokens": int(row.tokens or 0),
            "calls": int(row.calls or 0),
            "avg_latency_ms": _round_latency(row.avg_latency),
        }
        for row in daily_rows
    }

    # 补全日期序列（无数据日期补 0，前端可直接画连续曲线）
    daily: list[dict[str, Any]] = []
    for i in range(days):
        d = (day0 + datetime.timedelta(days=i)).isoformat()
        item = by_date.get(d, {"tokens": 0, "calls": 0, "avg_latency_ms": 0})
        daily.append({"date": d, **item})

    # 按模型聚合
    model_rows = (
        await db.execute(
            select(
                _MODEL_EXPR.label("model"),
                func.sum(_TOKENS_EXPR).label("tokens"),
                func.count().label("calls"),
                func.avg(_LATENCY_EXPR).label("avg_latency"),
            )
            .where(*conds)
            .group_by(_MODEL_EXPR)
            .order_by(func.sum(_TOKENS_EXPR).desc())
        )
    ).all()
    models = [
        {
            "model": row.model or "unknown",
            "tokens": int(row.tokens or 0),
            "calls": int(row.calls or 0),
            "avg_latency_ms": _round_latency(row.avg_latency),
        }
        for row in model_rows
    ]

    total_tokens = sum(m["tokens"] for m in models)
    total_calls = sum(m["calls"] for m in models)
    total_latency = sum((m["avg_latency_ms"] or 0) * m["calls"] for m in models)
    return ApiResponse(
        data={
            "days": days,
            "summary": {
                "total_tokens": total_tokens,
                "total_calls": total_calls,
                "avg_latency_ms": round(total_latency / total_calls) if total_calls else 0,
            },
            "daily": daily,
            "models": models,
        }
    )
