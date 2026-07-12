"""Morning briefing — once-a-day LLM-driven evaluation of each holding.

Pulls news + recent kline + current tranches + cost/price, asks Claude haiku to:
  1. Read the news for sentiment signals (gap risk, sector regime change)
  2. Decide a verdict per stock: lock/hold/raise/lower/add_now
  3. Call out the 1-2 key headlines that drove the verdict

The briefing is meant to run ~9:00 CST before market open and persist the result
for the rest of the day. User reads it once, no real-time noise.
"""
from __future__ import annotations
import asyncio
import json
import os
import re
from datetime import datetime, timezone, timedelta
from typing import Any


SYSTEM_PROMPT = """你是 A 股持仓盘前信息助手。每天开盘前，基于某只持仓近期的新闻 / 公告 / K 线 / 基本面健康度，做一份**客观信息摘要 + 风险提示**。
标的可能是个股，也可能是行业/主题 ETF——ETF 的要点侧重其跟踪主题的板块消息、资金动向与指数位置，基本面/公告缺失属正常。

**最重要的规则：只做信息汇总和风险提示，绝不给出买入 / 卖出 / 加仓 / 减仓 / 调档位 / 抄底 / 止盈止损等任何操作建议或价位指令。** 用户自己做决策，你只负责把今天该知道的事讲清楚。

输出**严格 JSON**（无多余文本，不要 markdown 包裹）：
{
  "signal": "偏暖 | 中性 | 偏冷 | 警惕",
  "summary": "一句话点出今天这只票最该知道的事，≤40 字，客观陈述不要套话",
  "points": ["2-4 条客观要点，每条 ≤30 字。来自新闻/公告/基本面/技术位，是事实不是建议"],
  "risk": "若有明确风险（业绩雷/监管处罚/板块利空/重要股东减持/技术明显破位）用一句话点出，否则空串",
  "confidence": "high | med | low"
}

signal 仅描述消息面/基本面**倾向**（不是操作指令）:
- 偏暖: 近期消息面/基本面偏正面
- 中性: 无明显信号，平稳
- 偏冷: 偏负面但未到风险级别
- 警惕: 有明确利空或风险需要注意

要点写法: 具体、可核对。好例:"Q3 净利同比 -38%，低于预期"、"控股股东拟减持不超 2%"、"现价已跌破 20 日线"。
避免:"建议观望""可逢低布局""注意控制仓位"这类空话和操作暗示。"""


def _kline_summary(df) -> dict:
    """Compress historical kline to a few stats the LLM can chew on."""
    if df is None or df.empty:
        return {}
    # akshare returns Chinese column names; tolerate either
    col = lambda zh, en: df[zh] if zh in df.columns else (df[en] if en in df.columns else None)
    close_s = col("收盘", "close")
    high_s = col("最高", "high")
    low_s = col("最低", "low")
    if close_s is None:
        return {}
    closes = close_s.astype(float)
    highs = high_s.astype(float) if high_s is not None else closes
    lows = low_s.astype(float) if low_s is not None else closes
    last = float(closes.iloc[-1])
    ma5 = float(closes.tail(5).mean()) if len(closes) >= 5 else None
    ma20 = float(closes.tail(20).mean()) if len(closes) >= 20 else None
    return {
        "近20日最高": round(float(highs.tail(20).max()), 2) if len(highs) else None,
        "近20日最低": round(float(lows.tail(20).min()), 2) if len(lows) else None,
        "近5日均价": round(ma5, 2) if ma5 else None,
        "近20日均价": round(ma20, 2) if ma20 else None,
        "趋势": ("下行" if ma5 and ma20 and ma5 < ma20 * 0.98
                else "上行" if ma5 and ma20 and ma5 > ma20 * 1.02
                else "震荡"),
        "最新收盘": round(last, 2),
    }


