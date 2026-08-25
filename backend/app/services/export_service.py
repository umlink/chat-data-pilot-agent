"""ExportService：数据 / 图表 / 对话多格式导出。

支持矩阵（docs/技术方案设计.md 2.3「导出」、docs/需求PRD.md 3.3.3）：
- table        -> csv / excel / json
- chart        -> png / svg / pdf / json
- conversation -> markdown

实现约定：
- 文件名统一带导出时间戳，如「数据导出_20260825_143052.csv」。
- CSV 带 UTF-8 BOM，保证 Excel 直接打开中文不乱码。
- 图表 PNG/SVG/PDF 由前端图表库渲染后以 data.image_base64 传入，服务端仅解码回传；
  json 格式则直接序列化 ChartContent 结构。
- 对话 Markdown 按 Block 契约（docs/Block与协议规范.md 第 2 章）逐块渲染：
  text 直接文本、code 用围栏代码块、table 转 Markdown 表格（前 50 行 + 截断说明）、
  chart 支持图片 base64 内嵌、error/confirmation 等以引用块摘要。
- 参数组合非法或数据不满足要求时抛 ValueError，由 API 层统一转 400。
"""
import asyncio
import base64
import binascii
import csv
import datetime
import io
import json
from typing import Any, Callable

import openpyxl

# ---------- 支持矩阵（唯一事实源，API 与前端导出菜单共用） ----------
SUPPORTED_FORMATS: dict[str, tuple[str, ...]] = {
    "table": ("csv", "excel", "json"),
    "chart": ("png", "svg", "pdf", "json"),
    "conversation": ("markdown",),
}

CONTENT_TYPES: dict[str, str] = {
    "csv": "text/csv; charset=utf-8",
    "excel": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "json": "application/json; charset=utf-8",
    "png": "image/png",
    "svg": "image/svg+xml",
    "pdf": "application/pdf",
    "markdown": "text/markdown; charset=utf-8",
}

_TYPE_LABELS: dict[str, str] = {
    "table": "表格",
    "chart": "图表",
    "conversation": "对话记录",
}

_CHART_TYPE_LABELS: dict[str, str] = {
    "line": "折线图",
    "bar": "柱状图",
    "pie": "饼图",
    "scatter": "散点图",
    "heatmap": "热力图",
}

_ATTACHMENT_STATUS_LABELS: dict[str, str] = {
    "uploading": "上传中",
    "parsing": "解析中",
    "ready": "已就绪",
    "failed": "解析失败",
}

_ROLE_LABELS: dict[str, str] = {"user": "用户", "assistant": "助手", "system": "系统"}

# 各 format 对应的文件扩展名（excel 用 xlsx、markdown 用 md）
_EXTENSIONS: dict[str, str] = {"excel": "xlsx", "markdown": "md"}

# 对话 Markdown 中单个 table block 最多渲染行数（与 PRD「附件预览前 50 行」口径一致）
_MD_TABLE_MAX_ROWS = 50


def _matrix_error(export_type: str, export_format: str) -> str:
    """构造带支持矩阵的中文错误提示。"""
    matrix = "；".join(
        f"{_TYPE_LABELS[t]}（type={t}）支持 {'/'.join(fmts)}"
        for t, fmts in SUPPORTED_FORMATS.items()
    )
    return (
        f"不支持的导出组合：type={export_type or '空'}，format={export_format or '空'}。"
        f"支持的组合：{matrix}"
    )


def _timestamp() -> str:
    return datetime.datetime.now().strftime("%Y%m%d_%H%M%S")


def _now_text() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _filename(prefix: str, fmt: str) -> str:
    """生成带时间戳的导出文件名。"""
    ext = _EXTENSIONS.get(fmt, fmt)
    return f"{prefix}_{_timestamp()}.{ext}"


def _dump_json(payload: Any) -> bytes:
    """JSON 序列化：中文不转义，未知类型回退字符串，保证可序列化。"""
    return json.dumps(payload, ensure_ascii=False, indent=2, default=str).encode("utf-8")


def _stringify(value: Any) -> str:
    """单元格值转可读字符串（CSV / Markdown 表格共用）。"""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    return str(value)


# ---------- 表格导出 ----------

