"""统一响应格式与 Block 契约模型。

Block 结构是前后端开发契约，见 docs/Block与协议规范.md 第 1、2 章。
"""
import uuid
from typing import Any, Generic, Literal, Optional, TypeVar, Union

from pydantic import BaseModel, Field

T = TypeVar("T")


class ApiResponse(BaseModel, Generic[T]):
    """统一接口响应：{ "code": 0, "data": ..., "message": "ok" }"""

    code: int = 0
    data: Optional[T] = None
    message: str = "ok"


# ---------- Block 契约 ----------
BlockStatus = Literal[
    "pending", "running", "completed", "failed", "cancelled", "rejected"
]


class BlockAction(BaseModel):
    action: Literal[
        "edit", "execute", "copy", "retry", "export",
        "confirm", "cancel", "preview", "replace", "remove",
    ]
    label: str
    payload: Optional[dict] = None


class TableColumn(BaseModel):
    key: str
    label: str
    dtype: Literal["number", "string", "date", "boolean"]


class TextContent(BaseModel):
    text: str


class CodeExecution(BaseModel):
    task_id: Optional[str] = None
    status: Optional[Literal["running", "success", "failed"]] = None
    error: Optional[str] = None
    duration_ms: Optional[int] = None


class CodeContent(BaseModel):
    language: Literal["sql", "python"]
    code: str
    editable: bool = True
    execution: Optional[CodeExecution] = None


class TableContent(BaseModel):
    columns: list[TableColumn]
    rows: list[dict[str, Any]]
    total: int = 0
    truncated: bool = False
    query: Optional[str] = None


class ChartSeries(BaseModel):
    name: str
    x: list[Union[float, int, str]]
    y: list[float]


class ChartMatrix(BaseModel):
    x_categories: list[str]
    y_categories: list[str]
    values: list[list[float]]


class ChartContent(BaseModel):
    chart_type: Literal["line", "bar", "pie", "scatter", "heatmap"]
    title: Optional[str] = None
    series: list[ChartSeries] = Field(default_factory=list)
    matrix: Optional[ChartMatrix] = None
    x_label: Optional[str] = None
    y_label: Optional[str] = None
    source_block_id: Optional[str] = None
    query: Optional[str] = None


class ConfirmationContent(BaseModel):
    operation: Literal[
        "execute_sql", "execute_python", "delete_attachment", "truncate_table"
    ]
    title: str
    description: str
    sql: Optional[str] = None
    risk_level: Literal["high", "medium"]
    confirmed: Optional[bool] = None
    result_block_id: Optional[str] = None


class InsightItem(BaseModel):
    title: str
    detail: str
    severity: Literal["info", "positive", "warning"] = "info"


class InsightsContent(BaseModel):
    items: list[InsightItem]


class SuggestionItem(BaseModel):
    text: str
    message: str


class SuggestionsContent(BaseModel):
    items: list[SuggestionItem]


class SourceItem(BaseModel):
    """引用来源条目：数据源/表名/查询（契约 2.11 sources）。"""

    label: str
    sql: Optional[str] = None


class SourcesContent(BaseModel):
    items: list[SourceItem] = Field(default_factory=list)


class ProgressStep(BaseModel):
    name: str
    status: Literal["pending", "running", "done", "failed"] = "pending"


class ProgressContent(BaseModel):
    task_id: str
    steps: list[ProgressStep] = Field(default_factory=list)
    percent: int = 0
    current_step: Optional[str] = None
    cancellable: bool = True


class ErrorContent(BaseModel):
    code: Literal[
        "SQL_SYNTAX_ERROR", "SQL_TIMEOUT", "DATASOURCE_ERROR", "LLM_ERROR",
        "PARSE_ERROR", "UPLOAD_ERROR", "TASK_CANCELLED", "INTERNAL_ERROR",
    ]
    message: str
    detail: Optional[str] = None
    suggestion: Optional[str] = None
    retryable: bool = False


class AttachmentContent(BaseModel):
    attachment_id: str
    file_name: str
    file_type: Literal["csv", "excel", "json"]
    file_size: int = 0
    status: Literal["uploading", "parsing", "ready", "failed"] = "uploading"
    sheet_name: Optional[str] = None
    row_count: Optional[int] = None
    columns: Optional[list[dict[str, str]]] = None
    preview_rows: Optional[list[dict[str, Any]]] = None
    error: Optional[str] = None
    removed: Optional[bool] = None  # 用户已移除（block 保留，引用失效；PRD 3.1.5）


class Block(BaseModel):
    """通用 Block。content 随 type 不同，由 message.blocks 中的 JSON 决定。"""

    id: str
    type: str
    status: BlockStatus = "pending"
    content: dict[str, Any] = Field(default_factory=dict)
    actions: list[BlockAction] = Field(default_factory=list)
    parent_block_id: Optional[str] = None
    created_at: Optional[str] = None


class MessageRecord(BaseModel):
    id: str
    session_id: str
    role: str
    blocks: list[Block]
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: Optional[str] = None