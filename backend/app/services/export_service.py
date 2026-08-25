"""ExportService：数据 / 对话多格式导出。
表格：CSV / Excel / JSON；对话：Markdown（图表 base64 嵌入）。TODO(M4)。
"""


class ExportService:
    async def export(self, *, type: str, format: str, data: dict) -> bytes:
        raise NotImplementedError("M4")