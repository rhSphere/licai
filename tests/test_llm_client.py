"""Tests for multi-provider llm_client.

Does NOT make real API calls — tests config, auth, URL building, model mapping.
"""
import os
import pytest
from unittest import mock

import services.llm_client as llm

@pytest.fixture(autouse=True)
def clear_module_state():
    """Reset module globals before each test."""
    saved_min_interval = llm._MIN_INTERVAL_S
    saved_env = {
        "LLM_BASE_URL": os.environ.pop("LLM_BASE_URL", None),
        "LLM_PROVIDER": os.environ.pop("LLM_PROVIDER", None),
        "LLM_API_KEY": os.environ.pop("LLM_API_KEY", None),
        "LLM_API_KEY_HEADER": os.environ.pop("LLM_API_KEY_HEADER", None),
        "LLM_API_KEY_PREFIX": os.environ.pop("LLM_API_KEY_PREFIX", None),
        "LLM_PROXY": os.environ.pop("LLM_PROXY", None),
        "LLM_MODEL_MAP": os.environ.pop("LLM_MODEL_MAP", None),
        "ANTHROPIC_API_KEY": os.environ.pop("ANTHROPIC_API_KEY", None),
    }
    # Reset module state
    llm._base_url = llm._DEFAULT_BASE_URL
    llm._provider = llm._DEFAULT_PROVIDER
    llm._api_key = ""
    llm._api_key_header = llm._DEFAULT_API_KEY_HEADER
    llm._api_key_prefix = ""
    llm._model_map = {}
    llm._proxy_url = ""
    llm._cached_token = None
    llm._MIN_INTERVAL_S = 0
    llm._last_request_at = 0.0
    llm._apply_proxy()
    yield
    llm._MIN_INTERVAL_S = saved_min_interval
    llm._last_request_at = 0.0
    # Restore env
    for k, v in saved_env.items():
        if v is not None:
            os.environ[k] = v
        elif k in os.environ:
            del os.environ[k]


# ── URL building ─────────────────────────────────────────

def test_default_base_url():
    assert llm._base_url == "https://api.anthropic.com"


def test_build_api_url_anthropic():
    llm._base_url = "https://api.anthropic.com"
    url = llm._build_api_url()
    assert url == "https://api.anthropic.com/v1/messages?beta=true"


def test_build_api_url_third_party():
    llm._base_url = "https://api.deepseek.com"
    url = llm._build_api_url()
    assert url == "https://api.deepseek.com/v1/messages"
    assert "?beta=true" not in url


def test_build_api_url_trailing_slash():
    llm._base_url = "https://api.siliconflow.cn/"
    url = llm._build_api_url()
    assert url == "https://api.siliconflow.cn/v1/messages"


def test_build_api_url_kimi_openai_compatible():
    llm._provider = "openai_compatible"
    llm._base_url = "https://api.moonshot.cn/v1"
    assert llm._build_api_url() == "https://api.moonshot.cn/v1/chat/completions"


def test_build_api_url_openai_compatible_without_v1():
    llm._provider = "openai_compatible"
    llm._base_url = "https://api.example.com"
    assert llm._build_api_url() == "https://api.example.com/v1/chat/completions"


def test_is_anthropic_official():
    llm._base_url = "https://api.anthropic.com"
    assert llm._is_anthropic_official() is True
    llm._base_url = "https://api.deepseek.com"
    assert llm._is_anthropic_official() is False


# ── Model mapping ────────────────────────────────────────

def test_resolve_model_no_map():
    llm._model_map = {}
    assert llm.resolve_model("claude-sonnet-4-6-20250514") == "claude-sonnet-4-6-20250514"


def test_resolve_model_with_map():
    llm._model_map = {"smart": "deepseek-chat", "fast": "deepseek-chat"}
    assert llm.resolve_model("smart") == "deepseek-chat"
    assert llm.resolve_model("fast") == "deepseek-chat"
    # Direct model name still passes through
    assert llm.resolve_model("claude-sonnet-4-6") == "claude-sonnet-4-6"


def test_resolve_model_unknown_alias():
    llm._model_map = {"smart": "deepseek-chat"}
    # 用户 map 没配的逻辑别名 → 落到默认别名(真实 Anthropic 模型)
    assert llm.resolve_model("balanced") == llm._DEFAULT_ALIASES["balanced"]
    # 真正未知的名字 → 原样返回
    assert llm.resolve_model("turbo-x") == "turbo-x"


