import { useState, useEffect, useCallback } from 'react'
import { fetchJSON } from '../hooks/useApi'
import SkeletonCard from './Skeleton'

// A股 涨红跌绿: pct → 背景色(强度按幅度), 文字色
function cellBg(pct) {
  if (pct == null) return 'transparent'
  const a = Math.min(Math.abs(pct) / 6, 1) * 0.85 + 0.08
  return pct > 0 ? `rgba(207,92,92,${a})` : pct < 0 ? `rgba(95,168,108,${a})` : 'rgba(120,130,140,0.15)'
}
const pctColor = (v) => v == null ? 'text-text-dim' : v > 0 ? 'text-bear-bright' : v < 0 ? 'text-bull-bright' : 'text-text-dim'

// 客户端缓存: 刷新页面立刻显示上次结果, 不再每次都转圈重拉 (后端本就缓存, 这里只去掉前端闪烁)
const CKEY = (dy, custom = '') => `sectorMatrix_${dy}_${custom}`
const readCache = (dy, custom = '') => { try { return JSON.parse(localStorage.getItem(CKEY(dy, custom)) || 'null') } catch { return null } }
const writeCache = (dy, custom, m, ai) => { try { localStorage.setItem(CKEY(dy, custom), JSON.stringify({ m, ai })) } catch {} }
const parseCustom = (s) => String(s || '').replace(/，/g, ',').split(',').map(x => x.trim()).filter(Boolean)

