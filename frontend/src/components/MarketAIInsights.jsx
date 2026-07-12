import { useEffect, useState } from 'react'
import { fetchJSON } from '../hooks/useApi'

export default function MarketAIInsights() {
  const [sentiment, setSentiment] = useState(null)
  const [sector, setSector] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const load = async (force = false) => {
    setLoading(true); setErr('')
    try {
      const q = force ? '?force=true' : ''
      const [s, t] = await Promise.all([
        fetchJSON(`/api/market/sentiment-ai${q}`),
        fetchJSON(`/api/sector/trend-ai${force ? '?force=true' : ''}`),
      ])
      setSentiment(s); setSector(t)
    } catch (e) {
      setErr(e.message || 'AI 分析暂不可用')
    } finally { setLoading(false) }
  }

  useEffect(() => { load(false) }, [])

  const hasAny = sentiment?.summary || sector?.summary
  if (!loading && !err && !hasAny) return null

  return (
    <section className="rounded-xl border border-accent/25 bg-accent/5 p-4 md:p-5">
      <div className="flex items-baseline justify-between gap-2 mb-3 flex-wrap">
        <div>
          <h3 className="text-[14px] font-semibold text-text-bright m-0">市场 / 板块 AI 总结</h3>
          <div className="text-[11px] text-text-muted mt-1">基于情绪温度计和板块矩阵的客观解读，不含操作建议。</div>
        </div>
        <button onClick={() => load(true)} disabled={loading}
          className="text-[11px] px-2.5 py-1 rounded border border-accent/40 text-accent hover:bg-accent/10 disabled:opacity-50 cursor-pointer">
          {loading ? '分析中...' : '重新分析'}
        </button>
      </div>

      {loading && !hasAny && <div className="text-[12px] text-text-dim py-2">AI 分析中...</div>}
      {err && <div className="text-[12px] text-bear py-2">{err}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {sentiment?.summary && (
          <InsightCard title="市场情绪 AI" summary={sentiment.summary} note={sentiment.cycle} items={sentiment.points} />
        )}
        {sector?.summary && (
          <InsightCard title="板块趋势 AI" summary={sector.summary} note={sector.holdings_note} items={sector.trends} />
        )}
      </div>
    </section>
  )
}

function InsightCard({ title, summary, note, items }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2/70 px-3 py-2.5">
      <div className="text-[11px] text-accent font-medium mb-1">{title}</div>
      <div className="text-[12.5px] text-text-bright leading-relaxed mb-2">{summary}</div>
      {(items || []).slice(0, 3).map((x, i) => (
        <div key={i} className="text-[11.5px] text-text-dim leading-relaxed flex gap-1.5">
          <span className="text-accent shrink-0">{x.type || '·'}</span>
          <span>{x.detail || x}</span>
        </div>
      ))}
      {note && <div className="text-[11px] text-info mt-1.5 leading-relaxed">{note}</div>}
    </div>
  )
}
