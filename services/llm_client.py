"""LLM 客户端 (Anthropic Messages + OpenAI-compatible/Kimi).

支持的厂商示例:
  - Anthropic 官方:  base_url=https://api.anthropic.com,  header=x-api-key
  - Kimi/Moonshot:   provider=openai_compatible, base_url=https://api.moonshot.cn/v1,
                     header=Authorization, prefix=Bearer
  - OpenAI兼容端点:   provider=openai_compatible, base_url=https://.../v1,
                     header=Authorization, prefix=Bearer
  - 自定义代理:       任意 base_url + 可配 header

配置优先级 (每一项): 环境变量 > DB 配置 > 默认值

环境变量:
  LLM_BASE_URL         API 基础地址 (不含 /v1/messages)
  LLM_PROVIDER         anthropic | openai_compatible
  LLM_API_KEY          通用 API key
  LLM_API_KEY_HEADER   鉴权 header 名, 默认 x-api-key
  LLM_API_KEY_PREFIX   鉴权值前缀, 如 Bearer
  LLM_PROXY            HTTP 代理地址
  LLM_MODEL_MAP        模型别名 JSON, 如 {"smart":"deepseek-chat","fast":"deepseek-chat"}
  ANTHROPIC_API_KEY    (兼容旧版) Anthropic 官方 API key

向后兼容:
  - 不设 LLM_API_KEY 时, 继续走 ANTHROPIC_API_KEY → Keychain OAuth 鉴权链
  - 不设 LLM_BASE_URL 时, 默认用 api.anthropic.com
  - 行为与重构前完全一致
"""
from __future__ import annotations
import json
import logging
import os
import re
import subprocess
import threading
import time
import uuid
import shutil
from urllib.parse import urlparse

import requests

logger = logging.getLogger(__name__)

# ── 默认值 ──────────────────────────────────────────────
_DEFAULT_BASE_URL = "https://api.anthropic.com"
_DEFAULT_API_KEY_HEADER = "x-api-key"
_DEFAULT_PROVIDER = "anthropic"
_PROVIDER_ALIASES = {
    "anthropic": "anthropic",
    "claude": "anthropic",
    "openai": "openai_compatible",
    "openai_compatible": "openai_compatible",
    "openai-compatible": "openai_compatible",
    "kimi": "openai_compatible",
    "moonshot": "openai_compatible",
    "qwen": "openai_compatible",
    "tongyi": "openai_compatible",
    "dashscope": "openai_compatible",
    "minimax": "openai_compatible",
    "minimaxi": "openai_compatible",
}

# ── 运行时可变状态 ─────────────────────────────────────
_base_url: str = os.environ.get("LLM_BASE_URL", "") or _DEFAULT_BASE_URL
_provider: str = _PROVIDER_ALIASES.get(
    (os.environ.get("LLM_PROVIDER", "") or _DEFAULT_PROVIDER).strip().lower(),
    _DEFAULT_PROVIDER,
)
_api_key: str = os.environ.get("LLM_API_KEY", "")
_api_key_header: str = os.environ.get("LLM_API_KEY_HEADER", "") or _DEFAULT_API_KEY_HEADER
_api_key_prefix: str = os.environ.get("LLM_API_KEY_PREFIX", "")
_model_map: dict[str, str] = {}
_extra_body: dict = {}
_proxy_url: str = os.environ.get("LLM_PROXY", "")
_config_lock = threading.Lock()

# ── HTTP sessions ──────────────────────────────────────
_llm_session = requests.Session()
_llm_session.trust_env = False

_direct_session = requests.Session()
_direct_session.trust_env = False


def _apply_proxy():
    """Apply proxy to _llm_session. LLM 自己的 _proxy_url 优先; 留空则回退到统一的
    本地代理(proxy_config), 这样面板里设一个代理 OKX/LLM 都能用。"""
    from services import proxy_config
    url = _proxy_url or proxy_config.get_proxy()
    _llm_session.proxies = {"http": url, "https": url} if url else {}


_apply_proxy()
# 统一代理变化时, 若 LLM 没设自己的代理, 跟着更新
from services import proxy_config as _pc
_pc.on_change(lambda _url: _apply_proxy())


# ── 模型别名映射 ───────────────────────────────────────
def _parse_model_map(raw: str | None) -> dict[str, str]:
    """Parse JSON model map string, return dict or empty on failure."""
    if not raw or not raw.strip():
        return {}
    try:
        d = json.loads(raw)
        if isinstance(d, dict):
            filtered = {k: v for k, v in d.items() if isinstance(k, str) and isinstance(v, str)}
            dropped = len(d) - len(filtered)
            if dropped:
                logger.warning("model_map: dropped %d non-string entries", dropped)
            return filtered
    except (json.JSONDecodeError, TypeError):
        logger.warning("model_map: invalid JSON, ignoring: %s", raw[:100])
    return {}


