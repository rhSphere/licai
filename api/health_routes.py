"""System health/status endpoints."""
from __future__ import annotations
import os
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter

from config import config
from database import get_db, get_config, get_all_holdings, list_external_assets, list_dca_schedules
from services import llm_client, feishu_notify, proxy_config, tdx_client, okx_client

router = APIRouter(prefix="/api/health", tags=["health"])


def _status(ok: bool, label: str, detail: str = "") -> dict:
    return {"ok": bool(ok), "label": label, "detail": detail}


@router.get("")
async def health():
    """Return local app health without making slow external calls."""
    checks: dict[str, dict] = {}

    # SQLite
    try:
        db = await get_db()
        try:
            cur = await db.execute("SELECT 1")
            await cur.fetchone()
        finally:
            await db.close()
        checks["db"] = _status(True, "SQLite 正常", config.db_path)
    except Exception as e:
        checks["db"] = _status(False, "SQLite 异常", str(e)[:160])

    # Frontend static build
    static_index = Path("static/index.html")
    checks["frontend"] = _status(
        static_index.exists(),
        "前端已构建" if static_index.exists() else "前端未构建",
        "static/index.html" if static_index.exists() else "运行 make build 或使用 make dev-frontend",
    )

    # LLM config state (no live request here; use Settings test button for live probe)
    llm = llm_client.get_llm_config()
    has_key = bool(llm.get("has_api_key")) or bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())
    checks["llm"] = _status(
        has_key or bool(llm.get("using_oauth_fallback")),
        f"LLM: {llm.get('provider') or 'anthropic'}",
        f"{llm.get('base_url') or ''} · {'已配置 key/OAuth' if has_key or llm.get('using_oauth_fallback') else '未配置 key'}",
    )

    # Proxy / TDX / Feishu / OKX config status
    px = proxy_config.get_proxy()
    checks["proxy"] = _status(bool(px), "代理已配置" if px else "代理未配置", px or "直连")
    checks["tdx"] = _status(tdx_client.is_enabled(), "TDX 已启用" if tdx_client.is_enabled() else "TDX 未启用", await get_config("tdx_base_url") or "")
    checks["feishu"] = _status(feishu_notify.is_enabled(), "飞书已启用" if feishu_notify.is_enabled() else "飞书未启用", "静音中" if feishu_notify.is_muted() else "")
    checks["okx"] = _status(okx_client.has_credentials(), "OKX 已配置" if okx_client.has_credentials() else "OKX 未配置", "")

    # Counts / recent config state
    try:
        holdings = await get_all_holdings()
        assets = await list_external_assets()
        dcas = await list_dca_schedules()
        counts = {
            "holdings": len(holdings),
            "external_assets": len(assets),
            "dca_schedules": len(dcas),
        }
    except Exception:
        counts = {"holdings": 0, "external_assets": 0, "dca_schedules": 0}

    overall_ok = checks.get("db", {}).get("ok", False)
    return {
        "ok": overall_ok,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "port": config.port,
        "checks": checks,
        "counts": counts,
    }