def test_resolve_model_openai_compatible_defaults_to_kimi():
    llm._provider = "openai_compatible"
    llm._model_map = {}
    assert llm.resolve_model("smart") == "kimi-k2.6"
    assert llm.resolve_model("balanced") == "kimi-k2.6"
    assert llm.resolve_model("fast") == "kimi-k2.6"


def test_resolve_model_openai_compatible_maps_legacy_claude_defaults():
    llm._provider = "openai_compatible"
    llm._model_map = {}
    assert llm.resolve_model("claude-opus-4-8") == "kimi-k2.6"
    assert llm.resolve_model("claude-sonnet-4-6") == "kimi-k2.6"


def test_get_model_map_returns_copy():
    llm._model_map = {"smart": "gpt-4"}
    m = llm.get_model_map()
    m["smart"] = "changed"
    assert llm._model_map["smart"] == "gpt-4"


def test_parse_model_map_valid():
    result = llm._parse_model_map('{"smart":"m1","fast":"m2"}')
    assert result == {"smart": "m1", "fast": "m2"}


def test_parse_model_map_empty():
    assert llm._parse_model_map("") == {}
    assert llm._parse_model_map(None) == {}
    assert llm._parse_model_map("  ") == {}


def test_parse_model_map_invalid():
    assert llm._parse_model_map("not json") == {}
    assert llm._parse_model_map('["array"]') == {}
    assert llm._parse_model_map('{"k": 123}') == {}  # values must be strings


# ── Auth header building ─────────────────────────────────

def test_build_headers_api_key_default():
    """Default: x-api-key header."""
    headers = llm._build_headers("sk-test-key-123", is_oauth=False)
    assert headers["x-api-key"] == "sk-test-key-123"
    assert headers["Content-Type"] == "application/json"
    assert "Authorization" not in headers


def test_build_headers_authorization_bearer():
    """Authorization: Bearer mode (e.g. DeepSeek, SiliconFlow)."""
    llm._api_key_header = "Authorization"
    llm._api_key_prefix = "Bearer"
    headers = llm._build_headers("sk-deepseek-key", is_oauth=False)
    assert headers["Authorization"] == "Bearer sk-deepseek-key"
    assert "x-api-key" not in headers


def test_build_headers_custom_header():
    """Custom header name."""
    llm._api_key_header = "X-Custom-Key"
    llm._api_key_prefix = ""
    headers = llm._build_headers("my-key", is_oauth=False)
    assert headers["X-Custom-Key"] == "my-key"


def test_build_headers_oauth_mode():
    """OAuth mode: CLAUDE_CODE_HEADERS + Bearer token."""
    headers = llm._build_headers("oat-token-123", is_oauth=True)
    assert headers["Authorization"] == "Bearer oat-token-123"
    assert "anthropic-beta" in headers
    assert "X-Claude-Code-Session-Id" in headers


# ── System prompt building ───────────────────────────────

def test_build_system_oauth_no_system():
    result = llm._build_system(None, is_oauth=True)
    assert len(result) == 1
    assert result[0]["type"] == "text"
    assert "Claude Code" in result[0]["text"]


def test_build_system_oauth_with_system():
    result = llm._build_system("You are a helpful assistant.", is_oauth=True)
    assert len(result) == 2
    assert result[0]["text"] == llm.CLAUDE_IDENTITY
    assert result[1]["text"] == "You are a helpful assistant."


def test_build_system_non_oauth():
    result = llm._build_system("You are helpful.", is_oauth=False)
    assert result == "You are helpful."


def test_build_system_non_oauth_none():
    result = llm._build_system(None, is_oauth=False)
    assert result is None


# ── configure_llm ────────────────────────────────────────

def test_configure_llm_basic():
    llm.configure_llm(
        provider="openai_compatible",
        base_url="https://api.deepseek.com",
        api_key="sk-ds-123",
        api_key_header="Authorization",
        api_key_prefix="Bearer",
        proxy="http://127.0.0.1:7890",
        model_map={"smart": "deepseek-chat"},
    )
    assert llm._provider == "openai_compatible"
    assert llm._base_url == "https://api.deepseek.com"
    assert llm._api_key == "sk-ds-123"
    assert llm._api_key_header == "Authorization"
    assert llm._api_key_prefix == "Bearer"
    assert llm._proxy_url == "http://127.0.0.1:7890"
    assert llm._model_map == {"smart": "deepseek-chat"}


