"""Anthropic 协议适配器（anthropic SDK）。

内部消息统一 OpenAI 风格，入口处由 `_to_anthropic` 完成转换：
- system 角色消息提取为顶级 `system` 参数（支持拼接多条）；
- assistant 消息中的工具调用（顶层 `tool_calls` 或 `metadata.tool_calls`）
  转为 `tool_use` content block；
- `tool` 角色消息转为 `user` 消息内的 `tool_result` block（按 `tool_call_id`
  与上一条 assistant 的 `tool_use.id` 匹配）。

流式工具调用 yield 协议与 OpenAIAdapter 完全一致（见其模块 docstring）：
文本片段 yield str，工具调用作为一个 `{"__tool_call__": {...}}` dict 于流末 yield。
"""
import asyncio
import hashlib
import json
import logging
from collections import deque
from typing import Any, AsyncGenerator

import anthropic

from app.llm.base import BaseLLMProvider, ToolCall, ToolCallResult, Usage

logger = logging.getLogger("datapilot.llm.anthropic")

# 可重试异常：网络中断 / 超时 / 限流 / 服务端错误（认证与 4xx 不重试）
_RETRYABLE_ERRORS: tuple[type[Exception], ...] = (
    anthropic.APIConnectionError,
    anthropic.APITimeoutError,
    anthropic.RateLimitError,
    anthropic.InternalServerError,
    anthropic.ServiceUnavailableError,
    anthropic.OverloadedError,
)

_DEFAULT_TIMEOUT = 60.0
_DEFAULT_RETRY_COUNT = 1
_DEFAULT_MAX_TOKENS = 4096