def _build_user_prompt(*, stock_code: str, stock_name: str, current_price: float,
                       cost_price: float, shares: int, pnl_pct: float, sector: str,
                       kline_stats: dict, news: list[dict], sector_news: list[dict],
                       announcements: list[dict], health: dict | None) -> str:
    parts = [
        f"## 标的\n{stock_name}({stock_code}) · 行业: {sector or '未知'}",
        f"\n## 当前持仓\n成本 ¥{cost_price:.2f} × {shares} 股 = ¥{cost_price*shares:,.0f}\n"
        f"现价 ¥{current_price:.2f} | 浮动盈亏 {pnl_pct:+.2f}%",
    ]
    if kline_stats:
        parts.append(f"\n## K线摘要\n" + "\n".join(f"- {k}: {v}" for k, v in kline_stats.items()))
    if health:
        parts.append(
            f"\n## 基本面健康度\n等级: {health.get('level')} | 评分: {health.get('score', 0):+.2f}"
        )
    if announcements:
        parts.append(
            f"\n## 近期公告 (最权威, 优先看)\n"
            + "\n".join(
                f"- [{(a.get('date') or a.get('time') or '')[:10]}] {a.get('title', '')}"
                for a in announcements[:8]
            )
        )
    if news:
        parts.append(
            f"\n## 个股新闻 (最近 7 天)\n"
            + "\n".join(
                f"- [{(n.get('time') or '')[:10]}] {n.get('title', '')}"
                for n in news[:8]
            )
        )
    if sector_news:
        parts.append(
            f"\n## {sector or '板块'}行业新闻 (最近 7 天)\n"
            + "\n".join(f"- {n.get('title', '')}" for n in sector_news[:5])
        )
    parts.append(
        "\n## 任务\n基于以上，输出今日 signal + summary + points + risk。"
        "只汇总客观信息和风险，不给任何操作建议。严格 JSON。"
    )
    return "\n".join(parts)


def _strip_to_json(text: str) -> str:
    """Best-effort: pull the first {...} block out of an LLM response."""
    text = (text or "").strip()
    # tolerate ```json ... ``` wrappers
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE).strip()
    text = re.sub(r"\s*```$", "", text).strip()
    m = re.search(r"\{.*\}", text, re.DOTALL)
    return m.group(0) if m else text


def _repair_jsonish(text: str) -> str:
    """Best-effort repair for common OpenAI-compatible/Kimi JSON drift."""
    body = _strip_to_json(text)
    # Strip trailing commas before } or ]
    body = re.sub(r",\s*([}\]])", r"\1", body)
    # Normalize Chinese quotes occasionally emitted around keys/strings.
    body = body.replace("“", '"').replace("”", '"')
    return body


def _coerce_points(v) -> list[str]:
    if isinstance(v, list):
        return [str(x).strip()[:80] for x in v if str(x).strip()][:4]
    if isinstance(v, str) and v.strip():
        return [v.strip()[:80]]
    return []


def _extract_briefing_from_text(raw: str) -> dict | None:
    """Extract a usable briefing from non-JSON prose as a last parser step."""
    text = (raw or "").strip()
    if not text:
        return None
    signal = "中性"
    for s in ("偏暖", "偏冷", "警惕", "中性"):
        if s in text:
            signal = s
            break
    lines = []
    for line in text.splitlines():
        line = re.sub(r"^[#>*\-\d.、\s]+", "", line).strip()
        if line and not line.startswith("```"):
            lines.append(line)
    if not lines:
        return None
    risk = ""
    for line in lines:
        if any(k in line for k in ("风险", "警惕", "减持", "处罚", "下滑", "亏损", "破位", "利空")):
            risk = line[:120]
            break
    points = [x[:80] for x in lines[1:5] if x != risk]
    return {
        "signal": signal,
        "summary": lines[0][:80],
        "points": points[:4],
        "risk": risk,
        "confidence": "low",
    }