def test_configure_llm_env_var_wins():
    """When env vars are set, configure_llm does NOT overwrite them with DB values."""
    os.environ["LLM_BASE_URL"] = "https://env.example.com"
    os.environ["LLM_API_KEY"] = "env-key"

    llm.configure_llm(
        base_url="https://db.example.com",
        api_key="db-key",
    )
    # DB values are rejected because env vars are present
    assert llm._api_key == ""  # _api_key not set; env is read at call-time in _resolve_auth
    assert llm._base_url != "https://db.example.com"  # DB value not applied


def test_configure_llm_partial():
    """Only provided fields are updated."""
    original = llm._base_url
    llm.configure_llm(api_key="new-key")
    assert llm._base_url == original  # unchanged
    assert llm._api_key == "new-key"


# ── get_llm_config ───────────────────────────────────────

def test_get_llm_config_defaults():
    config = llm.get_llm_config()
    assert config["provider"] == "anthropic"
    assert config["base_url"] == "https://api.anthropic.com"
    assert config["has_api_key"] is False
    assert config["api_key_header"] == "x-api-key"
    assert config["api_key_prefix"] == ""


def test_get_llm_config_with_key():
    llm._api_key = "sk-1234567890abcdef"
    config = llm.get_llm_config()
    assert config["has_api_key"] is True
    assert config["api_key"] == "sk-1****cdef"  # masked


# ── Key masking ──────────────────────────────────────────

def test_mask_key_short():
    assert llm._mask_key("short") == "****"


def test_mask_key_normal():
    masked = llm._mask_key("sk-1234567890abcdef1234567890abcdef")
    assert masked.startswith("sk-1")
    assert "****" in masked
    # The key is 36 chars: first 4 + **** + last 4 = sk-1****cdef
    assert masked == "sk-1****cdef"


# ── Proxy ────────────────────────────────────────────────

def test_apply_proxy_empty():
    llm._proxy_url = ""
    llm._apply_proxy()
    assert llm._llm_session.proxies == {}


def test_apply_proxy_set():
    llm._proxy_url = "http://127.0.0.1:7890"
    llm._apply_proxy()
    assert llm._llm_session.proxies == {"http": "http://127.0.0.1:7890", "https": "http://127.0.0.1:7890"}
    # cleanup
    llm._proxy_url = ""
    llm._apply_proxy()


# ── test_connection (mocked) ─────────────────────────────

@mock.patch.object(llm._llm_session, "post")
def test_test_connection_ok(mock_post):
    mock_resp = mock.MagicMock()
    mock_resp.ok = True
    mock_resp.json.return_value = {"content": [{"type": "text", "text": "ok"}]}
    mock_post.return_value = mock_resp

    llm._api_key = "sk-test"
    result = llm.test_connection()
    assert result["ok"] is True
    assert result["latency_ms"] >= 0
    assert result["error"] == ""


@mock.patch.object(llm._llm_session, "post")
def test_test_connection_error(mock_post):
    mock_resp = mock.MagicMock()
    mock_resp.ok = False
    mock_resp.status_code = 401
    mock_resp.text = "Unauthorized"
    mock_post.return_value = mock_resp

    llm._api_key = "sk-bad"
    result = llm.test_connection()
    assert result["ok"] is False
    assert "401" in result["error"]


@mock.patch.object(llm._llm_session, "post")
def test_test_connection_exception(mock_post):
    mock_post.side_effect = Exception("Connection refused")

    llm._api_key = "sk-test"
    result = llm.test_connection()
    assert result["ok"] is False
    assert "Connection refused" in result["error"]


# ── _resolve_auth multi-tier fallback ────────────────────

def test_resolve_auth_llm_api_key_priority():
    """LLM_API_KEY takes priority over ANTHROPIC_API_KEY."""
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-old-key"
    llm._api_key = "sk-new-key"
    token, is_oauth = llm._resolve_auth()
    assert token == "sk-new-key"
    assert is_oauth is False