def _parse_extra_body(raw: str | None) -> dict:
    """Parse arbitrary OpenAI-compatible provider extension JSON."""
    if not raw or not raw.strip():
        return {}
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else {}
    except (json.JSONDecodeError, TypeError):
        logger.warning("extra_body: invalid JSON, ignoring: %s", raw[:100])
        return {}


# Apply env var model map immediately
_env_map = os.environ.get("LLM_MODEL_MAP", "")
if _env_map:
    _model_map = _parse_model_map(_env_map)

_env_extra_body = os.environ.get("LLM_EXTRA_BODY", "")
if _env_extra_body:
    _extra_body = _parse_extra_body(_env_extra_body)


# ── 重试配置 ──────────────────────────────────────────
_MAX_RETRIES = int(os.environ.get("LLM_MAX_RETRIES", "3"))           # 总尝试次数 = 1 + retries
_RETRY_INITIAL_BACKOFF_S = float(os.environ.get("LLM_RETRY_BACKOFF", "1.0"))  # 首次退避秒
_RETRY_MAX_BACKOFF_S = float(os.environ.get("LLM_RETRY_MAX_BACKOFF", "8.0"))  # 最大退避秒
# (连接超时, 读超时): 连接快失败重试; 读放宽, 因 server 端 web_search 多次检索会把单次响应拉长到分钟级
_HTTP_TIMEOUT = (10, float(os.environ.get("LLM_READ_TIMEOUT", "180")))
# 可重试的 HTTP 状态码 (server-side transient)
_RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}
# 可重试的网络异常
_RETRYABLE_EXC = (
    requests.exceptions.ConnectionError,
    requests.exceptions.Timeout,
    requests.exceptions.ChunkedEncodingError,
    requests.exceptions.ContentDecodingError,
)

# Kimi/Moonshot may enforce organization-level QPS.  Serialize LLM calls in this
# process and keep a small configurable gap to avoid stampedes when a page loads
# multiple AI widgets at once. Set LLM_MIN_INTERVAL=0 to disable.
_MIN_INTERVAL_S = float(os.environ.get("LLM_MIN_INTERVAL", "1.2"))
_request_lock = threading.Lock()
_last_request_at = 0.0


# 逻辑别名默认映射: 用户没配自定义 model_map 时, smart/balanced/fast 兜底到真实
# Anthropic 模型, 否则"fast"会原样发出去被 404(测试连接/默认调用都受影响)。
_DEFAULT_ALIASES = {
    "smart": "claude-opus-4-8",
    "balanced": "claude-sonnet-5",
    "fast": "claude-sonnet-5",   # 不用 haiku, 最低也走 sonnet
}
_OPENAI_COMPAT_ALIASES = {
    "smart": "kimi-k2.6",
    "balanced": "kimi-k2.6",
    "fast": "kimi-k2.6",
    # Existing callers may pass concrete Claude model names (not aliases), e.g.
    # stock_agent._MODEL = "claude-opus-4-8".  When the provider is Kimi/OpenAI
    # compatible, route those legacy defaults to the configured Kimi default
    # instead of sending an invalid Claude model name to Moonshot/Kimi.
    "claude-opus-4-8": "kimi-k2.6",
    "claude-sonnet-4-6": "kimi-k2.6",
    "claude-sonnet-5": "kimi-k2.6",
    "claude-haiku-4-5": "kimi-k2.6",
}


def resolve_model(model: str) -> str:
    """Resolve a model name through the alias map.

    If model is a known alias (smart/balanced/fast), return the mapped value.
    优先用户自定义 map, 再默认别名, 最后原样返回(直接模型名, 向后兼容)。
    """
    if model in _model_map:
        return _model_map[model]
    if _is_openai_compatible():
        return _OPENAI_COMPAT_ALIASES.get(model, model)
    return _DEFAULT_ALIASES.get(model, model)


def get_model_map() -> dict[str, str]:
    """Return a copy of the current model alias map."""
    return dict(_model_map)