def _parse_llm_briefing(raw: str) -> dict:
    """Parse a strict briefing JSON response from LLM.

    Kimi/OpenAI-compatible models sometimes wrap JSON in markdown fences. This
    parser accepts fenced JSON but still raises for empty/non-JSON responses so
    callers can fall back to a useful local summary instead of showing a broken
    card.
    """
    body = _repair_jsonish(raw)
    if not body:
        raise ValueError("empty LLM response")
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        extracted = _extract_briefing_from_text(raw)
        if extracted:
            return extracted
        raise
    if not isinstance(parsed, dict):
        raise ValueError("LLM response is not a JSON object")
    signal = parsed.get("signal") or "中性"
    if signal not in {"偏暖", "中性", "偏冷", "警惕"}:
        signal = "中性"
    conf = parsed.get("confidence") or "med"
    if conf not in {"high", "med", "low"}:
        conf = "med"
    return {
        "signal": signal,
        "summary": str(parsed.get("summary") or "").strip()[:80],
        "points": _coerce_points(parsed.get("points")),
        "risk": str(parsed.get("risk") or "").strip()[:120],
        "confidence": conf,
    }


def _fallback_briefing_from_inputs(*, raw: str, kline_stats: dict, news: list[dict],
                                   announcements: list[dict], health: dict | None) -> dict:
    """Build a usable low-confidence card when LLM output is not valid JSON."""
    points: list[str] = []
    if announcements:
        title = (announcements[0].get("title") or "").strip()
        if title:
            points.append(f"近期公告: {title[:50]}")
    if news and len(points) < 4:
        title = (news[0].get("title") or "").strip()
        if title:
            points.append(f"近期新闻: {title[:50]}")
    if kline_stats and len(points) < 4:
        trend = kline_stats.get("趋势")
        close = kline_stats.get("最新收盘")
        if trend or close:
            points.append(f"K线摘要: 最新收盘 {close or '--'}, 趋势 {trend or '未知'}")
    if health and len(points) < 4:
        points.append(f"基本面健康度: {health.get('level') or '未知'}, 评分 {health.get('score', 0):+.2f}")

    raw_text = (raw or "").strip()
    if raw_text:
        # Use the first meaningful non-markdown line as a fallback summary.
        for line in raw_text.splitlines():
            line = re.sub(r"^[#>*\-\s]+", "", line).strip()
            if line and not line.startswith("```"):
                return {
                    "signal": "中性",
                    "summary": line[:60],
                    "points": points,
                    "risk": "",
                    "confidence": "low",
                }

    return {
        "signal": "中性",
        "summary": "已展示本地摘要",
        "points": points,
        "risk": "",
        "confidence": "low",
    }


def _is_llm_rate_limited(exc: Exception) -> bool:
    s = str(exc).lower()
    return "429" in s or "rate limit" in s or "rate_limit" in s or "too many" in s


async def _briefing_inputs(*, stock_code: str, stock_name: str, current_price: float,
                           cost_price: float, shares: int, sector_hint: str = "") -> dict:
    """Collect local inputs and construct prompt data. Never calls the LLM."""
    from services.market_data import get_historical_data, get_stock_sector
    from services.news import get_stock_news, get_sector_news, get_stock_announcements
    from services.fundamental_score import fetch_health_snapshot

    sector = sector_hint
    if not sector:
        try:
            sector = await get_stock_sector(stock_code)
        except Exception:
            sector = ""

    hist_task = get_historical_data(stock_code)
    news_task = get_stock_news(stock_code, limit=10)
    sector_task = get_sector_news(sector or "大盘", limit=5)
    health_task = fetch_health_snapshot(stock_code, stock_name)
    ann_task = get_stock_announcements(stock_code, limit=10)
    hist_df, news, sector_news, health, announcements = await asyncio.gather(
        hist_task, news_task, sector_task, health_task, ann_task,
        return_exceptions=True,
    )
    if isinstance(hist_df, Exception): hist_df = None
    if isinstance(announcements, Exception): announcements = []
    if isinstance(news, Exception): news = []
    if isinstance(sector_news, Exception): sector_news = []
    if isinstance(health, Exception): health = None

    pnl_pct = (current_price - cost_price) / cost_price * 100 if cost_price > 0 else 0
    kline_stats = _kline_summary(hist_df)
    user_prompt = _build_user_prompt(
        stock_code=stock_code, stock_name=stock_name, sector=sector,
        current_price=current_price, cost_price=cost_price, shares=shares,
        pnl_pct=pnl_pct, kline_stats=kline_stats,
        news=news or [], sector_news=sector_news or [],
        announcements=announcements or [], health=health,
    )
    return {
        "sector": sector,
        "pnl_pct": pnl_pct,
        "kline_stats": kline_stats,
        "news": news or [],
        "sector_news": sector_news or [],
        "announcements": announcements or [],
        "health": health,
        "user_prompt": user_prompt,
    }