def test_resolve_auth_falls_back_to_env():
    """When _api_key is empty, fall back to ANTHROPIC_API_KEY."""
    llm._api_key = ""
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-oat-env-key"
    token, is_oauth = llm._resolve_auth()
    assert token == "sk-ant-oat-env-key"
    assert is_oauth is True  # sk-ant-oat pattern matches


def test_resolve_auth_uses_cached_oauth_token():
    """Cached OAuth token is reused without re-reading keychain."""
    llm._api_key = ""
    # Remove ANTHROPIC_API_KEY so it would need keychain
    os.environ.pop("ANTHROPIC_API_KEY", None)
    llm._cached_token = "cached-oat-token"
    token, is_oauth = llm._resolve_auth()
    assert token == "cached-oat-token"
    assert is_oauth is True


def test_resolve_auth_no_credentials_raises():
    """When all auth sources are empty, RuntimeError is raised."""
    llm._api_key = ""
    llm._cached_token = None
    os.environ.pop("ANTHROPIC_API_KEY", None)
    with pytest.raises(RuntimeError, match="无法获取 LLM API 凭证"):
        # Mock subprocess to avoid real keychain call
        with mock.patch("subprocess.run") as mock_run:
            mock_run.return_value.returncode = 1  # keychain not found
            llm._resolve_auth()


def test_resolve_auth_openai_compatible_requires_llm_key():
    llm._provider = "openai_compatible"
    llm._api_key = ""
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-should-not-be-used"
    with pytest.raises(RuntimeError, match="OpenAI-compatible/Kimi"):
        llm._resolve_auth()


def test_openai_message_conversion_tool_roundtrip():
    messages = [
        {"role": "user", "content": "查一下贵州茅台"},
        {"role": "assistant", "content": [
            {"type": "text", "text": "我先查行情"},
            {"type": "tool_use", "id": "toolu_1", "name": "get_quote", "input": {"code": "600519"}},
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": '{"price": 1500}'},
        ]},
    ]
    out = llm._anthropic_messages_to_openai(messages, "system prompt")
    assert out[0] == {"role": "system", "content": "system prompt"}
    assert out[2]["tool_calls"][0]["function"]["name"] == "get_quote"
    assert out[3]["role"] == "tool"
    assert out[3]["tool_call_id"] == "toolu_1"


def test_openai_response_to_anthropic_tool_calls():
    data = {"id": "x", "model": "kimi-k2.6", "choices": [{"message": {
        "content": "",
        "tool_calls": [{"id": "call_1", "type": "function", "function": {
            "name": "get_quote", "arguments": '{"code":"600519"}'
        }}]
    }, "finish_reason": "tool_calls"}]}
    out = llm._openai_response_to_anthropic(data)
    assert out["_provider"] == "openai_compatible"
    assert out["content"][0]["type"] == "tool_use"
    assert out["content"][0]["input"] == {"code": "600519"}


def test_openai_content_to_text_blocks():
    content = [{"type": "text", "text": "hello"}, {"type": "output_text", "text": " world"}]
    assert llm._openai_content_to_text(content) == "hello world"


def test_openai_response_uses_reasoning_content_when_content_empty():
    data = {"choices": [{"message": {"content": "", "reasoning_content": "reason text"}}]}
    out = llm._openai_response_to_anthropic(data)
    assert out["content"] == [{"type": "text", "text": "reason text"}]


@mock.patch.object(llm._llm_session, "post")
def test_call_claude_openai_compatible(mock_post):
    mock_resp = mock.MagicMock()
    mock_resp.ok = True
    mock_resp.json.return_value = {"choices": [{"message": {"content": "ok"}}]}
    mock_post.return_value = mock_resp
    llm._provider = "openai_compatible"
    llm._base_url = "https://api.moonshot.cn/v1"
    llm._api_key = "sk-kimi"
    llm._api_key_header = "Authorization"
    llm._api_key_prefix = "Bearer"

    assert llm.call_claude("hello", system="sys", model="kimi-k2.6") == "ok"
    url = mock_post.call_args[0][0]
    headers = mock_post.call_args.kwargs["headers"]
    payload = mock_post.call_args.kwargs["json"]
    assert url == "https://api.moonshot.cn/v1/chat/completions"
    assert headers["Authorization"] == "Bearer sk-kimi"
    assert payload["messages"][0] == {"role": "system", "content": "sys"}


