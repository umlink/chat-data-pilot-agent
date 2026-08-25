"""Anthropic 协议适配器（anthropic SDK）。消息格式转换：system 字段分离，
流式处理 content_block_delta。TODO(M2)：实现。
"""
from typing import Any, AsyncGenerator

from app.llm.base import BaseLLMProvider, ToolCall, ToolCallResult


class AnthropicAdapter(BaseLLMProvider):
    name = "anthropic"

    def __init__(self, config: dict):
        self._config = config

    def _to_anthropic(self, messages: list[dict]) -> tuple[list[dict], str]:
        """OpenAI 风格消息 -> (anthropic messages, system)。"""
        system = ""
        msgs = []
        for m in messages:
            if m.get("role") == "system":
                system = m.get("content", "")
                continue
            role = "assistant" if m["role"] == "assistant" else "user"
            msgs.append({"role": role, "content": m.get("content", "")})
        return msgs, system

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