def _parse_table(data: dict[str, Any]) -> tuple[list[tuple[str, str]], list[dict[str, Any]]]:
    """提取列定义与行数据。columns 兼容 TableContent（key/label/dtype，dtype 可选）。"""
    columns_raw = data.get("columns")
    if not isinstance(columns_raw, list) or not columns_raw:
        raise ValueError("表格导出数据缺少 columns 字段（应为 [{key, label}] 数组）")
    rows_raw = data.get("rows")
    if rows_raw is None:
        rows_raw = []
    if not isinstance(rows_raw, list):
        raise ValueError("表格导出数据 rows 字段应为行对象数组")
    columns: list[tuple[str, str]] = []
    for col in columns_raw:
        if not (isinstance(col, dict) and col.get("key")):
            raise ValueError("表格列定义非法：columns 中每项需包含 key（与可选 label）")
        key = str(col["key"])
        columns.append((key, str(col.get("label") or key)))
    rows = [row for row in rows_raw if isinstance(row, dict)]
    return columns, rows


def _table_csv(columns: list[tuple[str, str]], rows: list[dict[str, Any]]) -> bytes:
    """CSV（带 UTF-8 BOM）：首行为列展示名，csv 模块处理逗号/引号/换行的转义。"""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([label for _, label in columns])
    for row in rows:
        writer.writerow([_stringify(row.get(key)) for key, _ in columns])
    return buf.getvalue().encode("utf-8-sig")


def _table_excel(columns: list[tuple[str, str]], rows: list[dict[str, Any]]) -> bytes:
    """xlsx：首行为表头并冻结，数值保持数值类型。"""
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "数据"
    sheet.append([label for _, label in columns])
    for row in rows:
        sheet.append([_excel_cell(row.get(key)) for key, _ in columns])
    sheet.freeze_panes = "A2"  # 冻结表头行，便于滚动浏览
    buf = io.BytesIO()
    workbook.save(buf)
    return buf.getvalue()


def _excel_cell(value: Any) -> Any:
    """转换为 openpyxl 可安全写入的值。

    Excel 不支持带时区的 datetime（保存时抛错），统一去时区；
    其余不支持类型（dict/list/Decimal 等）回退字符串，避免整体导出失败。
    """
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, datetime.datetime):
        return value.replace(tzinfo=None) if value.tzinfo else value
    if isinstance(value, datetime.date):
        return value
    return _stringify(value)


def _export_table(fmt: str, data: dict[str, Any]) -> tuple[bytes, str, str]:
    columns, rows = _parse_table(data)
    filename = _filename("数据导出", fmt)
    if fmt == "csv":
        return _table_csv(columns, rows), filename, CONTENT_TYPES["csv"]
    if fmt == "excel":
        return _table_excel(columns, rows), filename, CONTENT_TYPES["excel"]
    # json：直接序列化整个 data（保留 total/truncated/query 等附加字段）
    return _dump_json(data), filename, CONTENT_TYPES["json"]


# ---------- 图表导出 ----------

def _decode_image_base64(fmt: str, data: dict[str, Any]) -> bytes:
    """解码前端渲染好的图表图片（data.image_base64，兼容 data URI 前缀）。"""
    image = data.get("image_base64")
    if not isinstance(image, str) or not image.strip():
        raise ValueError(
            f"图表导出为 {fmt.upper()} 时需要 data.image_base64（前端渲染后的图片 base64 数据）"
        )
    b64 = image.strip()
    if b64.startswith("data:"):
        # 兼容 data URI 形式：data:image/png;base64,xxxx
        b64 = b64.partition(",")[2]
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("图表图片数据非法：base64 解码失败") from exc
    if not raw:
        raise ValueError("图表图片数据为空")
    return raw


def _export_chart(fmt: str, data: dict[str, Any]) -> tuple[bytes, str, str]:
    filename = _filename("图表导出", fmt)
    if fmt == "json":
        # 直接回传 ChartContent 结构
        if not data:
            raise ValueError("图表导出为 JSON 时需要传入 ChartContent 结构数据")
        return _dump_json(data), filename, CONTENT_TYPES["json"]
    return _decode_image_base64(fmt, data), filename, CONTENT_TYPES[fmt]


# ---------- 对话导出（Markdown） ----------

def _md_cell(value: str) -> str:
    """Markdown 表格单元格转义：反斜杠与竖线转义、换行折叠为空格。"""
    return (
        value.replace("\\", "\\\\")
        .replace("|", "\\|")
        .replace("\r", " ")
        .replace("\n", " ")
    )


def _render_text_block(content: dict[str, Any]) -> list[str]:
    text = str(content.get("text") or "").strip()
    return [text] if text else []