@mock.patch.object(llm._llm_session, "post")
def test_call_claude_openai_compatible_json_response_format(mock_post):
    mock_resp = mock.MagicMock()
    mock_resp.ok = True
    mock_resp.json.return_value = {"choices": [{"message": {"content": '{"ok":true}'}}]}
    mock_post.return_value = mock_resp
    llm._provider = "openai_compatible"
    llm._base_url = "https://api.moonshot.cn/v1"
    llm._api_key = "sk-kimi"
    llm._api_key_header = "Authorization"
    llm._api_key_prefix = "Bearer"

    assert llm.call_claude("json", model="fast", response_format="json_object") == '{"ok":true}'
    payload = mock_post.call_args.kwargs["json"]
    assert payload["model"] == "kimi-k2.6"
    assert payload["response_format"] == {"type": "json_object"}


@mock.patch("subprocess.run")
def test_resolve_auth_keychain_success(mock_run):
    """macOS Keychain returns a valid OAuth token."""
    llm._api_key = ""
    llm._cached_token = None
    os.environ.pop("ANTHROPIC_API_KEY", None)

    mock_run.return_value.returncode = 0
    mock_run.return_value.stdout = '{"claudeAiOauth":{"accessToken":"keychain-token-123"}}'

    # Only test on Darwin or mock os.uname
    with mock.patch("os.uname") as mock_uname:
        mock_uname.return_value.sysname = "Darwin"
        token, is_oauth = llm._resolve_auth()
        assert token == "keychain-token-123"
        assert is_oauth is True
        assert llm._cached_token == "keychain-token-123"


# ── _safe_error_body ─────────────────────────────────────

def test_safe_error_body_masks_sk_ant_key():
    resp = mock.MagicMock()
    resp.text = '{"error":"invalid key sk-ant-abc123def456ghi789 for endpoint"}'
    result = llm._safe_error_body(resp)
    assert "sk-ant-abc123def456ghi789" not in result
    assert "***MASKED***" in result


def test_safe_error_body_masks_bearer_token():
    resp = mock.MagicMock()
    resp.text = 'auth failed: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def was rejected'
    result = llm._safe_error_body(resp)
    assert "eyJhbGciOiJIUzI1NiJ9" not in result
    assert "***MASKED***" in result


def test_safe_error_body_clean_text_passes_through():
    resp = mock.MagicMock()
    resp.text = '{"error":"model not found"}'
    result = llm._safe_error_body(resp)
    assert result == '{"error":"model not found"}'


def test_safe_error_body_empty():
    resp = mock.MagicMock()
    resp.text = ""
    result = llm._safe_error_body(resp)
    assert result == ""


def test_safe_error_body_masks_deepseek_key():
    """DeepSeek-style keys (sk- + long token) are masked."""
    resp = mock.MagicMock()
    resp.text = '{"error":"invalid key sk-ds-abc123def456ghi789jkl012mno345pqr678"}'
    result = llm._safe_error_body(resp)
    assert "sk-ds-abc123def456ghi789" not in result
    assert "***MASKED***" in result


def test_safe_error_body_masks_multiple_occurrences():
    """Multiple API keys in same body are all masked."""
    resp = mock.MagicMock()
    resp.text = 'first=sk-ant-abc123def456ghi789 second=sk-ant-xyz987wvu654tsr321'
    result = llm._safe_error_body(resp)
    assert "abc123def456ghi789" not in result
    assert "xyz987wvu654tsr321" not in result
    # Both should be masked
    assert result.count("***MASKED***") >= 2


def test_safe_error_body_masks_bearer_with_prefix_preserved():
    """Bearer prefix is preserved, only the token value is masked."""
    resp = mock.MagicMock()
    resp.text = 'failed auth: Bearer abcdefghijklmnopqrstuvwxyz123456 was rejected'
    result = llm._safe_error_body(resp)
    assert "Bearer" in result
    assert "abcdefghijklmnopqrstuvwxyz" not in result
    assert "***MASKED***" in result


def test_safe_error_body_no_false_positive_short_strings():
    """Short words that happen to start with sk- are not masked."""
    resp = mock.MagicMock()
    resp.text = '{"error":"model not found: skip-3"}'
    result = llm._safe_error_body(resp)
    # "skip-3" should NOT be masked (key needs >=8 chars after prefix)
    assert "skip-3" in result or "***MASKED***" not in result


