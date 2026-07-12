import { useEffect, useState } from 'react'
import { fetchJSON } from '../hooks/useApi'
import { clearBrokersCache } from '../helpers'

const toWan = (rate) => rate == null ? '' : String(Math.round(Number(rate) * 10000 * 10000) / 10000)
const fromWan = (v) => Number(v || 0) / 10000

function BrokerRow({ broker, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(broker.name || '')
  const [stockWan, setStockWan] = useState(toWan(broker.stock_rate))
  const [stockMin, setStockMin] = useState(String(broker.stock_min ?? 5))
  const [etfWan, setEtfWan] = useState(toWan(broker.etf_rate))
  const [etfMin, setEtfMin] = useState(String(broker.etf_min ?? 5))
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!name.trim()) return alert('券商名称不能为空')
    if (Number(stockWan) < 0 || Number(etfWan) < 0) return alert('费率不能为负')
    setBusy(true)
    try {
      await fetchJSON(`/api/brokers/${broker.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: name.trim(),
          stock_rate: fromWan(stockWan),
          stock_min: Number(stockMin || 0),
          etf_rate: fromWan(etfWan),
          etf_min: Number(etfMin || 0),
        }),
      })
      clearBrokersCache()
      setEditing(false)
      onSaved?.('已保存券商费率')
    } catch (e) { alert(e.message || e) }
    finally { setBusy(false) }
  }

  const setDefault = async () => {
    setBusy(true)
    try {
      await fetchJSON(`/api/brokers/${broker.id}`, { method: 'PUT', body: JSON.stringify({ is_default: true }) })
      clearBrokersCache()
      onSaved?.('已设为默认券商')
    } catch (e) { alert(e.message || e) }
    finally { setBusy(false) }
  }

  const remove = async () => {
    if (!confirm(`确定删除券商「${broker.name}」？`)) return
    setBusy(true)
    try {
      await fetchJSON(`/api/brokers/${broker.id}`, { method: 'DELETE' })
      clearBrokersCache()
      onSaved?.('已删除券商')
    } catch (e) { alert(e.message || e) }
    finally { setBusy(false) }
  }

  if (editing) {
    return (
      <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 space-y-2">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <Field label="券商" value={name} onChange={setName} />
          <Field label="股票佣金(万)" value={stockWan} onChange={setStockWan} type="number" step="0.0001" />
          <Field label="股票最低¥" value={stockMin} onChange={setStockMin} type="number" step="0.01" />
          <Field label="ETF佣金(万)" value={etfWan} onChange={setEtfWan} type="number" step="0.0001" />
          <Field label="ETF最低¥" value={etfMin} onChange={setEtfMin} type="number" step="0.01" />
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={() => setEditing(false)} className="px-3 py-1 rounded border border-border text-[11px] text-text-dim cursor-pointer">取消</button>
          <button onClick={save} disabled={busy} className="px-3 py-1 rounded bg-accent text-bg text-[11px] font-medium cursor-pointer disabled:opacity-50">保存</button>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-3/40 px-3 py-2 flex flex-col md:flex-row md:items-center gap-2">
      <div className="min-w-[120px] flex items-center gap-1.5">
        <span className="text-[12px] text-text-bright font-medium">{broker.name}</span>
        {!!broker.is_default && <span className="text-[10px] px-1.5 py-[1px] rounded bg-accent/15 text-accent border border-accent/30">默认</span>}
      </div>
      <div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] font-mono text-text-dim">
        <span>股票 万{toWan(broker.stock_rate)}</span>
        <span>最低 ¥{broker.stock_min}</span>
        <span>ETF 万{toWan(broker.etf_rate)}</span>
        <span>最低 ¥{broker.etf_min}</span>
      </div>
      <div className="flex gap-2 justify-end">
        {!broker.is_default && <button onClick={setDefault} disabled={busy} className="text-[11px] text-accent hover:underline cursor-pointer">设默认</button>}
        <button onClick={() => setEditing(true)} className="text-[11px] text-accent hover:underline cursor-pointer">编辑</button>
        {!broker.is_default && <button onClick={remove} disabled={busy} className="text-[11px] text-bear hover:underline cursor-pointer">删除</button>}
      </div>
    </div>
  )
}

function Field({ label, value, onChange, type = 'text', step }) {
  return (
    <label className="block">
      <span className="text-[10px] text-text-muted block mb-0.5">{label}</span>
      <input type={type} step={step} value={value} onChange={e => onChange(e.target.value)}
        className="w-full bg-bg border border-border rounded px-2 py-1.5 text-[12px] text-text font-mono outline-none focus:border-accent" />
    </label>
  )
}

export default function BrokerSettings() {
  const [rows, setRows] = useState([])
  const [status, setStatus] = useState({ text: '', ok: null })
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ name: '', stockWan: '1.854', stockMin: '5', etfWan: '1.854', etfMin: '5' })

  const load = async () => {
    try { setRows(await fetchJSON('/api/brokers')) }
    catch (e) { setStatus({ text: '加载失败: ' + (e.message || e), ok: false }) }
  }
  useEffect(() => {
    fetchJSON('/api/brokers')
      .then(setRows)
      .catch(e => setStatus({ text: '加载失败: ' + (e.message || e), ok: false }))
  }, [])

  const onSaved = async (text) => {
    setStatus({ text, ok: true })
    await load()
  }

  const add = async () => {
    if (!draft.name.trim()) return setStatus({ text: '券商名称不能为空', ok: false })
    try {
      await fetchJSON('/api/brokers', {
        method: 'POST',
        body: JSON.stringify({
          name: draft.name.trim(),
          stock_rate: fromWan(draft.stockWan),
          stock_min: Number(draft.stockMin || 0),
          etf_rate: fromWan(draft.etfWan),
          etf_min: Number(draft.etfMin || 0),
        }),
      })
      clearBrokersCache()
      setAdding(false)
      setDraft({ name: '', stockWan: '1.854', stockMin: '5', etfWan: '1.854', etfMin: '5' })
      await onSaved('已新增券商')
    } catch (e) { setStatus({ text: '新增失败: ' + (e.message || e), ok: false }) }
  }

  return (
    <div className="rounded-xl border border-border bg-surface-2 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-[13px] font-semibold text-text-bright">券商费率</div>
          <div className="text-[11px] text-text-muted mt-1 leading-relaxed">
            股票/场内 ETF 手续费按这里的费率自动估算；输入“万几”，例如万1.854。
          </div>
        </div>
        <button onClick={() => setAdding(v => !v)} className="px-3 py-1.5 rounded-md border border-accent/50 text-accent text-[12px] hover:bg-accent/10 cursor-pointer">
          {adding ? '取消新增' : '新增券商'}
        </button>
      </div>

      {adding && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <Field label="券商" value={draft.name} onChange={v => setDraft(d => ({ ...d, name: v }))} />
            <Field label="股票佣金(万)" value={draft.stockWan} onChange={v => setDraft(d => ({ ...d, stockWan: v }))} type="number" step="0.0001" />
            <Field label="股票最低¥" value={draft.stockMin} onChange={v => setDraft(d => ({ ...d, stockMin: v }))} type="number" step="0.01" />
            <Field label="ETF佣金(万)" value={draft.etfWan} onChange={v => setDraft(d => ({ ...d, etfWan: v }))} type="number" step="0.0001" />
            <Field label="ETF最低¥" value={draft.etfMin} onChange={v => setDraft(d => ({ ...d, etfMin: v }))} type="number" step="0.01" />
          </div>
          <div className="flex justify-end"><button onClick={add} className="px-3 py-1 rounded bg-accent text-bg text-[11px] font-medium cursor-pointer">保存新增</button></div>
        </div>
      )}

      <div className="space-y-2">
        {rows.map(b => <BrokerRow key={b.id} broker={b} onSaved={onSaved} />)}
      </div>

      {status.text && <div className={`text-[12px] ${status.ok === true ? 'text-bull' : status.ok === false ? 'text-bear' : 'text-text-dim'}`}>{status.text}</div>}
      <div className="text-[10px] text-text-muted border-t border-border-subtle pt-2">
        说明: 印花税/过户费/规费由系统按 A 股规则自动加上；这里配置的是券商佣金率与最低佣金。
      </div>
    </div>
  )
}