def _apply_openai_extra_body(payload: dict) -> dict:
    """Merge provider-specific OpenAI-compatible extension fields.

    MiniMax's OpenAI-compatible endpoint documents max_completion_tokens and
    thinking instead of max_tokens/reasoning_split, so adapt when the MiniMax
    base URL or thinking extension is configured.
    """
    if _extra_body:
        payload.update(_extra_body)
    base = (_base_url or "").lower()
    if ("minimax" in base or "minimaxi" in base or "thinking" in payload):
        if "max_tokens" in payload and "max_completion_tokens" not in payload:
            payload["max_completion_tokens"] = payload.pop("max_tokens")
    return payload


# ── 公共配置 API ───────────────────────────────────────

def configure_llm(
    base_url: str = "",
    provider: str = "",
    api_key: str = "",
    api_key_header: str = "",
    api_key_prefix: str = "",
    proxy: str = "",
    model_map: dict[str, str] | None = None,
    extra_body: dict | None = None,
):
    """运行时更新 LLM 配置 (从 DB 加载后调用)。

    环境变量优先级最高, 这里只设置 '没被 env var 覆盖' 的项。
    """
    global _base_url, _provider, _api_key, _api_key_header, _api_key_prefix, _proxy_url, _model_map, _extra_body

    with _config_lock:
        if not os.environ.get("LLM_PROVIDER") and provider:
            _provider = _normalize_provider(provider)
        if not os.environ.get("LLM_BASE_URL") and base_url:
            _base_url = base_url
        if not os.environ.get("LLM_API_KEY") and api_key:
            _api_key = api_key
        if not os.environ.get("LLM_API_KEY_HEADER") and api_key_header:
            _api_key_header = api_key_header
        if not os.environ.get("LLM_API_KEY_PREFIX") and api_key_prefix:
            _api_key_prefix = api_key_prefix
        if not os.environ.get("LLM_PROXY") and proxy:
            _proxy_url = proxy
            _apply_proxy()
        if not os.environ.get("LLM_MODEL_MAP") and model_map is not None:
            _model_map = model_map
        if not os.environ.get("LLM_EXTRA_BODY") and extra_body is not None:
            _extra_body = extra_body


def get_llm_config() -> dict:
    """返回当前 LLM 配置 (脱敏, 用于 Settings API)."""
    return {
        "provider": _provider,
        "base_url": _base_url,
        "api_key": _mask_key(_api_key) if _api_key else "",
        "has_api_key": bool(_api_key),
        "api_key_header": _api_key_header,
        "api_key_prefix": _api_key_prefix,
        "proxy": _proxy_url,
        "model_map": _model_map,
        "extra_body": _extra_body,
        "using_oauth_fallback": not _api_key and not os.environ.get("ANTHROPIC_API_KEY", "").strip(),
    }


def _mask_key(key: str) -> str:
    if len(key) <= 8:
        return "****"
    return key[:4] + "****" + key[-4:]


def _normalize_provider(provider: str | None) -> str:
    p = (provider or "").strip().lower()
    return _PROVIDER_ALIASES.get(p, _DEFAULT_PROVIDER)


def _is_openai_compatible() -> bool:
    return _provider == "openai_compatible"


# ── 内部: 鉴权解析 ─────────────────────────────────────

# Required: when using OAuth token, system prompt must begin with this identity
CLAUDE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

CLAUDE_CODE_HEADERS = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    "anthropic-dangerous-direct-browser-access": "true",
    "User-Agent": "claude-cli/2.1.193 (external, cli)",
    "x-app": "cli",
    "X-Stainless-Lang": "js",
    "X-Stainless-Package-Version": "0.94.0",
    "X-Stainless-Runtime": "node",
}

_cached_token: str | None = None


def _is_anthropic_official() -> bool:
    """Check if we're talking to api.anthropic.com."""
    if _provider != "anthropic":
        return False
    try:
        netloc = urlparse(_base_url).netloc
        return netloc == "api.anthropic.com"
    except Exception:
        return False


def _build_api_url() -> str:
    """Build the full API URL for the selected provider."""
    if _is_openai_compatible():
        base = _base_url.rstrip("/")
        if base.endswith("/chat/completions"):
            return base
        if base.endswith("/v1"):
            return base + "/chat/completions"
        return base + "/v1/chat/completions"
    url = _base_url.rstrip("/") + "/v1/messages"
    if _is_anthropic_official():
        url += "?beta=true"
    return url