class AnthropicAdapter(BaseLLMProvider):
    name = "anthropic"

    def __init__(self, config: dict):
        self._config = dict(config)
        self._model: str = self._config.get("model") or "claude-sonnet-4-20250514"
        self._temperature: float | None = self._config.get("temperature")
        self._max_tokens: int = self._config.get("max_tokens") or _DEFAULT_MAX_TOKENS
        self._timeout: float = float(self._config.get("timeout") or _DEFAULT_TIMEOUT)
        self._retry_count: int = int(self._config.get("retry_count") or _DEFAULT_RETRY_COUNT)
        self._api_key: str = str(self._config.get("api_key") or "").strip()
        self._base_url: str | None = str(self._config.get("base_url") or "").strip() or None
        self._version: str | None = str(self._config.get("version") or "").strip() or None
        self._client: anthropic.AsyncAnthropic | None = None
        # 本适配器生命周期内累计的 token 用量（供会话级 usage 统计）
        self._usage = Usage()
        # 最近一次工具调用生成的 tool_use id（顺序与 ToolCall 列表对齐，供消息重放）
        self._tool_ids: list[str] = []
        # `_to_anthropic` 转换过程中待匹配的 tool_use id（供无 id 的 tool 消息按序回退）
        self._pending_tool_ids: deque[str] = deque()

    @property
    def usage(self) -> Usage:
        """累计 usage（prompt/completion tokens）。"""
        return self._usage

    @property
    def last_tool_ids(self) -> list[str]:
        """最近一次工具调用返回的 tool_use id，顺序与 ToolCall 列表对齐。"""
        return list(self._tool_ids)

    # ------------------------------------------------------------------ #
    # 客户端与消息转换
    # ------------------------------------------------------------------ #

    def _get_client(self) -> anthropic.AsyncAnthropic:
        """懒创建 AsyncAnthropic 客户端；api_key 缺失时抛出清晰的中文错误。"""
        if not self._api_key:
            raise RuntimeError("未配置 Anthropic API Key：请在系统配置中填写 llm.anthropic 的 api_key 字段")
        if self._client is None:
            kwargs: dict[str, Any] = {
                "api_key": self._api_key,
                "timeout": self._timeout,
                "max_retries": 0,  # SDK 层关闭重试，重试策略由本适配器按 retry_count 控制
            }
            if self._base_url:
                kwargs["base_url"] = self._base_url
            if self._version:
                kwargs["default_headers"] = {"anthropic-version": self._version}
            self._client = anthropic.AsyncAnthropic(**kwargs)
        return self._client

    def _to_anthropic(self, messages: list[dict]) -> tuple[list[dict], str]:
        """OpenAI 风格消息 -> (anthropic messages, system 字符串)。

        处理 system / user / assistant(tool_calls) / tool(tool_result) 四种角色；
        tool_use 与 tool_result 的 id 匹配策略：优先使用持久化的 `tool_call_id`，
        缺失时按顺序回退到上一条 assistant 消息生成的 tool_use id。
        """
        self._pending_tool_ids.clear()
        system_parts: list[str] = []
        msgs: list[dict] = []
        for m in messages:
            role = m.get("role")
            if role == "system":
                content = m.get("content", "")
                if content:
                    system_parts.append(content if isinstance(content, str) else json.dumps(content, ensure_ascii=False))
                continue
            if role == "assistant":
                blocks = self._assistant_blocks(m)
                msgs.append({"role": "assistant", "content": blocks or [{"type": "text", "text": ""}]})
                continue
            if role == "tool":
                msgs.append(self._tool_result_message(m))
                continue
            # user 角色（含普通字符串或多段 content）
            content = m.get("content", "")
            msgs.append({"role": "user", "content": content if isinstance(content, str) else str(content)})
        system = "\n\n".join(part for part in system_parts if part)
        return msgs, system

    def _assistant_blocks(self, m: dict) -> list[dict]:
        """assistant 消息 -> content blocks（text + tool_use）。"""
        blocks: list[dict] = []
        content = m.get("content", "")
        if isinstance(content, str) and content:
            blocks.append({"type": "text", "text": content})
        calls = m.get("tool_calls") or (m.get("metadata") or {}).get("tool_calls") or []
        for call in calls:
            if isinstance(call, ToolCall):
                name, cid = call.name, None
                args = call.arguments
            elif isinstance(call, dict):
                name = call.get("name", "")
                cid = call.get("id")
                args = call.get("arguments") or {}
                if isinstance(args, str):
                    args = self._safe_loads(args)  # type: ignore[assignment]
            else:
                continue
            if not name:
                continue
            tool_use_id = cid or self._gen_tool_id(name, args)
            if not cid:
                self._pending_tool_ids.append(tool_use_id)  # 供后续 tool 消息无 id 时按序匹配
            blocks.append(
                {
                    "type": "tool_use",
                    "id": tool_use_id,
                    "name": name,
                    "input": args if isinstance(args, dict) else {},
                }
            )
        return blocks

    def _tool_result_message(self, m: dict) -> dict:
        """tool 角色消息 -> user 消息内的 tool_result content block。"""
        tool_call_id = m.get("tool_call_id")
        if not tool_call_id and self._pending_tool_ids:
            tool_call_id = self._pending_tool_ids.popleft()
        if not tool_call_id:
            raise RuntimeError("工具结果消息缺少 tool_call_id，且无法与任一 assistant 的 tool_use 对应")
        content = m.get("content", "")
        if isinstance(content, list):
            content = "\n".join(
                str(b.get("text", "")) if isinstance(b, dict) else str(b) for b in content
            )
        return {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": tool_call_id, "content": str(content)}],
        }

    @staticmethod
    def _gen_tool_id(name: str, args: Any) -> str:
        """无持久化 id 时生成确定性 tool_use id（同 name+args 幂等，便于重放匹配）。"""
        payload = f"{name}:{json.dumps(args, sort_keys=True, ensure_ascii=False)}"
        return "call_" + hashlib.md5(payload.encode("utf-8")).hexdigest()[:16]

    def _to_anthropic_tools(self, tools: list[dict]) -> list[dict]:
        """OpenAI function-calling 工具定义 -> Anthropic tools（input_schema）。"""
        out: list[dict] = []
        for t in tools:
            fn = t.get("function", t)
            item: dict[str, Any] = {
                "name": fn.get("name") or t.get("name"),
                "input_schema": fn.get("parameters") or fn.get("input_schema") or {"type": "object", "properties": {}},
            }
            description = fn.get("description") or t.get("description")
            if description:
                item["description"] = description
            if item["name"]:
                out.append(item)
        return out

    def _build_params(
        self,
        msgs: list[dict],
        kw: dict,
        *,
        system: str = "",
        tools: list[dict] | None = None,
    ) -> dict[str, Any]:
        """组装请求参数：调用方 kw 覆盖配置默认值。"""
        params: dict[str, Any] = {
            "model": kw.get("model") or self._model,
            "messages": msgs,
            "max_tokens": kw.get("max_tokens") or self._max_tokens,
        }
        temperature = kw.get("temperature", self._temperature)
        if temperature is not None:
            params["temperature"] = temperature
        if system:
            params["system"] = system
        if tools:
            params["tools"] = tools
        if kw.get("tool_choice"):
            params["tool_choice"] = kw["tool_choice"]
        return params

    # ------------------------------------------------------------------ #
    # token 统计
    # ------------------------------------------------------------------ #

    def _account_usage(self, usage: Any) -> None:
        """累计一次响应的 usage；cache 命中的 input token 一并计入 prompt。"""
        if usage is None:
            return
        prompt = (
            (getattr(usage, "input_tokens", 0) or 0)
            + (getattr(usage, "cache_creation_input_tokens", 0) or 0)
            + (getattr(usage, "cache_read_input_tokens", 0) or 0)
        )
        completion = getattr(usage, "output_tokens", 0) or 0
        if prompt or completion:
            self._usage.prompt_tokens += int(prompt)
            self._usage.completion_tokens += int(completion)

    @staticmethod
    def _safe_loads(raw: str | None) -> dict[str, Any]:
        """解析工具参数 JSON；非法或非对象时回退为空 dict（不中断调用链路）。"""
        if not raw:
            return {}
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("工具参数 JSON 解析失败，按空参数处理：%r", raw[:200])
            return {}
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _is_retryable(exc: BaseException) -> bool:
        return isinstance(exc, _RETRYABLE_ERRORS)

    async def _sleep_backoff(self, attempt: int) -> None:
        """指数退避：2^attempt 秒。"""
        await asyncio.sleep(2 ** attempt)

    # ------------------------------------------------------------------ #
    # 基础聊天
    # ------------------------------------------------------------------ #

    async def chat(self, messages: list[dict], **kw) -> str:
        """非流式对话：返回完整文本。"""
        msgs, system = self._to_anthropic(messages)
        params = self._build_params(msgs, kw, system=system)
        client = self._get_client()
        last_exc: Exception | None = None
        for attempt in range(self._retry_count + 1):
            try:
                resp = await client.messages.create(**params)
            except Exception as exc:  # noqa: BLE001 —— 按 _is_retryable 决定是否重试
                if not self._is_retryable(exc):
                    raise
                last_exc = exc
                if attempt >= self._retry_count:
                    break
                logger.warning("Anthropic 非流式请求失败（第 %d 次）将重试：%s", attempt + 1, exc)
                await self._sleep_backoff(attempt)
                continue
            self._account_usage(resp.usage)
            return "".join(block.text for block in resp.content if getattr(block, "type", "") == "text")
        assert last_exc is not None
        raise last_exc

    async def stream_chat(self, messages: list[dict], **kw) -> AsyncGenerator[str, None]:
        """纯文本流式对话：逐 text_delta 片段 yield 文本内容。"""
        msgs, system = self._to_anthropic(messages)
        params = self._build_params(msgs, kw, system=system)
        client = self._get_client()
        started = False  # 一旦开始产出文本就不再重试（避免重复发送已显示的文本）
        for attempt in range(self._retry_count + 1):
            input_tokens = 0  # 各轮次需重置，避免重试后误累计（仅在成功轮计入 usage）
            try:
                async with client.messages.stream(**params) as stream:
                    async for event in stream:
                        etype = getattr(event, "type", "")
                        if etype == "message_start":
                            usage = getattr(getattr(event, "message", None), "usage", None)
                            input_tokens = getattr(usage, "input_tokens", 0) or 0
                            continue
                        if etype == "content_block_delta":
                            delta = getattr(event, "delta", None)
                            if delta is not None and getattr(delta, "type", "") == "text_delta":
                                text = getattr(delta, "text", "")
                                if text:
                                    yield text
                                    started = True
                            continue
                        if etype == "message_delta":
                            # anthropic 在 message_delta 事件携带 output_tokens
                            usage = getattr(event, "usage", None)
                            output_tokens = getattr(usage, "output_tokens", 0) or 0
                            if input_tokens or output_tokens:
                                self._account_usage(
                                    _FakeUsage(input_tokens=input_tokens, output_tokens=output_tokens)
                                )
                            continue
                return
            except Exception as exc:  # noqa: BLE001
                if not self._is_retryable(exc) or started or attempt >= self._retry_count:
                    raise
                logger.warning("Anthropic 流式请求失败（第 %d 次）将重试：%s", attempt + 1, exc)
                await self._sleep_backoff(attempt)

    # ------------------------------------------------------------------ #
    # 工具调用
    # ------------------------------------------------------------------ #

    async def chat_with_tools(
        self, messages: list[dict], tools: list[dict], **kw
    ) -> ToolCallResult:
        """非流式工具调用：解析 tool_use 块归一化为 ToolCall 列表；无调用时返回文本。"""
        msgs, system = self._to_anthropic(messages)
        anthropic_tools = self._to_anthropic_tools(tools)
        params = self._build_params(msgs, kw, system=system, tools=anthropic_tools)
        client = self._get_client()
        last_exc: Exception | None = None
        for attempt in range(self._retry_count + 1):
            try:
                resp = await client.messages.create(**params)
            except Exception as exc:  # noqa: BLE001
                if not self._is_retryable(exc):
                    raise
                last_exc = exc
                if attempt >= self._retry_count:
                    break
                logger.warning("Anthropic 工具调用请求失败（第 %d 次）将重试：%s", attempt + 1, exc)
                await self._sleep_backoff(attempt)
                continue
            self._account_usage(resp.usage)
            text_parts: list[str] = []
            tool_calls: list[ToolCall] = []
            self._tool_ids = []
            for block in resp.content:
                btype = getattr(block, "type", "")
                if btype == "text":
                    text_parts.append(block.text)
                elif btype == "tool_use":
                    self._tool_ids.append(block.id)
                    tool_calls.append(
                        ToolCall(name=block.name, arguments=dict(block.input or {}))
                    )
            return ToolCallResult(text="".join(text_parts), tool_calls=tool_calls)
        assert last_exc is not None
        raise last_exc

    async def stream_chat_with_tools(
        self, messages: list[dict], tools: list[dict], **kw
    ) -> AsyncGenerator[str | dict, None]:
        """流式工具调用（yield 协议见模块 docstring）。

        文本片段 yield str；若模型发起工具调用，则在流结束时 yield 单个
        `{"__tool_call__": {"id", "name", "arguments"}}` dict（最后一个元素）。
        """
        msgs, system = self._to_anthropic(messages)
        anthropic_tools = self._to_anthropic_tools(tools)
        params = self._build_params(msgs, kw, system=system, tools=anthropic_tools)
        client = self._get_client()
        started = False
        for attempt in range(self._retry_count + 1):
            input_tokens = 0
            output_tokens = 0
            # 按 content block index 累积 tool_use（partial_json 分段拼接）
            tool_blocks: dict[int, dict[str, Any]] = {}
            try:
                async with client.messages.stream(**params) as stream:
                    async for event in stream:
                        etype = getattr(event, "type", "")
                        if etype == "message_start":
                            usage = getattr(getattr(event, "message", None), "usage", None)
                            input_tokens = getattr(usage, "input_tokens", 0) or 0
                            continue
                        if etype == "content_block_start":
                            block = getattr(event, "content_block", None)
                            if block is not None and getattr(block, "type", "") == "tool_use":
                                tool_blocks[event.index] = {
                                    "id": getattr(block, "id", "") or "",
                                    "name": getattr(block, "name", "") or "",
                                    "fragments": [],
                                    "start_input": block.input if hasattr(block, "input") else {},
                                }
                            continue
                        if etype == "content_block_delta":
                            delta = getattr(event, "delta", None)
                            if delta is None:
                                continue
                            dtype = getattr(delta, "type", "")
                            if dtype == "text_delta":
                                text = getattr(delta, "text", "")
                                if text:
                                    yield text
                                    started = True
                            elif dtype == "input_json_delta":
                                partial = getattr(delta, "partial_json", "") or ""
                                slot = tool_blocks.setdefault(
                                    event.index, {"id": "", "name": "", "fragments": [], "start_input": {}}
                                )
                                slot["fragments"].append(partial)
                            continue
                        if etype == "message_delta":
                            usage = getattr(event, "usage", None)
                            output_tokens = getattr(usage, "output_tokens", 0) or 0
                            continue
                # 流结束：计入 usage、整体归一化并返回工具调用
                if input_tokens or output_tokens:
                    self._account_usage(_FakeUsage(input_tokens=input_tokens, output_tokens=output_tokens))
                self._tool_ids = []
                for idx in sorted(tool_blocks):
                    slot = tool_blocks[idx]
                    raw = "".join(slot["fragments"])
                    arguments = self._safe_loads(raw) if raw else dict(slot["start_input"] or {})
                    self._tool_ids.append(slot["id"])
                    yield {
                        "__tool_call__": {
                            "id": slot["id"],
                            "name": slot["name"],
                            "arguments": arguments,
                        }
                    }
                return
            except Exception as exc:  # noqa: BLE001
                if not self._is_retryable(exc) or started or attempt >= self._retry_count:
                    raise
                logger.warning("Anthropic 流式工具调用失败（第 %d 次）将重试：%s", attempt + 1, exc)
                await self._sleep_backoff(attempt)


class _FakeUsage:
    """内存中的 usage 载体：把流式中分散的 input/output token 合拢后交给 _account_usage。"""

    def __init__(self, *, input_tokens: int, output_tokens: int) -> None:
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.cache_creation_input_tokens = 0
        self.cache_read_input_tokens = 0