def _render_code_block(content: dict[str, Any]) -> list[str]:
    language = str(content.get("language") or "").strip() or "text"
    code = str(content.get("code") or "").rstrip()
    return [f"```{language}", code, "```"]


def _render_table_block(content: dict[str, Any]) -> list[str]:
    columns_raw = content.get("columns")
    rows_raw = content.get("rows")
    if not isinstance(columns_raw, list) or not columns_raw:
        return ["> [空表格]"]
    if not isinstance(rows_raw, list):
        rows_raw = []
    columns: list[tuple[str, str]] = []
    for col in columns_raw:
        if isinstance(col, dict) and col.get("key"):
            key = str(col["key"])
            columns.append((key, str(col.get("label") or key)))
    if not columns:
        return ["> [空表格]"]
    shown = [row for row in rows_raw if isinstance(row, dict)][:_MD_TABLE_MAX_ROWS]
    lines = [
        "| " + " | ".join(_md_cell(label) for _, label in columns) + " |",
        "| " + " | ".join(["---"] * len(columns)) + " |",
    ]
    for row in shown:
        lines.append(
            "| " + " | ".join(_md_cell(_stringify(row.get(key))) for key, _ in columns) + " |"
        )
    # 截断说明：TableContent.truncated 或行数超过上限时（total 为截断前总数）
    total = content.get("total")
    if not isinstance(total, int) or total < len(rows_raw):
        total = len(rows_raw)
    if total > len(shown):
        lines.extend(
            [
                "",
                f"> 注：表格共 {total} 行，此处仅展示前 {len(shown)} 行（已截断），"
                "完整数据请使用导出功能获取。",
            ]
        )
    return lines


def _render_chart_block(content: dict[str, Any], block: dict[str, Any], images: dict) -> list[str]:
    title = str(content.get("title") or "图表").strip()
    chart_type = str(content.get("chart_type") or "").strip()
    image_base64 = content.get("image_base64")
    if not isinstance(image_base64, str) or not image_base64.strip():
        # 前端也可在 data.images 中按 block id 提供渲染结果
        candidate = images.get(str(block.get("id") or ""))
        image_base64 = candidate if isinstance(candidate, str) else None
    if image_base64 and image_base64.strip():
        b64 = image_base64.strip()
        if b64.startswith("data:"):
            uri = b64  # 已是 data URI 直接嵌入
        else:
            uri = f"data:image/png;base64,{b64}"
        # base64 内部空白会导致 Markdown 图片链接断裂，先压缩
        uri = uri.replace(" ", "").replace("\r", "").replace("\n", "")
        return [f"![{title}]({uri})"]
    type_label = _CHART_TYPE_LABELS.get(chart_type, chart_type or "图表")
    return [f"> [图表] {title}（{type_label}，图片未随导出数据提供）"]


def _render_error_block(content: dict[str, Any]) -> list[str]:
    lines = [f"> [错误] {content.get('message') or '未知错误'}"]
    suggestion = content.get("suggestion")
    if suggestion:
        lines.extend([">", f"> 建议：{suggestion}"])
    return lines


def _render_confirmation_block(content: dict[str, Any]) -> list[str]:
    title = content.get("title") or "操作确认"
    summary = f"> [确认卡片] {title}"
    description = str(content.get("description") or "").strip()
    if description:
        summary += f"：{description}"
    risk = str(content.get("risk_level") or "")
    if risk:
        summary += f"（风险等级：{'高' if risk == 'high' else '中'}）"
    return [summary]


def _render_insights_block(content: dict[str, Any]) -> list[str]:
    items = content.get("items")
    if not isinstance(items, list) or not items:
        return ["> [数据洞察] 无"]
    lines = ["**数据洞察**", ""]
    for item in items:
        if isinstance(item, dict):
            lines.append(f"- **{item.get('title', '')}**：{item.get('detail', '')}")
    return lines


def _render_suggestions_block(content: dict[str, Any]) -> list[str]:
    items = content.get("items")
    if not isinstance(items, list) or not items:
        return []
    lines = ["**后续建议**", ""]
    for item in items:
        if isinstance(item, dict):
            lines.append(f"- {item.get('text', '')}")
    return lines


def _render_progress_block(content: dict[str, Any]) -> list[str]:
    summary = "> [任务进度]"
    percent = content.get("percent")
    if percent is not None:
        summary += f" {percent}%"
    step = content.get("current_step")
    if step:
        summary += f" · {step}"
    return [summary]