# ── Retry logic ──────────────────────────────────────────

def test_compute_backoff_exponential():
    """Backoff doubles on each attempt, capped at max."""
    saved_max = llm._RETRY_MAX_BACKOFF_S
    saved_init = llm._RETRY_INITIAL_BACKOFF_S
    llm._RETRY_INITIAL_BACKOFF_S = 1.0
    llm._RETRY_MAX_BACKOFF_S = 8.0
    try:
        assert llm._compute_backoff(0, None) == 1.0
        assert llm._compute_backoff(1, None) == 2.0
        assert llm._compute_backoff(2, None) == 4.0
        assert llm._compute_backoff(3, None) == 8.0  # capped
        assert llm._compute_backoff(10, None) == 8.0  # still capped
    finally:
        llm._RETRY_INITIAL_BACKOFF_S = saved_init
        llm._RETRY_MAX_BACKOFF_S = saved_max


def test_compute_backoff_respects_retry_after():
    """Retry-After header takes precedence over exponential backoff."""
    saved_max = llm._RETRY_MAX_BACKOFF_S
    llm._RETRY_MAX_BACKOFF_S = 8.0
    try:
        # Numeric Retry-After in seconds
        assert llm._compute_backoff(0, "3") == 3.0
        # Even if exponential would be smaller
        assert llm._compute_backoff(0, "10") == 10.0
        # Invalid format falls back to exponential
        assert llm._compute_backoff(0, "invalid") == 1.0
    finally:
        llm._RETRY_MAX_BACKOFF_S = saved_max


@mock.patch("time.sleep")
def test_throttle_before_request_waits_when_enabled(mock_sleep):
    llm._MIN_INTERVAL_S = 1.2
    llm._last_request_at = 100.0
    try:
        with mock.patch("time.time", side_effect=[100.5, 101.7]):
            llm._throttle_before_request()
        assert mock_sleep.called
        assert round(mock_sleep.call_args[0][0], 1) == 0.7
    finally:
        llm._MIN_INTERVAL_S = 0
        llm._last_request_at = 0.0


@mock.patch("time.sleep")  # don't actually sleep
@mock.patch.object(llm._llm_session, "post")
def test_post_with_retry_429_then_success(mock_post, mock_sleep):
    """429 → retry → success on second attempt."""
    err_resp = mock.MagicMock()
    err_resp.status_code = 429
    err_resp.headers = {}

    ok_resp = mock.MagicMock()
    ok_resp.status_code = 200
    ok_resp.ok = True

    mock_post.side_effect = [err_resp, ok_resp]

    resp = llm._post_with_retry({"k": "v"}, {"m": "x"})
    assert resp is ok_resp
    assert mock_post.call_count == 2
    assert mock_sleep.called


@mock.patch("time.sleep")
@mock.patch.object(llm._llm_session, "post")
def test_post_with_retry_500_then_success(mock_post, mock_sleep):
    """500 → retry → success."""
    err = mock.MagicMock()
    err.status_code = 500
    err.headers = {}

    ok = mock.MagicMock()
    ok.status_code = 200

    mock_post.side_effect = [err, ok]
    resp = llm._post_with_retry({"k": "v"}, {"m": "x"})
    assert resp is ok
    assert mock_post.call_count == 2


@mock.patch("time.sleep")
@mock.patch.object(llm._llm_session, "post")
def test_post_with_retry_502_503_504_all_retried(mock_post, mock_sleep):
    """All retryable server errors get retried."""
    for code in (502, 503, 504):
        mock_post.reset_mock()
        mock_sleep.reset_mock()
        err = mock.MagicMock()
        err.status_code = code
        err.headers = {}
        ok = mock.MagicMock()
        ok.status_code = 200
        mock_post.side_effect = [err, ok]
        resp = llm._post_with_retry({}, {})
        assert resp is ok
        assert mock_post.call_count == 2


@mock.patch("time.sleep")
@mock.patch.object(llm._llm_session, "post")
def test_post_with_retry_401_not_retried(mock_post, mock_sleep):
    """401 is NOT retried by _post_with_retry (handled separately by OAuth flow)."""
    err = mock.MagicMock()
    err.status_code = 401
    err.headers = {}
    mock_post.return_value = err

    resp = llm._post_with_retry({}, {})
    assert resp.status_code == 401
    assert mock_post.call_count == 1  # no retry
    assert not mock_sleep.called


