from app.agents.base import BaseAgent


class SQLAgent(BaseAgent):
    """NL2SQL + 安全判定 + 执行。TODO(M3)"""

    async def run(self, context: dict) -> dict:
        raise NotImplementedError("M3")