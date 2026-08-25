"""OpenAI 协议适配器（openai SDK）。支持 OpenAI / Azure / vLLM / Ollama 兼容端点。

消息统一走 OpenAI 风格（system / user / assistant / tool），工具调用解析后
归一化为内部 `ToolCall(name, arguments)`，上层 Agent 无感知。

流式工具调用 yield 协议（chat_with_tools 的非流式版见 base.py 文档）：
- 文本部分逐片段 yield `str`；
- 若模型发起工具调用，则在流结束时 yield **单个 dict 作为最后一个元素**，
  形如 `{"__tool_call__": {"id": ..., "name": ..., "arguments": {...}}}`；
- 调用方通过 `isinstance(item, str)` 区分文本片段与工具调用标记。
"""
import asyncio
import json
import logging
from typing import Any, AsyncGenerator

import openai

from app.llm.base import BaseLLMProvider, ToolCall, ToolCallResult, Usage

logger = logging.getLogger("datapilot.llm.openai")

# 可重试异常：网络中断 / 超时 / 限流 / 服务端 5xx（认证与 4xx 不重试）
_RETRYABLE_ERRORS: tuple[type[Exception], ...] = (
    openai.APIConnectionError,
    openai.APITimeoutError,
    openai.RateLimitError,
    openai.InternalServerError,
)

_DEFAULT_TIMEOUT = 60.0
_DEFAULT_RETRY_COUNT = 1


