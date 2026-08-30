"""服务端图表聚合（Agent 工具 create_chart 的后端）。

契约见 docs/Block与协议规范.md 4.2 create_chart：
- 服务端负责聚合与组装，LLM 只指定图表语义；
- 规则：pie 至多 1 个 measure；heatmap 的 dimension/measures 映射 matrix 的 x/y；
- 其余 chart_type 组装为 series（x=dimension 分类，y=measures）。
聚合采用 pandas，CPU 密集 → 调用方以 asyncio.to_thread 执行。
"""
import logging
from typing import Any

import pandas as pd

logger = logging.getLogger("datapilot.chart")

ALLOWED_TYPES = {"line", "bar", "pie", "scatter", "heatmap"}
_AGGS = {"sum", "avg", "count", "max", "min"}


class ChartError(Exception):
    """图表参数不合法（由工具层转为 error 反馈给 LLM）。"""


def _agg_fn(agg: str):
    return {"sum": "sum", "avg": "mean", "count": "count", "max": "max", "min": "min"}[agg]


def _grouped_series(
    df: pd.DataFrame, dimension: str, measure: dict[str, Any], order: list
) -> tuple[list, list]:
    """按 dimension 分组聚合单个 measure，返回 (x 分类, y 值)。保持首次出现顺序。"""
    col = measure["column"]
    agg = measure.get("agg")
    name = measure.get("name") or col
    if col not in df.columns:
        raise ChartError(f"列不存在: {col}")
    if agg:
        fn = _agg_fn(agg)
        grouped = df.groupby(dimension, dropna=False)[col].agg(fn)
        series = grouped.reindex(order) if hasattr(grouped, "reindex") else grouped
        return [str(x) for x in series.index], [float(v) for v in series.values]
    # 未聚合：行级透传
    xs = [str(v) for v in df[dimension].tolist()]
    ys = [0.0 if v is None or pd.isna(v) else float(v) for v in df[col].tolist()]
    return xs, ys


def build_chart(table: dict[str, Any], chart_type: str, dimension: str,
                measures: list[dict[str, Any]], title: str | None = None) -> dict[str, Any]:
    """由 TableContent 组装 ChartContent（schemas/common.py）。"""
    columns = [c["key"] for c in table.get("columns", [])]
    rows = table.get("rows", [])
    if chart_type not in ALLOWED_TYPES:
        raise ChartError(f"不支持的图表类型: {chart_type}")
    if dimension not in columns:
        raise ChartError(f"dimension 列不存在: {dimension}")
    if not rows:
        raise ChartError("数据为空，无法生成图表")
    if not measures:
        raise ChartError("measures 不能为空，至少需要 1 个 measure")
    for m in measures:
        if not m.get("column"):
            raise ChartError("measure 缺少 column 字段")
    if chart_type == "pie" and len(measures) > 1:
        raise ChartError("pie 图至多支持 1 个 measure")

    df = pd.DataFrame(rows)
    # 分类顺序按首次出现（确定性），供聚合后 align
    order = list(dict.fromkeys(str(v) for v in df[dimension].tolist()))

    if chart_type == "heatmap":
        if not measures:
            raise ChartError("heatmap 需要至少 1 个 measure")
        x_categories = order
        y_categories = []
        matrix: list[list[float]] = []
        for m in measures:
            col = m["column"]
            if col not in df.columns:
                raise ChartError(f"列不存在: {col}")
            agg = m.get("agg") or "count"
            if agg not in _AGGS:
                raise ChartError(f"不支持的聚合方式: {agg}")
            fn = _agg_fn(agg)
            grouped = df.groupby(dimension, dropna=False)[col].agg(fn)
            grouped = grouped.reindex(order)
            values = [0.0 if pd.isna(v) else float(v) for v in grouped.values]
            y_categories.append(m.get("name") or f"{col}({agg})")
            matrix.append(values)
        return {
            "chart_type": "heatmap",
            "title": title,
            "matrix": {
                "x_categories": x_categories,
                "y_categories": y_categories,
                "values": matrix,
            },
            "x_label": dimension,
            "y_label": None,
        }

    if chart_type == "pie":
        m = measures[0]
        col = m["column"]
        agg = m.get("agg") or "sum"
        if col not in df.columns:
            raise ChartError(f"列不存在: {col}")
        fn = _agg_fn(agg)
        grouped = df.groupby(dimension, dropna=False)[col].agg(fn).reindex(order)
        return {
            "chart_type": "pie",
            "title": title,
            "series": [{
                "name": m.get("name") or col,
                "x": [str(x) for x in grouped.index],
                "y": [0.0 if pd.isna(v) else float(v) for v in grouped.values],
            }],
            "x_label": dimension,
            "y_label": col,
        }

    series = []
    for m in measures:
        xs, ys = _grouped_series(df, dimension, m, order)
        series.append({"name": m.get("name") or m["column"], "x": xs, "y": ys})
    return {
        "chart_type": chart_type,
        "title": title,
        "series": series,
        "x_label": dimension,
        "y_label": measures[0].get("name") if measures else None,
    }