def _render_attachment_block(content: dict[str, Any]) -> list[str]:
    summary = f"> [附件] {content.get('file_name') or '未命名附件'}"
    status = str(content.get("status") or "")
    if status:
        summary += f"（状态：{_ATTACHMENT_STATUS_LABELS.get(status, status)}）"
    row_count = content.get("row_count")
    if row_count is not None:
        summary += f"，共 {row_count} 行"
    return [summary]


# 各类型 Block 的 Markdown 渲染器（签名统一为 (content, block, images)）
_BLOCK_RENDERERS: dict[str, Callable[[dict, dict, dict], list[str]]] = {
    "text": lambda content, _block, _images: _render_text_block(content),
    "code": lambda content, _block, _images: _render_code_block(content),
    "table": lambda content, _block, _images: _render_table_block(content),
    "chart": _render_chart_block,
    "error": lambda content, _block, _images: _render_error_block(content),
    "confirmation": lambda content, _block, _images: _render_confirmation_block(content),
    "insights": lambda content, _block, _images: _render_insights_block(content),
    "suggestions": lambda content, _block, _images: _render_suggestions_block(content),
    "progress": lambda content, _block, _images: _render_progress_block(content),
    "attachment": lambda content, _block, _images: _render_attachment_block(content),
}


def _render_block(block: dict[str, Any], images: dict) -> list[str]:
    block_type = str(block.get("type") or "")
    content = block.get("content")
    if not isinstance(content, dict):
        content = {}
    renderer = _BLOCK_RENDERERS.get(block_type)
    if renderer is None:
        return [f"> [内容块：{block_type or '未知类型'}]"]
    return renderer(content, block, images)


def _render_message(message: dict[str, Any], images: dict) -> list[str]:
    """单条消息 -> 「## 用户 / ## 助手」分节，内部逐 Block 渲染。"""
    role = str(message.get("role") or "unknown")
    lines = [f"## {_ROLE_LABELS.get(role, role)}"]
    created_at = message.get("created_at")
    if created_at:
        lines.extend(["", f"*{created_at}*"])
    lines.append("")
    blocks = message.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        return [*lines, "（无内容）", ""]
    for block in blocks:
        if not isinstance(block, dict):
            continue
        rendered = _render_block(block, images)
        if rendered:
            lines.extend(rendered)
            lines.append("")
    return lines


def _export_conversation(fmt: str, data: dict[str, Any]) -> tuple[bytes, str, str]:
    messages = data.get("messages")
    if not isinstance(messages, list):
        raise ValueError("对话导出数据缺少 messages 字段（应为 [{role, blocks: [Block]}] 数组）")
    # 可选图片映射：{block_id: base64}（chart block 的另一种图片提供方式）
    images = data.get("images") if isinstance(data.get("images"), dict) else {}
    title = str(data.get("title") or "对话记录").strip() or "对话记录"
    lines: list[str] = [
        f"# {title}",
        "",
        f"> 导出时间：{_now_text()} · 共 {len(messages)} 条消息",
        "",
    ]
    total = len(messages)
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            continue
        lines.extend(_render_message(message, images))
        if index < total - 1:
            lines.extend(["---", ""])
    content = "\n".join(lines).strip() + "\n"
    return content.encode("utf-8"), _filename("对话记录", "markdown"), CONTENT_TYPES["markdown"]


class ExportService:
    """多格式导出服务：export(type, format, data) -> (文件内容, 文件名, Content-Type)。

    文件生成为同步 CPU/IO 操作（csv / openpyxl），统一放线程池执行，
    避免阻塞事件循环（CLAUDE.md 4.2）。
    """

    async def export(
        self, *, type: str, format: str, data: dict[str, Any] | None
    ) -> tuple[bytes, str, str]:
        """按 type×format 生成导出文件。

        :raises ValueError: 组合不在支持矩阵内，或 data 缺少必要字段（API 层转 400）
        """
        supported = SUPPORTED_FORMATS.get(type)
        if supported is None or format not in supported:
            raise ValueError(_matrix_error(type, format))
        payload: dict[str, Any] = data or {}
        if type == "table":
            renderer: Callable[[str, dict[str, Any]], tuple[bytes, str, str]] = _export_table
        elif type == "chart":
            renderer = _export_chart
        else:
            renderer = _export_conversation
        return await asyncio.to_thread(renderer, format, payload)
