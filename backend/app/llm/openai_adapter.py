"""OpenAI 协议适配器（openai SDK）。支持 OpenAI / Azure / vLLM / Ollama 兼容端点。
TODO(M2)：实现 token 流与 tools 调用解析。
"""
from typing import Any, AsyncGenerator

from app.core.config import settings
from app.llm.base import BaseLLMProvider, ToolCall, ToolCallResult, Usage


class OpenAIAdapter(BaseLLMProvider):
    name = "openai"

    def __init__(self, config: dict):
        self._config = config
        # TODO(M2): async OpenAI 客户端，base_url 可自定义端点

    async def stream_chat(self, messages: list[dict], **kw) -> AsyncGenerator[str, None]:
        raise NotImplementedError("M2")

    async def chat(self, messages: list[dict], **kw) -> str:
        raise NotImplementedError("M2")

    async def chat_with_tools(
        self, messages: list[dict], tools: list[dict], **kw
    ) -> ToolCallResult:
        raise NotImplementedError("M2")

    async def stream_chat_with_tools(
        self, messages: list[dict], tools: list[dict], **kw
    ) -> AsyncGenerator[str, None]:
        raise NotImplementedError("M2")