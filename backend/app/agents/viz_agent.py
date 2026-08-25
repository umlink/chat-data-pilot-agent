from app.agents.base import BaseAgent


class VizAgent(BaseAgent):
    """图表语义生成（create_chart 工具实现，服务端 pandas 聚合）。TODO(M4)"""

    async def run(self, context: dict) -> dict:
        raise NotImplementedError("M4")