def _resolve_auth() -> tuple[str, bool]:
    """Returns (token, is_oauth).

    Priority:
    1. LLM_API_KEY (通用, 不区分厂商)
    2. ANTHROPIC_API_KEY (Anthropic 官方)
    3. macOS Keychain OAuth token
    """
    global _cached_token

    # ── 通用 API key (优先) ──
    if _api_key:
        return _api_key, False

    if _is_openai_compatible():
        raise RuntimeError(
            "无法获取 OpenAI-compatible/Kimi API 凭证。请设置 LLM_API_KEY, "
            "或在 Settings 页面配置 API key。"
        )

    # ── Anthropic 官方 API key (兼容旧版) ──
    env_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if env_key and "your-key" not in env_key:
        return env_key, "sk-ant-oat" in env_key

    # ── macOS Keychain OAuth (Claude Code CLI 登录后) ──
    if _cached_token:
        return _cached_token, True

    if os.uname().sysname == "Darwin":
        try:
            result = subprocess.run(
                ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0:
                data = json.loads(result.stdout.strip())
                token = data.get("claudeAiOauth", {}).get("accessToken", "")
                if token:
                    with _config_lock:
                        _cached_token = token
                    return token, True
        except Exception:
            pass

    raise RuntimeError(
        "无法获取 LLM API 凭证。请设置 LLM_API_KEY 或 ANTHROPIC_API_KEY 环境变量, "
        "或在 Settings 页面配置 API key。"
    )


def _build_headers(token: str, is_oauth: bool) -> dict:
    """Build request headers based on auth mode."""
    if is_oauth:
        headers = {**CLAUDE_CODE_HEADERS, "Authorization": f"Bearer {token}"}
        headers["X-Claude-Code-Session-Id"] = str(uuid.uuid4())
        return headers

    # ── 通用 API key 模式 ──
    headers = {"Content-Type": "application/json"}
    if not _is_openai_compatible():
        headers["anthropic-version"] = "2023-06-01"

    if _api_key_header.lower() == "authorization":
        prefix = f"{_api_key_prefix.strip()} " if _api_key_prefix.strip() else ""
        headers["Authorization"] = f"{prefix}{token}".strip()
    else:
        if _api_key_prefix:
            logger.warning(
                "api_key_prefix=%r ignored because api_key_header=%r (not Authorization). "
                "Prefix only applies when header is Authorization.",
                _api_key_prefix, _api_key_header,
            )
        headers[_api_key_header] = token

    return headers


def _build_system(system: str | None, is_oauth: bool):
    """Build system prompt block(s)."""
    if is_oauth:
        system_blocks = [{"type": "text", "text": CLAUDE_IDENTITY}]
        if system:
            system_blocks.append({"type": "text", "text": system})
        return system_blocks
    return system


def _anthropic_content_to_text(content) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text":
                parts.append(b.get("text") or "")
            elif b.get("type") == "tool_result":
                c = b.get("content")
                parts.append(c if isinstance(c, str) else json.dumps(c, ensure_ascii=False))
        return "\n".join(p for p in parts if p)
    return str(content)


def _openai_content_to_text(content) -> str:
    """Extract text from OpenAI-compatible message.content.

    Most providers return a string, while some return content blocks. Kimi Code
    compatible gateways may also leave content empty when the useful text is in
    reasoning_content; callers handle that fallback separately.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, str):
                parts.append(b)
            elif isinstance(b, dict):
                if b.get("type") in ("text", "output_text"):
                    parts.append(b.get("text") or b.get("content") or "")
                elif isinstance(b.get("text"), str):
                    parts.append(b.get("text") or "")
        return "".join(parts)
    return str(content)


def _openai_user_content(content):
    """Convert Anthropic text/image user content to OpenAI-compatible content."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return str(content)

    out = []
    for b in content:
        if not isinstance(b, dict):
            continue
        typ = b.get("type")
        if typ == "text":
            out.append({"type": "text", "text": b.get("text") or ""})
        elif typ == "image":
            src = b.get("source") or {}
            media = src.get("media_type") or "image/png"
            data = src.get("data") or ""
            if data:
                out.append({"type": "image_url", "image_url": {"url": f"data:{media};base64,{data}"}})
    return out or _anthropic_content_to_text(content)


def _anthropic_messages_to_openai(messages: list, system: str | None) -> list:
    """Convert Anthropic Messages API format to OpenAI Chat Completions format."""
    out = []
    if system:
        out.append({"role": "system", "content": system})

    for m in messages:
        role = m.get("role")
        content = m.get("content")

        if role == "assistant" and isinstance(content, list):
            text_parts = [b.get("text") or "" for b in content
                          if isinstance(b, dict) and b.get("type") == "text"]
            tool_uses = [b for b in content
                         if isinstance(b, dict) and b.get("type") == "tool_use"]
            msg = {"role": "assistant", "content": "".join(text_parts) or None}
            if tool_uses:
                msg["tool_calls"] = []
                for tu in tool_uses:
                    msg["tool_calls"].append({
                        "id": tu.get("id") or str(uuid.uuid4()),
                        "type": "function",
                        "function": {
                            "name": tu.get("name") or "unknown_tool",
                            "arguments": json.dumps(tu.get("input") or {}, ensure_ascii=False),
                        },
                    })
            out.append(msg)
            continue

        if role == "user" and isinstance(content, list) and all(
            isinstance(b, dict) and b.get("type") == "tool_result" for b in content
        ):
            for tr in content:
                c = tr.get("content")
                out.append({
                    "role": "tool",
                    "tool_call_id": tr.get("tool_use_id") or str(uuid.uuid4()),
                    "content": c if isinstance(c, str) else json.dumps(c, ensure_ascii=False),
                })
            continue

        if role == "user":
            out.append({"role": "user", "content": _openai_user_content(content)})
        elif role == "assistant":
            out.append({"role": "assistant", "content": _anthropic_content_to_text(content)})
    return out


def _anthropic_tools_to_openai(tools: list | None) -> list | None:
    if not tools:
        return None
    out = []
    for t in tools:
        if not isinstance(t, dict):
            continue
        # Anthropic server tools such as web_search_20250305 cannot be sent to Kimi/OpenAI.
        if t.get("type", "custom") != "custom" and not t.get("name"):
            continue
        name = t.get("name")
        if not name:
            continue
        out.append({
            "type": "function",
            "function": {
                "name": name,
                "description": t.get("description") or "",
                "parameters": t.get("input_schema") or {"type": "object", "properties": {}},
            },
        })
    return out or None


def _openai_response_to_anthropic(data: dict) -> dict:
    choices = data.get("choices") or []
    msg = (choices[0].get("message") if choices else {}) or {}
    content = []
    text = _openai_content_to_text(msg.get("content"))
    if not text and isinstance(msg.get("reasoning_content"), str):
        text = msg.get("reasoning_content") or ""
    if text:
        content.append({"type": "text", "text": text})
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        raw_args = fn.get("arguments") or "{}"
        try:
            args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
        except Exception:
            args = {"_raw": raw_args}
        content.append({
            "type": "tool_use",
            "id": tc.get("id") or str(uuid.uuid4()),
            "name": fn.get("name") or "unknown_tool",
            "input": args,
        })
    finish = choices[0].get("finish_reason") if choices else None
    return {
        "id": data.get("id", ""),
        "type": "message",
        "role": "assistant",
        "model": data.get("model", ""),
        "content": content,
        "stop_reason": "tool_use" if msg.get("tool_calls") else (finish or "end_turn"),
        "usage": data.get("usage") or {},
        "_provider": "openai_compatible",
    }


def _post_with_fallback(headers: dict, payload: dict) -> requests.Response:
    """POST to API, falling back to direct if proxy errors."""
    api_url = _build_api_url()
    try:
        return _llm_session.post(api_url, headers=headers, json=payload, timeout=_HTTP_TIMEOUT)
    except requests.exceptions.ProxyError:
        return _direct_session.post(api_url, headers=headers, json=payload, timeout=_HTTP_TIMEOUT)


def _compute_backoff(attempt: int, retry_after: str | None) -> float:
    """Compute backoff seconds. Respects Retry-After header if present and valid."""
    if retry_after:
        try:
            return max(float(retry_after), 0.1)
        except (ValueError, TypeError):
            pass
    return min(_RETRY_INITIAL_BACKOFF_S * (2 ** attempt), _RETRY_MAX_BACKOFF_S)


def _throttle_before_request() -> None:
    """Global in-process LLM throttle to reduce provider 429s."""
    global _last_request_at
    if _MIN_INTERVAL_S <= 0:
        return
    with _request_lock:
        now = time.time()
        wait = _MIN_INTERVAL_S - (now - _last_request_at)
        if wait > 0:
            time.sleep(wait)
            now = time.time()
        _last_request_at = now


def _post_with_retry(headers: dict, payload: dict) -> requests.Response:
    """POST with proxy fallback + retry on transient failures.

    Retries on:
      - Network errors: ConnectionError, Timeout, ChunkedEncodingError, ContentDecodingError
      - HTTP status: 408, 425, 429, 500, 502, 503, 504

    Does NOT retry on:
      - 401 (handled separately via _retry_on_oauth_401 for OAuth flow)
      - 4xx other than above (client error, won't help)
      - Successful responses

    Backoff: exponential, respects Retry-After header.

    NOTE: Uses blocking `time.sleep`. Must be called from a worker thread
    (e.g. via `asyncio.to_thread`) — calling from an async event loop will
    freeze it for up to ~15s (1+2+4+8s worst case with default settings).
    """
    api_url = _build_api_url()
    last_exc: Exception | None = None

    for attempt in range(_MAX_RETRIES + 1):
        try:
            _throttle_before_request()
            resp = _llm_session.post(api_url, headers=headers, json=payload, timeout=_HTTP_TIMEOUT)
        except requests.exceptions.ProxyError:
            # Proxy unreachable, try direct session once per attempt
            try:
                _throttle_before_request()
                resp = _direct_session.post(api_url, headers=headers, json=payload, timeout=_HTTP_TIMEOUT)
            except _RETRYABLE_EXC as e:
                last_exc = e
                if attempt >= _MAX_RETRIES:
                    raise
                backoff = _compute_backoff(attempt, None)
                logger.warning(
                    "LLM call network error (attempt %d/%d): %s, retrying in %.1fs",
                    attempt + 1, _MAX_RETRIES + 1, e, backoff,
                )
                time.sleep(backoff)
                continue
        except _RETRYABLE_EXC as e:
            last_exc = e
            if attempt >= _MAX_RETRIES:
                logger.error("LLM call network error after %d attempts: %s", _MAX_RETRIES + 1, e)
                raise
            backoff = _compute_backoff(attempt, None)
            logger.warning(
                "LLM call network error (attempt %d/%d): %s, retrying in %.1fs",
                attempt + 1, _MAX_RETRIES + 1, e, backoff,
            )
            time.sleep(backoff)
            continue

        # Got a response — check if retryable status
        if resp.status_code in _RETRYABLE_STATUS and attempt < _MAX_RETRIES:
            retry_after = resp.headers.get("retry-after")
            backoff = _compute_backoff(attempt, retry_after)
            logger.warning(
                "LLM call HTTP %d (attempt %d/%d), retrying in %.1fs%s",
                resp.status_code, attempt + 1, _MAX_RETRIES + 1, backoff,
                f" (Retry-After: {retry_after})" if retry_after else "",
            )
            time.sleep(backoff)
            continue

        return resp

    # Should not reach here
    if last_exc:
        raise last_exc
    raise RuntimeError("LLM call retry exhausted with no exception")


def post_once_for_briefing(headers: dict, payload: dict) -> requests.Response:
    """Single LLM POST for low-priority briefing jobs.

    Briefing may fan out over many holdings. Retrying 429 for every card makes
    provider throttling worse, so callers can use this no-retry path and fall
    back to local summaries immediately.
    """
    api_url = _build_api_url()
    _throttle_before_request()
    try:
        return _llm_session.post(api_url, headers=headers, json=payload, timeout=_HTTP_TIMEOUT)
    except requests.exceptions.ProxyError:
        _throttle_before_request()
        return _direct_session.post(api_url, headers=headers, json=payload, timeout=_HTTP_TIMEOUT)


def call_claude_once(
    user_prompt: str,
    system: str | None = None,
    model: str = "claude-sonnet-5",
    max_tokens: int = 2048,
    response_format: str | None = None,
) -> str:
    """Single-attempt variant for batch/briefing jobs; no retry on 429."""
    model = resolve_model(model)
    token, is_oauth = _resolve_auth()
    headers = _build_headers(token, is_oauth)
    system_blocks = _build_system(system, is_oauth)
    if _is_openai_compatible():
        payload = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": _anthropic_messages_to_openai(
                [{"role": "user", "content": user_prompt}], system or ""
            ),
        }
        _apply_openai_extra_body(payload)
        if response_format == "json_object":
            payload["response_format"] = {"type": "json_object"}
    else:
        payload = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": user_prompt}],
            "system": system_blocks,
        }
    resp = post_once_for_briefing(headers, payload)
    resp = _retry_on_oauth_401(resp, token, is_oauth, system, headers, payload)
    if not resp.ok:
        raise RuntimeError(f"LLM API error {resp.status_code}: {_safe_error_body(resp)}")
    data = resp.json()
    if _is_openai_compatible():
        choices = data.get("choices") or []
        msg = (choices[0].get("message") if choices else {}) or {}
        text = _openai_content_to_text(msg.get("content"))
        if not text and isinstance(msg.get("reasoning_content"), str):
            text = msg.get("reasoning_content") or ""
        return text
    parts = data.get("content", [])
    return "".join(p.get("text", "") for p in parts if p.get("type") == "text")


