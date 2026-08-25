"""导出请求模型。与 docs/技术方案设计.md 2.3「导出」对齐。

type / format 故意声明为 str 而非 Literal：非法组合需要在 service 层给出
「支持矩阵」的中文提示并由 API 层统一转 400，而非 Pydantic 的 422。
"""
from typing import Any

from pydantic import BaseModel, Field


class ExportRequest(BaseModel):
    """POST /api/export 请求体。

    - type：导出对象，table（表格）/ chart（图表）/ conversation（对话记录）
    - format：csv / excel / json / png / svg / pdf / markdown
    - data：导出负载，结构随 type 变化：
      - table        -> {columns: [{key, label}], rows: [{...}]}
      - chart        -> {image_base64}（png/svg/pdf）；json 格式时传 ChartContent 结构
      - conversation -> {messages: [{role, blocks: [Block 契约结构]}]}
    """

    type: str = Field(..., description="导出对象类型：table / chart / conversation")
    format: str = Field(..., description="导出格式：csv / excel / json / png / svg / pdf / markdown")
    data: dict[str, Any] = Field(
        default_factory=dict, description="导出负载数据，结构随 type 变化"
    )