def _briefing_payload_from_fallback(*, stock_code: str, stock_name: str,
                                    current_price: float, cost_price: float,
                                    shares: int, inputs: dict,
                                    reason: str = "LLM 不可用, 已用本地摘要") -> dict:
    fallback = _fallback_briefing_from_inputs(
        raw="",
        kline_stats=inputs.get("kline_stats") or {},
        news=inputs.get("news") or [],
        announcements=inputs.get("announcements") or [],
        health=inputs.get("health"),
    )
    return {
        "stock_code": stock_code,
        "stock_name": stock_name,
        "current_price": current_price,
        "cost_price": cost_price,
        "pnl_pct": round(float(inputs.get("pnl_pct") or 0), 2),
        "sector": inputs.get("sector") or "",
        "error": reason,
        "signal": fallback["signal"],
        "summary": fallback["summary"],
        "points": fallback["points"],
        "risk": fallback["risk"],
        "confidence": fallback["confidence"],
        "kline_stats": inputs.get("kline_stats") or {},
        "health_level": (inputs.get("health") or {}).get("level"),
        "llm_skipped": True,
    }


def _json_repair_prompt(raw: str) -> str:
    return (
        "把下面内容改写为严格 JSON 对象, 不要 markdown, 不要解释。"
        "字段固定为 signal, summary, points, risk, confidence。"
        "signal 只能是 偏暖/中性/偏冷/警惕; confidence 只能是 high/med/low; points 是字符串数组。\n\n"
        f"原始内容:\n{(raw or '')[:3000]}"
    )


async def _call_llm_briefing(call_claude, user_prompt: str) -> dict:
    """Call LLM and robustly coerce output into briefing dict."""
    raw = await asyncio.to_thread(
        call_claude, user_prompt, SYSTEM_PROMPT,
        "fast", 1200, "json_object",
    )
    try:
        return _parse_llm_briefing(raw)
    except Exception as first_err:
        # Some OpenAI-compatible providers ignore/relax response_format. Ask the
        # model to transform its own text into strict JSON once before fallback.
        if _is_llm_rate_limited(first_err):
            raise
        repaired_raw = await asyncio.to_thread(
            call_claude, _json_repair_prompt(raw),
            "你是 JSON 修复器, 只输出严格 JSON。", "fast", 700, "json_object",
        )
        try:
            return _parse_llm_briefing(repaired_raw)
        except Exception:
            extracted = _extract_briefing_from_text(raw)
            if extracted:
                return extracted
            raise first_err