export default function SectorMatrix() {
  const [days, setDays] = useState(10)
  const [customText, setCustomText] = useState(() => localStorage.getItem('sectorMatrixCustom') || '')
  const customKey = parseCustom(customText).join(',')
  const cached = readCache(10, customKey)
  const [m, setM] = useState(cached?.m || null)
  const [ai, setAi] = useState(cached?.ai || null)
  const [loading, setLoading] = useState(!cached)
  const [aiLoading, setAiLoading] = useState(false)
  const [sectorNames, setSectorNames] = useState([])
  const [sortBy, setSortBy] = useState(() => localStorage.getItem('sectorMatrixSortBy') || 'cum')
  const [sortDir, setSortDir] = useState(() => localStorage.getItem('sectorMatrixSortDir') || 'desc')
  const [sectorCandidateLimit, setSectorCandidateLimit] = useState(6)


  const load = useCallback((dy, force = false) => {
    const custom = parseCustom(customText).join(',')
    try { localStorage.setItem('sectorMatrixCustom', customText) } catch {}
    const cache = readCache(dy, custom)
    // 有缓存先秒显, 不显示 loading; 无缓存才转圈
    if (cache?.m) setM(cache.m)
    if (cache?.ai) setAi(cache.ai)
    setLoading(!cache?.m || force)
    let nm = cache?.m || null, na = cache?.ai || null
    fetchJSON(`/api/sector/matrix?days=${dy}${force ? '&force=true' : ''}${custom ? `&custom=${encodeURIComponent(custom)}` : ''}`)
      .then(r => { nm = r; setM(r); writeCache(dy, custom, nm, na) }).catch(() => {}).finally(() => setLoading(false))
  }, [customText])

  const loadAi = useCallback((dy, force = false) => {
    setAiLoading(true)
    const custom = parseCustom(customText).join(',')
    let nm = readCache(dy, custom)?.m || m
    let na = ai
    fetchJSON(`/api/sector/trend-ai?days=${dy}${force ? '&force=true' : ''}${custom ? `&custom=${encodeURIComponent(custom)}` : ''}`)
      .then(r => { na = r; setAi(r); writeCache(dy, custom, nm, na) }).catch(() => {}).finally(() => setAiLoading(false))
  }, [ai, m, customText])

  useEffect(() => { load(days) }, [days, load])
  useEffect(() => {
    fetchJSON('/api/sector/matrix/sectors')
      .then(r => setSectorNames(r.sectors || []))
      .catch(() => {})
  }, [])

  const selectedCustom = parseCustom(customText)
  const addCustom = (name) => {
    const n = String(name || '').trim()
    if (!n) return
    const next = Array.from(new Set([...parseCustom(customText), n]))
    setCustomText(next.join(', '))
  }
  const query = customText.split(/[,，]/).pop().trim()
  const suggestions = sectorNames
    .filter(n => !selectedCustom.includes(n))
    .filter(n => !query || n.includes(query))
  const common = ['银行', '证券', '保险', '通信设备', '互联网电商', '半导体', '消费电子', '工业金属', '贵金属', '小金属']
    .filter(n => sectorNames.includes(n) && !selectedCustom.includes(n))
  const candidatePool = suggestions.length ? suggestions : common
  const shownCandidates = candidatePool.slice(0, sectorCandidateLimit)
  const remainingCandidates = Math.max(0, candidatePool.length - shownCandidates.length)

  const setSort = (field) => {
    if (sortBy === field) {
      const next = sortDir === 'desc' ? 'asc' : 'desc'
      setSortDir(next); try { localStorage.setItem('sectorMatrixSortDir', next) } catch {}
    } else {
      setSortBy(field); setSortDir('desc')
      try { localStorage.setItem('sectorMatrixSortBy', field); localStorage.setItem('sectorMatrixSortDir', 'desc') } catch {}
    }
  }
  const sortedRows = [...(m?.rows || [])].sort((a, b) => {
    const key = sortBy === 'today' ? 'today_pct' : sortBy === 'inflow' ? 'net_inflow' : 'cum_pct'
    const av = Number(a[key] ?? -9999)
    const bv = Number(b[key] ?? -9999)
    return sortDir === 'desc' ? bv - av : av - bv
  })
  const sortMark = (field) => sortBy === field ? (sortDir === 'desc' ? '↓' : '↑') : ''

  if (loading && !m) return <SkeletonCard rows={6} label="板块矩阵计算中(首次约20-40秒)" />
  if (!m || !(m.rows || []).length) return null

  return (
    <div className="bg-surface-2 border border-border rounded-xl p-4 md:p-5">
      <div className="flex items-baseline justify-between gap-2 mb-3 flex-wrap">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[14px] font-semibold text-text-bright m-0">板块趋势矩阵</h3>
          <span className="text-[10.5px] text-text-muted">近 {m.days} 日 · 红涨绿跌 · 资金/动能</span>
          {m.intraday && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bear/15 text-bear-bright">含今日盘中 {m.today}</span>
          )}
        </div>
        <div className="flex gap-1 items-center">
          <span className="text-[10.5px] text-text-muted mr-1">排序</span>
          <button onClick={() => setSort('today')}
            className={`text-[11px] px-2 py-0.5 rounded border ${sortBy === 'today' ? 'bg-accent/20 text-accent border-accent/40' : 'bg-surface-3 text-text-dim border-transparent hover:text-text'}`}>
            今日{sortMark('today')}
          </button>
          <button onClick={() => setSort('cum')}
            className={`text-[11px] px-2 py-0.5 rounded border ${sortBy === 'cum' ? 'bg-accent/20 text-accent border-accent/40' : 'bg-surface-3 text-text-dim border-transparent hover:text-text'}`}>
            累计{sortMark('cum')}
          </button>
          <button onClick={() => setSort('inflow')}
            className={`text-[11px] px-2 py-0.5 rounded border ${sortBy === 'inflow' ? 'bg-accent/20 text-accent border-accent/40' : 'bg-surface-3 text-text-dim border-transparent hover:text-text'}`}>
            净流入{sortMark('inflow')}
          </button>
          {[10, 20].map(dy => (
            <button key={dy} onClick={() => setDays(dy)}
              className={`text-[11px] px-2 py-0.5 rounded border ${days === dy ? 'bg-accent/20 text-accent border-accent/40' : 'bg-surface-3 text-text-dim border-transparent hover:text-text'}`}>
              {dy}日
            </button>
          ))}
          <button onClick={() => load(days, true)} disabled={loading}
            className="text-[11px] px-2 py-0.5 rounded border border-border text-text-dim hover:text-text disabled:opacity-40 disabled:cursor-wait">
            {loading ? '刷新中…' : '刷新'}
          </button>
          <button onClick={() => loadAi(days, true)} disabled={aiLoading}
            className="text-[11px] px-2 py-0.5 rounded border border-accent/40 text-accent hover:bg-accent/10 disabled:opacity-40 disabled:cursor-wait">
            {aiLoading ? 'AI中…' : 'AI分析'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3 text-[11px]">
        <span className="text-text-muted">自选板块</span>
        <input value={customText} onChange={e => setCustomText(e.target.value)}
          placeholder="如: 银行, 互联网电商, 通信设备"
          className="flex-1 min-w-[220px] bg-bg border border-border rounded px-2 py-1 text-[11px] text-text outline-none focus:border-accent" />
        <button onClick={() => load(days, true)} disabled={loading}
          className="px-2 py-1 rounded border border-border text-text-dim hover:text-text disabled:opacity-40">应用</button>
        {!!customKey && <span className="text-text-muted">已加: {customKey}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mb-3 text-[10.5px]">
        <span className="text-text-muted">候选</span>
        {shownCandidates.map(n => (
          <button key={n} onClick={() => addCustom(n)}
            className="px-1.5 py-[1px] rounded border border-border text-text-dim hover:text-accent hover:border-accent/50">
            +{n}
          </button>
        ))}
        {remainingCandidates > 0 && (
          <button onClick={() => setSectorCandidateLimit(v => Math.min(v + 24, candidatePool.length))}
            className="px-1.5 py-[1px] rounded border border-accent/30 text-accent hover:bg-accent/10">
            更多{remainingCandidates}
          </button>
        )}
        {sectorCandidateLimit > 6 && (
          <button onClick={() => setSectorCandidateLimit(6)}
            className="px-1.5 py-[1px] rounded border border-border text-text-dim hover:text-text">
            收起
          </button>
        )}
        {!sectorNames.length && <span className="text-text-muted">板块名加载中…</span>}
      </div>

      {/* AI 趋势分析 */}
      {aiLoading && !ai?.summary && <div className="text-[11.5px] text-text-dim mb-3">AI 分析板块趋势中…<span className="text-text-muted">(约 10–20 秒)</span></div>}
      {ai && ai.summary && (
        <div className={`mb-3 px-3 py-2.5 rounded-lg bg-accent/10 border border-accent/30 transition-opacity ${aiLoading ? 'opacity-50' : ''}`}>
          <div className="flex items-baseline justify-between gap-2 mb-1.5">
            <span className="text-[11px] text-accent font-medium">AI 趋势分析{aiLoading && <span className="ml-1 text-text-muted">· 重新分析中…</span>}</span>
          </div>
          <div className="text-[12.5px] text-text-bright leading-relaxed mb-1.5">{ai.summary}</div>
          <div className="space-y-1">
            {(ai.trends || []).map((t, i) => (
              <div key={i} className="text-[11.5px] leading-relaxed flex gap-1.5">
                <span className="text-accent shrink-0 font-medium">{t.type}</span>
                <span className="text-text-dim">{t.detail}</span>
              </div>
            ))}
          </div>
          {ai.holdings_note && <div className="text-[11px] text-info mt-1.5 leading-relaxed">持仓: {ai.holdings_note}</div>}
        </div>
      )}

      {/* 热力矩阵 — 铺满整宽, 日格等分剩余空间 */}
      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full border-collapse text-[11.5px]" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 104 }} />
            <col style={{ width: 56 }} />
            <col style={{ width: 56 }} />
            <col style={{ width: 64 }} />
            {([...(m.dates || [])].reverse()).map((_, i) => <col key={i} />)}
          </colgroup>
          <thead>
            <tr className="text-text-muted text-[10.5px]">
              <th className="text-left font-normal sticky left-0 bg-surface-2 pr-2 z-10 pb-1">板块</th>
              <th className="font-normal px-1 text-right pb-1 cursor-pointer hover:text-accent" onClick={() => setSort('today')}>今日{sortMark('today')}</th>
              <th className="font-normal px-1 text-right pb-1 cursor-pointer hover:text-accent" onClick={() => setSort('cum')}>累计{sortMark('cum')}</th>
              <th className="font-normal px-1 text-right pb-1 cursor-pointer hover:text-accent" onClick={() => setSort('inflow')}>净流入{sortMark('inflow')}</th>
              {([...(m.dates || [])].reverse()).map((d, i) => (
                <th key={i} className={`text-center pb-1 ${m.intraday && d === m.today ? 'text-bear-bright font-semibold' : 'font-normal'}`}>{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r, ri) => (
              <tr key={ri} className="border-t border-border-subtle/30">
                <td className="text-text-bright whitespace-nowrap truncate sticky left-0 bg-surface-2 pr-2 z-10 py-1.5">
                  {r.name}{r.streak >= 2 && <span className="text-bear-bright ml-1 text-[10px]">↑{r.streak}</span>}
                </td>
                <td className={`px-1 text-right font-mono ${pctColor(r.today_pct)}`}>{r.today_pct >= 0 ? '+' : ''}{r.today_pct}</td>
                <td className={`px-1 text-right font-mono font-semibold ${pctColor(r.cum_pct)}`}>{r.cum_pct >= 0 ? '+' : ''}{r.cum_pct}</td>
                <td className={`px-1 text-right font-mono ${pctColor(r.net_inflow)}`}>{r.net_inflow >= 0 ? '+' : ''}{r.net_inflow}亿</td>
                {([...(r.daily || [])].reverse()).map((c, ci) => (
                  <td key={ci} className="text-center font-mono px-1 py-1.5 rounded-sm" title={`${c.date} ${c.pct >= 0 ? '+' : ''}${c.pct}%`}
                    style={{ background: cellBg(c.pct), color: Math.abs(c.pct) > 1.5 ? '#fff' : 'var(--color-text-dim)' }}>
                    {c.pct >= 0 ? '+' : ''}{c.pct.toFixed(1)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-[10px] text-text-muted pt-2.5 mt-2 border-t border-border-subtle">
        同花顺行业 · 净流入为今日实时榜口径 · 当前按{sortBy === 'today' ? '今日涨跌幅' : sortBy === 'inflow' ? '今日净流入' : `近 ${m.days} 日累计涨幅`}{sortDir === 'desc' ? '降序' : '升序'}排序 · ↑N=连涨天数 · 纯客观, 不构成买卖建议
      </div>
    </div>
  )
}
