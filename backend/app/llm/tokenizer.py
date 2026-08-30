"""模型上下文窗口登记与 Token 预估（契约 docs/技术方案设计.md 4.8）。

职责：
1. `get_context_window(model, override)` —— 由模型名推导上下文窗口：
   精确名 → 前缀匹配 → 未知模型保守默认；支持 LLM 配置 `context_window` 显式覆盖。
2. `token_estimator` —— 请求前 token 预估：
   - OpenAI 兼容模型：tiktoken（`encoding_for_model`，缓存 encoder）精确计数；
   - Claude 系：无官方本地 BPE（tiktoken 的 claude-3 编码不可靠，官方 count_tokens 需联网），
     用 `len/3.5 × 1.25` 启发式，并用每次响应真实 prompt_tokens 做进程内自校准
     （乘子夹在 [0.8, 2.0]，防单次波动与畸形文本拖垮预算）。
"""
import logging

logger = logging.getLogger("datapilot.llm.tokenizer")

# 上下文窗口登记（token）：精确名优先，其次前缀，未知模型回退保守值。
# OpenAI 兼容端点（vLLM / Ollama 自定义模型）无法命中时同样回退默认值。
MODEL_CONTEXT_WINDOWS: dict[str, int] = {
    # OpenAI / GPT
    "gpt-4o": 128_000,
    "gpt-4o-mini": 128_000,
    "gpt-4.1": 1_047_576,
    "gpt-4.1-mini": 1_047_576,
    "gpt-4-turbo": 128_000,
    "gpt-4": 8_192,
    "gpt-3.5-turbo": 16_385,
    # Anthropic / Claude
    "claude-sonnet-4-20250514": 200_000,
    "claude-opus-4-20250514": 200_000,
    "claude-3-5-sonnet-20241022": 200_000,
    "claude-3-5-haiku-20241022": 200_000,
    "claude-3-haiku-20240307": 200_000,
}

# 前缀 → 窗口（注意顺序：更具体的放前面）
CONTEXT_PREFIX_RULES: list[tuple[str, int]] = [
    ("gpt-4.1", 1_047_576),
    ("gpt-4o", 128_000),
    ("gpt-4-turbo", 128_000),
    ("gpt-3.5-turbo", 16_385),
    ("claude-sonnet-4", 200_000),
    ("claude-opus-4", 200_000),
    ("claude-3", 200_000),
    ("o1", 200_000),
    ("o3", 200_000),
    ("o4", 400_000),
]

# 未知模型保守默认（防真实窗口更小导致超限，而非赌更大窗口）
DEFAULT_CONTEXT_WINDOW = 32_768

# Claude 启发式：Anthropic 官方口径约 1 token / 3.5 字符，加 25% 安全系数
_CLAUDE_CHARS_PER_TOKEN = 3.5
_CLAUDE_SAFETY = 1.25
# 自校准乘子上下限
_CALIBRATE_MIN = 0.8
_CALIBRATE_MAX = 2.0


def get_context_window(model: str, override: int | None = None) -> int:
    """模型上下文窗口：显式 override > 精确名 > 前缀匹配 > 默认。"""
    if isinstance(override, int) and override > 0:
        return override
    key = (model or "").strip().lower()
    if not key:
        return DEFAULT_CONTEXT_WINDOW
    if key in MODEL_CONTEXT_WINDOWS:
        return MODEL_CONTEXT_WINDOWS[key]
    for prefix, window in CONTEXT_PREFIX_RULES:
        if key.startswith(prefix):
            return window
    return DEFAULT_CONTEXT_WINDOW


class TokenEstimator:
    """请求前 token 预估器。

    进程内缓存 encoder（tiktoken 加载较慢，只初始化一次）；Claude 系按
    字符启发式并带安全系数，再以真实 usage 校准乘子（仅在精度上有意义时更新）。
    """

    def __init__(self) -> None:
        self._encoders: dict[str, object] = {}
        self._calib: dict[str, float] = {}  # f"{provider}:{model}" -> 乘子

    # ---------- 对外 ----------
    def estimate(self, provider: str, model: str, text: str) -> int:
        if not text:
            return 0
        if provider != "anthropic" and not (model or "").lower().startswith("claude"):
            enc = self._get_encoding(model)
            if enc is not None:
                return len(enc.encode(text))
        n = max(1, int(len(text) / _CLAUDE_CHARS_PER_TOKEN * _CLAUDE_SAFETY))
        mult = self._calib.get(f"{provider}:{model}")
        if mult is not None:
            n = max(1, int(n * mult))
        return n

    def calibrate(self, provider: str, model: str, estimated: int, real: int) -> None:
        """用响应真实 prompt_tokens 校准启发式乘子（tiktoken 路径不受影响）。

        estimated 为本次请求组装时的历史段预估，real 为 provider 返回的真实
        prompt_tokens；只在校准值有效且偏差明显时更新，避免噪声累积。
        """
        if estimated <= 0 or real <= 0:
            return
        ratio = real / estimated
        if ratio < 0.85 or ratio > 1.18:  # 偏差 >15% 才值得校准
            key = f"{provider}:{model}"
            cur = self._calib.get(key)
            # 平滑更新：与旧值加权，防单次波动；首次直接取当前比值
            if cur is None:
                self._calib[key] = round(max(_CALIBRATE_MIN, min(_CALIBRATE_MAX, ratio)), 3)
            else:
                blended = cur * 0.5 + ratio * 0.5
                self._calib[key] = round(max(_CALIBRATE_MIN, min(_CALIBRATE_MAX, blended)), 3)

    # ---------- 内部 ----------
    def _get_encoding(self, model: str):
        """tiktoken 编码：已知模型精确匹配，失败回退 cl100k_base。"""
        key = (model or "").strip() or "cl100k_base"
        if key in self._encoders:
            return self._encoders[key]
        try:
            import tiktoken

            try:
                enc = tiktoken.encoding_for_model(key)
            except KeyError:
                enc = tiktoken.get_encoding("cl100k_base")
            self._encoders[key] = enc
            return enc
        except Exception as exc:  # tiktoken 未安装 / 数据加载失败：降级启发式，不影响主流程
            logger.warning("tiktoken 不可用，token 预估降级为启发式: %s", exc)
            self._encoders[key] = None
            return None


# 进程内单例（预算与校准共享）
token_estimator = TokenEstimator()