async def generate_briefing_for_stock(stock_code: str, stock_name: str,
                                      cost_price: float, shares: int,
                                      current_price: float,
                                      sector_hint: str = "",
                                      skip_llm: bool = False) -> dict:
    """Build briefing for one stock/场内ETF. sector_hint: ETF 传主题词(半导体设备/通信…)当行业。"""
    from services.llm_client import call_claude_once
    inputs = await _briefing_inputs(
        stock_code=stock_code, stock_name=stock_name, current_price=current_price,
        cost_price=cost_price, shares=shares, sector_hint=sector_hint,
    )
    if skip_llm:
        return _briefing_payload_from_fallback(
            stock_code=stock_code, stock_name=stock_name, current_price=current_price,
            cost_price=cost_price, shares=shares, inputs=inputs,
            reason="LLM 已跳过, 使用本地摘要",
        )

    try:
        parsed = await _call_llm_briefing(call_claude_once, inputs["user_prompt"])
    except Exception as e:
        reason = "LLM 限流/额度不足, 已用本地摘要" if _is_llm_rate_limited(e) else "AI 摘要暂不可用, 已用本地摘要"
        payload = _briefing_payload_from_fallback(
            stock_code=stock_code, stock_name=stock_name, current_price=current_price,
            cost_price=cost_price, shares=shares, inputs=inputs, reason=reason,
        )
        if _is_llm_rate_limited(e):
            payload["llm_rate_limited"] = True
        return payload

    return {
        "stock_code": stock_code,
        "stock_name": stock_name,
        "current_price": current_price,
        "cost_price": cost_price,
        "pnl_pct": round(float(inputs.get("pnl_pct") or 0), 2),
        "sector": inputs.get("sector") or "",
        "signal": parsed.get("signal", "中性"),
        "summary": parsed.get("summary", ""),
        "points": parsed.get("points", []),
        "risk": parsed.get("risk", ""),
        "confidence": parsed.get("confidence", "med"),
        "kline_stats": inputs.get("kline_stats") or {},
        "health_level": (inputs.get("health") or {}).get("level"),
    }


