from app.agents.base import BaseAgent


class PythonAgent(BaseAgent):
    """受限沙箱代码执行（跨源合并、统计分析）。TODO(M3/M4)"""

    async def run(self, context: dict) -> dict:
        raise NotImplementedError("M3")