def _safe_error_body(resp) -> str:
    """Return a truncated, key-sanitized version of the response body for error messages.

    Masks common API-key prefixes (sk-, sk-ant-, sk-ds-, ghp_, pplx-, key-, etc.)
    and Bearer tokens. Applied iteratively to catch multiple occurrences.
    """
    text = resp.text[:300] if resp.text else ""
    if not text:
        return ""
    # Match common API-key prefixes followed by >=8 token chars
    key_re = re.compile(r'(sk-(?:ant-|ds-|or-)?[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|pplx-[A-Za-z0-9]{8,}|key-[A-Za-z0-9]{8,}|[A-Za-z0-9_-]{20,})')
    # Also mask Bearer <token>
    bearer_re = re.compile(r'(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}', re.IGNORECASE)
    text = key_re.sub("***MASKED***", text)
    text = bearer_re.sub(r"\1***MASKED***", text)
    return text


# ── 公开 API ───────────────────────────────────────────

def _retry_on_oauth_401(
    resp: requests.Response,
    token: str,
    is_oauth: bool,
    system: str | None,
    headers: dict,
    payload: dict,
) -> requests.Response:
    """If response is 401 and we used OAuth, flush cache and re-resolve once.

    Returns the new response (or the original if no retry was attempted).
    Raises RuntimeError if re-resolution fails.
    """
    global _cached_token

    if resp.status_code != 401 or not is_oauth:
        return resp

    with _config_lock:
        _cached_token = None
    try:
        new_token, new_is_oauth = _resolve_auth()
    except Exception:
        raise RuntimeError(
            "LLM API 401: OAuth token expired and re-resolution failed. "
            "Run `claude setup-token` 或配置 LLM_API_KEY 使用通用 key。"
        )
    if new_token == token:
        return resp  # same token, won't help to retry

    new_headers = _build_headers(new_token, new_is_oauth)
    new_system = _build_system(system, new_is_oauth)
    new_payload = {**payload, "system": new_system}
    return _post_with_retry(new_headers, new_payload)