async def generate_one_briefing(stock_code: str) -> dict:
    """Generate and persist briefing for a single current holding/ETF."""
    from database import get_all_holdings, save_briefing, list_external_assets, list_external_actions
    from services.market_data import get_realtime_quotes, normalize_stock_code
    from services.external_assets import _is_onchain_etf, fund_theme_word
    from services.external_ledger import compute_external_state

    code = normalize_stock_code(stock_code)
    target = None
    for h in await get_all_holdings():
        if normalize_stock_code(h["stock_code"]) == code and (h.get("shares") or 0) > 0:
            target = {
                "kind": "stock",
                "code": code,
                "name": h.get("stock_name") or code,
                "shares": int(h.get("shares") or 0),
                "cost_price": float(h.get("cost_price") or 0),
                "theme": "",
            }
            break

    if target is None:
        for x in await list_external_assets():
            xcode = normalize_stock_code(str(x.get("code") or ""))
            if x.get("asset_type") != "FUND" or not _is_onchain_etf(xcode) or xcode != code:
                continue
            st = compute_external_state(await list_external_actions(x["id"]), "FUND")
            sh = float(st.get("shares") or 0)
            if sh <= 0:
                continue
            target = {
                "kind": "etf",
                "code": code,
                "name": x.get("name") or code,
                "shares": int(sh),
                "cost_price": (float(st.get("diluted_cost") or 0) / sh) if sh else 0,
                "theme": fund_theme_word(x.get("name") or ""),
            }
            break

    if target is None:
        raise ValueError(f"未找到当前持有标的: {stock_code}")

    q = (await get_realtime_quotes([code])).get(code) or {}
    cur = q.get("price") or target["cost_price"]
    briefing = await generate_briefing_for_stock(
        code, target["name"], cost_price=target["cost_price"],
        shares=target["shares"], current_price=cur, sector_hint=target.get("theme") or "",
    )
    today = (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%Y-%m-%d")
    briefing["briefing_date"] = today
    if target["kind"] == "etf":
        briefing["asset_class"] = "etf"
    await save_briefing(code, today, json.dumps(briefing, ensure_ascii=False))
    return briefing


async def generate_all_briefings() -> list[dict]:
    """Generate briefings for every A-share holding + 场内 ETF 持仓. Saves each to DB."""
    from database import get_all_holdings, save_briefing, list_external_assets, list_external_actions
    from services.market_data import get_realtime_quotes, is_a_share
    from services.external_assets import _is_onchain_etf, fund_theme_word
    from services.external_ledger import compute_external_state

    holdings = [h for h in await get_all_holdings()
                if is_a_share(h["stock_code"]) and (h.get("shares") or 0) > 0]
    # 场内 ETF 持仓(双账本): 成本用摊薄口径(与券商一致), 主题词当行业拉板块新闻
    etfs = []
    try:
        for x in await list_external_assets():
            code = str(x.get("code") or "")
            if x.get("asset_type") != "FUND" or not _is_onchain_etf(code):
                continue
            st = compute_external_state(await list_external_actions(x["id"]), "FUND")
            sh = float(st.get("shares") or 0)
            if sh <= 0:
                continue
            etfs.append({"code": code, "name": x.get("name") or code, "shares": sh,
                         "cost_price": (float(st.get("diluted_cost") or 0) / sh) if sh else 0,
                         "theme": fund_theme_word(x.get("name") or "")})
    except Exception as e:
        print(f"[briefing] etf holdings scan failed: {e}")
    if not holdings and not etfs:
        return []
    codes = [h["stock_code"] for h in holdings] + [e["code"] for e in etfs]
    quotes = await get_realtime_quotes(codes)

    today = (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%Y-%m-%d")
    # MiniMax token plan can handle several parallel requests. Keep this
    # configurable for Kimi/Qwen users. max_llm controls how many cards call LLM;
    # concurrency controls how many run in parallel.
    max_llm = max(0, int(os.environ.get("LLM_BRIEFING_MAX_LLM", "5") or 0))
    concurrency = max(1, int(os.environ.get("LLM_BRIEFING_CONCURRENCY", "5") or 1))
    llm_gap = max(0.0, float(os.environ.get("LLM_BRIEFING_DELAY", "0") or 0))
    sem = asyncio.Semaphore(concurrency)
    rate_limited = False

    items = []
    for h in holdings:
        code = h["stock_code"]
        q = quotes.get(code) or {}
        cur = q.get("price") or h.get("cost_price", 0)
        items.append({
            "kind": "stock", "code": code,
            "name": h.get("stock_name", "") or q.get("stock_name", ""),
            "cost_price": h["cost_price"], "shares": h["shares"],
            "current_price": cur, "theme": "",
        })
    for e in etfs:
        code = e["code"]
        q = quotes.get(code) or {}
        cur = q.get("price") or e["cost_price"]
        items.append({
            "kind": "etf", "code": code, "name": e["name"],
            "cost_price": e["cost_price"], "shares": int(e["shares"]),
            "current_price": cur, "theme": e["theme"],
        })

    async def _one(idx: int, item: dict) -> dict | None:
        nonlocal rate_limited
        # After max_llm or any rate limit, remaining cards use local summaries.
        use_llm = (idx < max_llm) and not rate_limited
        if llm_gap > 0 and use_llm and idx > 0:
            await asyncio.sleep(llm_gap * min(idx, concurrency))
        async with sem:
            try:
                briefing = await generate_briefing_for_stock(
                    item["code"], item["name"], cost_price=item["cost_price"],
                    shares=item["shares"], current_price=item["current_price"],
                    sector_hint=item.get("theme") or "", skip_llm=not use_llm,
                )
                if briefing.get("llm_rate_limited"):
                    rate_limited = True
                briefing["briefing_date"] = today
                if item["kind"] == "etf":
                    briefing["asset_class"] = "etf"
                await save_briefing(item["code"], today, json.dumps(briefing, ensure_ascii=False))
                return briefing
            except Exception as ex:
                print(f"[briefing] {item.get('kind')} {item.get('code')} failed: {ex}")
                return None

    results = await asyncio.gather(*(_one(i, item) for i, item in enumerate(items)))
    return [r for r in results if r]
