import { useEffect, useState } from 'react'
import { fetchJSON } from '../hooks/useApi'

export default function ThesisReview() {
  const [holdings, setHoldings] = useState([])
  const [theses, setTheses] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [text, setText] = useState('')
  const [status, setStatus] = useState({ text: '', ok: null })

  const load = async () => {
    setLoading(true)
    try {
      const [hs, ts] = await Promise.all([
        fetchJSON('/api/portfolio'),
        fetchJSON('/api/portfolio/thesis'),
      ])
      setHoldings(hs || [])
      setTheses(ts || [])
    } catch (e) {
      setStatus({ text: '加载失败: ' + (e.message || e), ok: false })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const thesisByCode = new Map((theses || []).map(t => [String(t.code), t]))
  const missing = holdings.filter(h => !thesisByCode.has(String(h.stock_code)))

  const openEdit = (h) => {
    const existing = thesisByCode.get(String(h.stock_code))
    setEditing({ code: h.stock_code, name: h.stock_name || existing?.name || '' })
    setText(existing?.thesis || '')
  }

  const save = async () => {
    if (!editing) return
    if (!text.trim()) return setStatus({ text: '买入逻辑不能为空', ok: false })
    try {
      await fetchJSON(`/api/portfolio/thesis/${encodeURIComponent(editing.code)}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editing.name, thesis: text.trim() }),
      })
      setStatus({ text: '已保存买入逻辑', ok: true })
      setEditing(null); setText('')
      await load()
    } catch (e) {
      setStatus({ text: '保存失败: ' + (e.message || e), ok: false })
    }
  }

  return (
    <div className="bg-surface-2 border border-border rounded-xl p-4 md:p-5">
      <div className="flex items-baseline justify-between gap-2 mb-3 flex-wrap">
        <div>
          <h3 className="text-[14px] font-semibold text-text-bright m-0">买入逻辑复盘</h3>
          <div className="text-[10.5px] text-text-muted mt-1">记录“当初为什么买”，供问问市场/复盘逐条对照。</div>
        </div>
        <button onClick={load} className="text-[11px] px-2.5 py-1 rounded border border-border text-text-dim hover:text-text cursor-pointer">刷新</button>
      </div>

      {loading ? <div className="text-[12px] text-text-dim py-3">加载中...</div> : (
        <div className="space-y-3">
          {missing.length > 0 && (
            <div className="rounded-lg border border-warn/30 bg-warn/8 px-3 py-2">
              <div className="text-[11px] text-warn mb-1">未填写买入逻辑的持仓</div>
              <div className="flex flex-wrap gap-1.5">
                {missing.map(h => (
                  <button key={h.stock_code} onClick={() => openEdit(h)}
                    className="text-[11px] px-2 py-0.5 rounded bg-surface-3 border border-border text-text-dim hover:text-accent cursor-pointer">
                    {h.stock_name || h.stock_code}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
            {holdings.map(h => {
              const t = thesisByCode.get(String(h.stock_code))
              return (
                <div key={h.stock_code} className="rounded-lg border border-border-subtle bg-surface-3/40 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-[12px] text-text-bright font-medium">{h.stock_name || t?.name || h.stock_code}</span>
                      <span className="font-mono text-[10px] text-text-muted ml-1">{h.stock_code}</span>
                    </div>
                    <button onClick={() => openEdit(h)} className="text-[11px] text-accent hover:underline cursor-pointer">{t ? '编辑' : '补充'}</button>
                  </div>
                  <div className={`text-[11.5px] mt-1 leading-relaxed ${t ? 'text-text-dim' : 'text-text-muted italic'}`}>
                    {t?.thesis || '尚未记录买入逻辑'}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setEditing(null)}>
          <div className="bg-surface-2 border border-border rounded-xl p-5 w-[560px] max-w-[95vw]" onClick={e => e.stopPropagation()}>
            <div className="text-[14px] font-semibold text-text-bright mb-2">{editing.name || editing.code} 买入逻辑</div>
            <textarea rows={8} value={text} onChange={e => setText(e.target.value)}
              placeholder="为什么买、看中什么、预期是什么、什么情况说明逻辑变化..."
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-[13px] text-text outline-none focus:border-accent resize-none" />
            <div className="flex gap-2 mt-3">
              <button onClick={save} className="flex-1 px-4 py-2 rounded-lg bg-accent text-bg text-[13px] font-medium cursor-pointer">保存</button>
              <button onClick={() => setEditing(null)} className="px-4 py-2 rounded-lg border border-border text-text-dim text-[13px] cursor-pointer">取消</button>
            </div>
          </div>
        </div>
      )}

      {status.text && <div className={`text-[12px] mt-2 ${status.ok === true ? 'text-bull' : status.ok === false ? 'text-bear' : 'text-text-dim'}`}>{status.text}</div>}
    </div>
  )
}