def call_claude(
    user_prompt: str,
    system: str | None = None,
    model: str = "claude-sonnet-5",
    max_tokens: int = 2048,
    response_format: str | None = None,
) -> str:
    """Call LLM API (Anthropic-协议兼容). Returns text response.

    自动处理:
      - 模型别名映射 (smart/balanced/fast → 实际模型)
      - 鉴权 (通用 key / Anthropic key / OAuth)
      - 代理回退

    On 401 (OAuth expired): flush cache, re-resolve once.
    """
    model = resolve_model(model)
    token, is_oauth = _resolve_auth()
    headers = _build_headers(token, is_oauth)
    system_blocks = _build_system(system, is_oauth)
    if _is_openai_compatible():
        payload = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": _anthropic_messages_to_openai(
                [{"role": "user", "content": user_prompt}], system or ""
            ),
        }
        _apply_openai_extra_body(payload)
        if response_format == "json_object":
            payload["response_format"] = {"type": "json_object"}
    else:
        payload = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": user_prompt}],
            "system": system_blocks,
        }

    resp = _post_with_retry(headers, payload)
    resp = _retry_on_oauth_401(resp, token, is_oauth, system, headers, payload)

    if not resp.ok:
        if resp.status_code == 401:
            raise RuntimeError(
                f"LLM API 401 鉴权失败 ({_base_url})。"
                " 请检查 LLM_API_KEY / api_key_header / api_key_prefix 配置。"
            )
        raise RuntimeError(f"LLM API error {resp.status_code}: {_safe_error_body(resp)}")

    data = resp.json()
    if _is_openai_compatible():
        choices = data.get("choices") or []
        msg = (choices[0].get("message") if choices else {}) or {}
        text = _openai_content_to_text(msg.get("content"))
        if not text and isinstance(msg.get("reasoning_content"), str):
            text = msg.get("reasoning_content") or ""
        if not text:
            finish = choices[0].get("finish_reason") if choices else None
            logger.warning(
                "OpenAI-compatible LLM returned empty content: finish_reason=%r message_keys=%s",
                finish, sorted(msg.keys()) if isinstance(msg, dict) else [],
            )
        return text
    parts = data.get("content", [])
    return "".join(p.get("text", "") for p in parts if p.get("type") == "text")


