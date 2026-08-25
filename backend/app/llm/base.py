"""LLM 双协议统一抽象。

契约见 docs/Block与协议规范.md 第 4 章：Agent 与 LLM 结构化交互统一走
tool calling，不支持工具调用的模型降级为严格 JSON 模式。
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator


@dataclass
class ToolCall:
    name: str
    arguments: dict[str, Any]


@dataclass
class ToolCallResult:
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


class BaseLLMProvider(ABC):
    """统一 Provider 接口。OpenAI / Anthropic 适配器实现之。"""

    name: str = "base"

    @abstractmethod
    async def stream_chat(self, messages: list[dict], **kwargs) -> AsyncGenerator[str, None]:
        """纯文本流式对话，逐 token yield。"""

    @abstractmethod
    async def chat(self, messages: list[dict], **kwargs) -> str:
        """非流式对话，返回完整文本。"""

    @abstractmethod
    async def chat_with_tools(
        self, messages: list[dict], tools: list[dict], **kwargs
    ) -> ToolCallResult:
        """工具调用（非流式）。返回文本与归一化的 ToolCall 列表。"""

    @abstractmethod
    async def stream_chat_with_tools(
        self, messages: list[dict], tools: list[dict], **kwargs
    ) -> AsyncGenerator[str, None]:
        """流式工具调用：文本部分逐 token，工具调用参数整体返回。"""

    # 便捷方法（由子类按需覆盖，DEFAULT 先基于 chat 实现）
    async def generate_sql(self, question: str, schema: str, history: str) -> str:
        return await self.chat(
            [
                {"role": "system", "content": "你是资深数据分析师，只输出可执行的 SQL。"},
                {"role": "user", "content": f"数据库结构：\n{schema}\n\n问题：{question}\n\n历史：{history}"},
            ]
        )

    async def generate_python(self, question: str, data_info: str, history: str) -> str:
        return await self.chat(
            [
                {"role": "system", "content": "你是数据分析专家，只输出可运行的 pandas 代码。"},
                {"role": "user", "content": f"数据结构：\n{data_info}\n\n问题：{question}\n\n历史：{history}"},
            ]
        )

    async def analyze_intent(self, question: str, context: str) -> dict:
        return {"intent": "chat"}


def build_llm_provider(config: dict) -> BaseLLMProvider:
    """Provider 工厂：根据配置创建适配器，配置变更时重建。"""
    from app.llm.anthropic_adapter import AnthropicAdapter
    from app.llm.openai_adapter import OpenAIAdapter

    provider = (config.get("provider") or "openai").lower()
    if provider == "anthropic":
        return AnthropicAdapter(config)
    return OpenAIAdapter(config)