class OpenAIAdapter(BaseLLMProvider):
    name = "openai"

    def __init__(self, config: dict):
        self._config = dict(config)
        self._model: str = self._config.get("model") or "gpt-4o"
        self._temperature: float | None = self._config.get("temperature")
        self._max_tokens: int | None = self._config.get("max_tokens")
        self._timeout: float = float(self._config.get("timeout") or _DEFAULT_TIMEOUT)
        self._retry_count: int = int(self._config.get("retry_count") or _DEFAULT_RETRY_COUNT)
        self._api_key: str = str(self._config.get("api_key") or "").strip()
        self._base_url: str | None = str(self._config.get("base_url") or "").strip() or None
        self._organization: str | None = str(self._config.get("organization") or "").strip() or None
        self._client: openai.AsyncOpenAI | None = None
        # 本适配器生命周期内累计的 token 用量（供会话级 usage 统计）
        self._usage = Usage()
        # 最近一次工具调用生成的 tool_call id（与返回顺序对齐，供消息重放）
        self._tool_ids: list[str] = []

    @property
    def usage(self) -> Usage:
        """累计 usage（prompt/completion tokens）。"""
        return self._usage

    @property
    def last_tool_ids(self) -> list[str]:
        """最近一次工具调用返回的 tool_call id，顺序与 ToolCall 列表对齐。"""
        return list(self._tool_ids)

    def _get_client(self) -> openai.AsyncOpenAI:
        """懒创建 AsyncOpenAI 客户端；api_key 缺失时抛出清晰的中文错误。"""
        if not self._api_key:
            raise RuntimeError("未配置 OpenAI API Key：请在系统配置中填写 llm.openai 的 api_key 字段")
        if self._client is None:
            self._client = openai.AsyncOpenAI(
                api_key=self._api_key,
                base_url=self._base_url,
                organization=self._organization,
                timeout=self._timeout,
                max_retries=0,  # SDK 层关闭重试，重试策略由本适配器按 retry_count 控制
            )
        return self._client

    def _build_params(
        self,
        messages: list[dict],
        kw: dict,
        *,
        stream: bool,
        tools: list[dict] | None = None,
    ) -> dict[str, Any]:
        """组装请求参数：调用方 kw 覆盖配置默认值。"""
        params: dict[str, Any] = {
            "model": kw.get("model") or self._model,
            "messages": messages,
            "stream": stream,
        }
        temperature = kw.get("temperature", self._temperature)
        if temperature is not None:
            params["temperature"] = temperature
        max_tokens = kw.get("max_tokens", self._max_tokens)
        if max_tokens:
            params["max_tokens"] = max_tokens
        if tools is not None:
            params["tools"] = tools
        if kw.get("tool_choice"):
            params["tool_choice"] = kw["tool_choice"]
        return params

    def _account_usage(self, usage: Any) -> None:
        """累计一次响应的 usage（响应对象可能不提供 usage，此时忽略）。"""
        if usage is None:
            return
        prompt = getattr(usage, "prompt_tokens", 0) or 0
        completion = getattr(usage, "completion_tokens", 0) or 0
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

    async def chat(self, messages: list[dict], **kw) -> str:
        """非流式对话：返回完整文本。"""
        params = self._build_params(messages, kw, stream=False)
        client = self._get_client()
        last_exc: Exception | None = None
        for attempt in range(self._retry_count + 1):
            try:
                resp = await client.chat.completions.create(**params)
            except Exception as exc:  # noqa: BLE001 —— 按 _is_retryable 决定是否重试
                if not self._is_retryable(exc):
                    raise
                last_exc = exc
                if attempt >= self._retry_count:
                    break
                logger.warning("OpenAI 非流式请求失败（第 %d 次）将重试：%s", attempt + 1, exc)
                await self._sleep_backoff(attempt)
                continue
            if resp.usage is not None:
                self._account_usage(resp.usage)
            return resp.choices[0].message.content or ""
        assert last_exc is not None
        raise last_exc

    async def stream_chat(self, messages: list[dict], **kw) -> AsyncGenerator[str, None]:
        """纯文本流式对话：逐 token/片段 yield 文本内容。"""
        params = self._build_params(messages, kw, stream=True)
        params["stream_options"] = {"include_usage": True}  # 末帧返回 usage
        client = self._get_client()
        started = False  # 一旦开始产出文本就不再重试（避免重复发送已显示的 token）
        for attempt in range(self._retry_count + 1):
            try:
                stream = await client.chat.completions.create(**params)
                async for chunk in stream:
                    if chunk.usage is not None:
                        self._account_usage(chunk.usage)
                    if not chunk.choices:
                        continue
                    delta = chunk.choices[0].delta
                    content = delta.content if delta else None
                    if content:
                        yield content
                        started = True
                return
            except Exception as exc:  # noqa: BLE001
                # vLLM / Ollama 等本地端点可能不识别 stream_options.include_usage：
                # 去掉该参数后立即重试，其余错误走指数退避
                if (
                    isinstance(exc, openai.BadRequestError)
                    and params.get("stream_options") is not None
                    and not started
                ):
                    params.pop("stream_options")
                    logger.warning("远端端点不支持 stream_options.include_usage，已降级重试：%s", exc)
                    continue
                if not self._is_retryable(exc) or started or attempt >= self._retry_count:
                    raise
                logger.warning("OpenAI 流式请求失败（第 %d 次）将重试：%s", attempt + 1, exc)
                await self._sleep_backoff(attempt)

    async def chat_with_tools(
        self, messages: list[dict], tools: list[dict], **kw
    ) -> ToolCallResult:
        """非流式工具调用：解析 tool_calls 归一化为 ToolCall 列表；无调用时返回文本。"""
        params = self._build_params(messages, kw, stream=False, tools=tools)
        client = self._get_client()
        last_exc: Exception | None = None
        for attempt in range(self._retry_count + 1):
            try:
                resp = await client.chat.completions.create(**params)
            except Exception as exc:  # noqa: BLE001
                if not self._is_retryable(exc):
                    raise
                last_exc = exc
                if attempt >= self._retry_count:
                    break
                logger.warning("OpenAI 工具调用请求失败（第 %d 次）将重试：%s", attempt + 1, exc)
                await self._sleep_backoff(attempt)
                continue
            if resp.usage is not None:
                self._account_usage(resp.usage)
            message = resp.choices[0].message
            tool_calls: list[ToolCall] = []
            text = message.content or ""
            self._tool_ids = []
            raw_calls = message.tool_calls or []
            for tc in raw_calls:
                self._tool_ids.append(tc.id or "")
                tool_calls.append(
                    ToolCall(
                        name=tc.function.name if tc.function else "",
                        arguments=self._safe_loads(tc.function.arguments if tc.function else None),
                    )
                )
            return ToolCallResult(text=text, tool_calls=tool_calls)
        assert last_exc is not None
        raise last_exc

    async def stream_chat_with_tools(
        self, messages: list[dict], tools: list[dict], **kw
    ) -> AsyncGenerator[str | dict, None]:
        """流式工具调用（yield 协议见模块 docstring）。

        文本片段 yield str；若模型发起工具调用，则在流结束时 yield 单个
        `{"__tool_call__": {"id", "name", "arguments"}}` dict（最后一个元素）。
        """
        params = self._build_params(messages, kw, stream=True, tools=tools)
        params["stream_options"] = {"include_usage": True}
        client = self._get_client()
        started = False
        for attempt in range(self._retry_count + 1):
            # 按 index 累积 tool_call 增量片段：id / name 一次性下发，arguments 分段拼接
            tool_calls: dict[int, dict[str, str]] = {}
            try:
                stream = await client.chat.completions.create(**params)
                async for chunk in stream:
                    if chunk.usage is not None:
                        self._account_usage(chunk.usage)
                    if not chunk.choices:
                        continue
                    delta = chunk.choices[0].delta
                    if delta is None:
                        continue
                    if delta.content:
                        yield delta.content
                        started = True
                    if delta.tool_calls:
                        for piece in delta.tool_calls:
                            slot = tool_calls.setdefault(piece.index, {"id": "", "name": "", "arguments": ""})
                            if piece.id:
                                slot["id"] += piece.id
                            fn = piece.function
                            if fn:
                                if fn.name:
                                    slot["name"] += fn.name
                                if fn.arguments:
                                    slot["arguments"] += fn.arguments
                # 流结束：整体归一化并返回工具调用
                self._tool_ids = []
                ordered = [tool_calls[i] for i in sorted(tool_calls)]
                if ordered:
                    for slot in ordered:
                        self._tool_ids.append(slot["id"])
                        yield {
                            "__tool_call__": {
                                "id": slot["id"],
                                "name": slot["name"],
                                "arguments": self._safe_loads(slot["arguments"]),
                            }
                        }
                return
            except Exception as exc:  # noqa: BLE001
                # vLLM / Ollama 等本地端点可能不识别 stream_options.include_usage：
                # 去掉该参数后立即重试，其余错误走指数退避
                if (
                    isinstance(exc, openai.BadRequestError)
                    and params.get("stream_options") is not None
                    and not started
                ):
                    params.pop("stream_options")
                    logger.warning("远端端点不支持 stream_options.include_usage，已降级重试：%s", exc)
                    continue
                if not self._is_retryable(exc) or started or attempt >= self._retry_count:
                    raise
                logger.warning("OpenAI 流式工具调用失败（第 %d 次）将重试：%s", attempt + 1, exc)
                await self._sleep_backoff(attempt)