def call_claude_messages(
    messages: list,
    system: str | None = None,
    model: str = "claude-opus-4-8",
    max_tokens: int = 2048,
    tools: list | None = None,
) -> dict:
    """底层 Messages 调用, 支持完整 messages 历史 + tool-use。

    返回原始响应 dict (调用方自行看 stop_reason / content 里的 tool_use 块)。
    用于 agent loop。出错抛异常 (不走 CLI 兜底——CLI 不支持 tools)。
    """
    model = resolve_model(model)
    token, is_oauth = _resolve_auth()
    headers = _build_headers(token, is_oauth)
    system_blocks = _build_system(system, is_oauth)

    if _is_openai_compatible():
        payload = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": _anthropic_messages_to_openai(messages, system or ""),
        }
        _apply_openai_extra_body(payload)
        ot = _anthropic_tools_to_openai(tools)
        if ot:
            payload["tools"] = ot
    else:
        payload = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": messages,
            "system": system_blocks,
        }
        if tools:
            payload["tools"] = tools

    resp = _post_with_retry(headers, payload)
    resp = _retry_on_oauth_401(resp, token, is_oauth, system, headers, payload)

    if not resp.ok:
        raise RuntimeError(f"LLM API error {resp.status_code}: {_safe_error_body(resp)}")

    data = resp.json()
    if _is_openai_compatible():
        return _openai_response_to_anthropic(data)
    return data


