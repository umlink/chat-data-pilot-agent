"""Agent 引擎基础工具集。

工具契约见 docs/Block与协议规范.md 第 4.2 节：
run_sql / run_python / create_chart / request_confirmation。TODO(M2/M3)。
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field


class BaseAgent(ABC):
    @abstractmethod
    async def run(self, context: dict) -> dict:
        """执行 Agent，返回结构化结果（映射为 Block）。"""