@mock.patch("time.sleep")
@mock.patch.object(llm._llm_session, "post")
def test_post_with_retry_400_not_retried(mock_post, mock_sleep):
    """400 (bad request) is NOT retried."""
    err = mock.MagicMock()
    err.status_code = 400
    err.headers = {}
    mock_post.return_value = err

    resp = llm._post_with_retry({}, {})
    assert resp.status_code == 400
    assert mock_post.call_count == 1


@mock.patch("time.sleep")
@mock.patch.object(llm._llm_session, "post")
def test_post_with_retry_403_not_retried(mock_post, mock_sleep):
    """403 (permission) is NOT retried."""
    err = mock.MagicMock()
    err.status_code = 403
    err.headers = {}
    mock_post.return_value = err

    resp = llm._post_with_retry({}, {})
    assert resp.status_code == 403
    assert mock_post.call_count == 1


@mock.patch("time.sleep")
@mock.patch.object(llm._llm_session, "post")
def test_post_with_retry_exhausts_then_returns_last(mock_post, mock_sleep):
    """After max retries exhausted, return the last retryable response."""
    saved_retries = llm._MAX_RETRIES
    llm._MAX_RETRIES = 2
    try:
        err = mock.MagicMock()
        err.status_code = 503
        err.headers = {}
        mock_post.return_value = err

        resp = llm._post_with_retry({}, {})
        assert resp.status_code == 503
        # 1 initial + 2 retries = 3 calls
        assert mock_post.call_count == 3
    finally:
        llm._MAX_RETRIES = saved_retries


@mock.patch("time.sleep")
@mock.patch.object(llm._llm_session, "post")
def test_post_with_retry_network_error_then_success(mock_post, mock_sleep):
    """ConnectionError → retry → success."""
    import requests as req
    ok = mock.MagicMock()
    ok.status_code = 200
    mock_post.side_effect = [
        req.exceptions.ConnectionError("network down"),
        ok,
    ]
    resp = llm._post_with_retry({}, {})
    assert resp is ok
    assert mock_post.call_count == 2


@mock.patch("time.sleep")
@mock.patch.object(llm._llm_session, "post")
def test_post_with_retry_timeout_exhausted(mock_post, mock_sleep):
    """Timeout exceptions exhaust retries and re-raise."""
    import requests as req
    saved_retries = llm._MAX_RETRIES
    llm._MAX_RETRIES = 2
    try:
        mock_post.side_effect = req.exceptions.Timeout("timed out")
        with pytest.raises(req.exceptions.Timeout):
            llm._post_with_retry({}, {})
        # 1 initial + 2 retries = 3 attempts
        assert mock_post.call_count == 3
    finally:
        llm._MAX_RETRIES = saved_retries


@mock.patch("time.sleep")
@mock.patch.object(llm._llm_session, "post")
def test_post_with_retry_retry_after_header(mock_post, mock_sleep):
    """Retry-After header in response is used for backoff."""
    err = mock.MagicMock()
    err.status_code = 429
    err.headers = {"retry-after": "5"}
    ok = mock.MagicMock()
    ok.status_code = 200

    mock_post.side_effect = [err, ok]
    llm._post_with_retry({}, {})
    # Check that time.sleep was called with 5 (from Retry-After)
    assert mock_sleep.called
    assert mock_sleep.call_args[0][0] == 5.0


@mock.patch("time.sleep")
@mock.patch.object(llm._llm_session, "post")
def test_call_claude_retries_on_503(mock_post, mock_sleep):
    """End-to-end: call_claude retries on 503."""
    saved_retries = llm._MAX_RETRIES
    llm._MAX_RETRIES = 2
    try:
        err = mock.MagicMock()
        err.status_code = 503
        err.headers = {}
        err.text = "service unavailable"

        ok = mock.MagicMock()
        ok.status_code = 200
        ok.ok = True
        ok.json.return_value = {"content": [{"type": "text", "text": "success"}]}

        mock_post.side_effect = [err, ok]
        llm._api_key = "sk-test"

        result = llm.call_claude("hello")
        assert result == "success"
        assert mock_post.call_count == 2
    finally:
        llm._MAX_RETRIES = saved_retries