# ── 连接测试 ───────────────────────────────────────────

def test_connection() -> dict:
    """发送一条最小请求测试连接。返回 {ok, latency_ms, model, error}."""
    import time

    model = resolve_model("fast")
    t0 = time.time()
    try:
        # _resolve_auth 在未配置任何凭证时会 raise(无 LLM_API_KEY/ANTHROPIC_API_KEY/OAuth)。
        # 放进 try 里, 让"未配置"返回优雅的 {ok:false, error:...} 而不是抛出 500。
        token, is_oauth = _resolve_auth()
        headers = _build_headers(token, is_oauth)
        system_blocks = _build_system("Reply with just 'ok'.", is_oauth)
        if _is_openai_compatible():
            payload = {
                "model": model,
                "max_tokens": 10,
                "messages": _anthropic_messages_to_openai(
                    [{"role": "user", "content": "Say ok"}], "Reply with just 'ok'."
                ),
            }
            _apply_openai_extra_body(payload)
        else:
            payload = {
                "model": model,
                "max_tokens": 10,
                "messages": [{"role": "user", "content": "Say ok"}],
                "system": system_blocks,
            }
        resp = _post_with_retry(headers, payload)
        elapsed_ms = round((time.time() - t0) * 1000)
        if resp.ok:
            return {"ok": True, "latency_ms": elapsed_ms, "model": model, "provider": _provider, "error": ""}
        else:
            return {"ok": False, "latency_ms": elapsed_ms, "model": model, "provider": _provider, "error": f"{resp.status_code}: {_safe_error_body(resp)}"}
    except Exception as e:
        elapsed_ms = round((time.time() - t0) * 1000)
        return {"ok": False, "latency_ms": elapsed_ms, "model": model, "provider": _provider, "error": str(e)[:200]}


# ── CLI fallback (仅 Anthropic 官方 + OAuth 模式) ──────

def _find_claude_cli() -> tuple[str | None, str | None]:
    """Find claude CLI binary and associated node binary."""
    candidates = []
    home = os.path.expanduser("~")
    nvm_dir = os.path.join(home, ".nvm", "versions", "node")
    if os.path.isdir(nvm_dir):
        for ver in sorted(os.listdir(nvm_dir), reverse=True):
            bin_dir = os.path.join(nvm_dir, ver, "bin")
            node = os.path.join(bin_dir, "node")
            claude = os.path.join(bin_dir, "claude")
            if os.path.isfile(node) and os.path.isfile(claude):
                candidates.append((node, claude))
    system_claude = shutil.which("claude")
    system_node = shutil.which("node")
    if system_claude and system_node:
        candidates.append((system_node, system_claude))
    return candidates[0] if candidates else (None, None)


def _call_via_cli(user_prompt: str, system: str | None, model: str, max_tokens: int) -> str:
    """Fallback: call Claude via the local CLI binary (refreshes OAuth internally)."""
    node_path, claude_path = _find_claude_cli()
    if not node_path or not claude_path:
        raise RuntimeError("Claude CLI binary not found; cannot use CLI fallback.")

    cmd = [node_path, claude_path, "--print", "--model", model]
    if system:
        cmd += ["--append-system-prompt", system]
    cmd.append(user_prompt)

    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=120,
        env={**os.environ, "HOME": os.path.expanduser("~")},
    )
    if result.returncode != 0:
        raise RuntimeError(f"Claude CLI error (rc={result.returncode}): {result.stderr[:300]}")
    return result.stdout.strip()
