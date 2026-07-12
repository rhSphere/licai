import { useState, useEffect } from 'react'
import { fetchJSON } from '../hooks/useApi'
import { fmtPrice, loadBrokers } from '../helpers'

const enc = (value) => encodeURIComponent(value)

const ACTION_TYPES = [
  { value: 'BUY', label: '买入' },
  { value: 'SELL', label: '卖出' },
  { value: 'ADD', label: '补仓(加仓)' },
  { value: 'REDUCE', label: '减仓' },
  { value: 'DIVIDEND', label: '现金分红' },
  { value: 'BONUS', label: '送股/转增' },
]

const ACQUIRE_TYPES = new Set(['BUY', 'ADD', 'BONUS'])
const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/

const formatActionTime = (value) => {
  const s = String(value || '').trim()
  if (!s) return ''
  return /^\d{1,2}:\d{2}:\d{2}$/.test(s) ? s.padStart(8, '0') : s.slice(0, 5)
}

const TYPE_ALIASES = {
  BUY: 'BUY', '买入': 'BUY', '买': 'BUY', 'B': 'BUY',
  ADD: 'ADD', '补仓': 'ADD', '加仓': 'ADD', '加': 'ADD',
  SELL: 'SELL', '卖出': 'SELL', '卖': 'SELL', 'S': 'SELL',
  REDUCE: 'REDUCE', '减仓': 'REDUCE', '减': 'REDUCE',
  DIVIDEND: 'DIVIDEND', '现金分红': 'DIVIDEND', '分红': 'DIVIDEND', '股息': 'DIVIDEND', '股息入账': 'DIVIDEND',
  BONUS: 'BONUS', '送股': 'BONUS', '转增': 'BONUS',
}

const normalizeType = (raw) => {
  const s = String(raw || '').trim()
  return TYPE_ALIASES[s] || TYPE_ALIASES[s.toUpperCase()] || ''
}

const splitBulkLine = (line) => {
  const s = line.trim()
  if (!s) return []
  if (s.includes('\t')) return s.split('\t').map(x => x.trim())
  if (s.includes(',')) return s.split(',').map(x => x.trim())
  return s.split(/\s+/).map(x => x.trim())
}

function parseBulkActions(text, defaultBroker = '') {
  const rows = []
  const errors = []
  const lines = String(text || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (!raw || raw.startsWith('#')) continue
    const cols = splitBulkLine(raw)
    if (cols.length < 4) {
      errors.push(`第 ${i + 1} 行: 至少需要 日期 类型 价格 数量`)
      continue
    }
    const [trade_date, typeRaw, priceRaw, sharesRaw, ...restRaw] = cols
    const action_type = normalizeType(typeRaw)
    let price = Number(priceRaw)
    let shares = parseInt(sharesRaw, 10)
    const rest = [...restRaw]
    let feeRaw = ''
    let fee = null
    if (rest.length && !TIME_RE.test(rest[0])) {
      feeRaw = rest.shift() || ''
      fee = feeRaw === '' || feeRaw === '-' ? null : Number(feeRaw)
    }
    let trade_time = ''
    if (rest.length && TIME_RE.test(rest[0])) {
      const rawTime = rest.shift() || ''
      trade_time = rawTime.length <= 5 ? rawTime.padStart(5, '0') : rawTime.padStart(8, '0')
    }
    // 券商导出的分红常见格式: 日期 股息入账 0 0 0 时间 总金额
    // 后端 DIVIDEND 账本用 price * shares 计入金额, 所以这里把总额归一成 price=总额, shares=1.
    if (action_type === 'DIVIDEND' && (!(shares > 0)) && rest.length) {
      const amount = Number(rest[rest.length - 1])
      if (amount > 0) {
        price = amount
        shares = 1
        rest.pop()
        rest.push('股息入账')
      }
    }
    const note = rest.join(' ')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trade_date)) errors.push(`第 ${i + 1} 行: 日期需为 YYYY-MM-DD`)
    if (!action_type) errors.push(`第 ${i + 1} 行: 类型无法识别 (${typeRaw})`)
    if (!(price >= 0)) errors.push(`第 ${i + 1} 行: 价格无效`)
    if (!(shares > 0)) errors.push(`第 ${i + 1} 行: 数量无效`)
    if (feeRaw !== '' && feeRaw !== '-' && !(fee >= 0)) errors.push(`第 ${i + 1} 行: 手续费无效`)
    if (errors.length && errors[errors.length - 1].startsWith(`第 ${i + 1} 行:`)) continue
    rows.push({
      trade_date,
      action_type,
      price,
      shares,
      ...(fee != null ? { fee } : {}),
      ...(trade_time ? { trade_time } : {}),
      ...(defaultBroker ? { broker: defaultBroker } : {}),
      ...(note ? { note } : {}),
    })
  }
  return { rows, errors }
}

function ActionRow({ action, editing, onSave, onCancel, onEdit, onDelete, brokers = [], selected = false, onSelect }) {
  const [draft, setDraft] = useState(action)
  useEffect(() => { setDraft(action) }, [action])

  if (!editing) {
    const isAcquire = ACQUIRE_TYPES.has(action.action_type)
    const typeLabel = ACTION_TYPES.find(t => t.value === action.action_type)?.label || action.action_type
    const feeOverride = action.fee != null   // 用户手填了 override
    return (
      <tr className="border-t border-border-subtle hover:bg-surface-2/30">
        <td className="py-1.5 px-2 text-center">
          <input type="checkbox" checked={selected} onChange={e => onSelect?.(e.target.checked)} />
        </td>
        <td className="py-1.5 px-2 text-text-muted">{action.trade_date || '--'}
          {action.at_time && <span className="block text-[10px] text-text-dim font-mono">{formatActionTime(action.at_time)}{!action.trade_time && <span title="按录入时间推断">~</span>}</span>}
        </td>
        <td className={`py-1.5 px-2 text-[11px] ${isAcquire ? 'text-bull' : 'text-bear'}`}>{typeLabel}
          {action.broker_effective && <span className="block text-[10px] text-text-dim">{action.broker_effective}{!action.broker && <span title="用持仓默认券商">~</span>}</span>}
        </td>
        <td className="py-1.5 px-2 text-right font-mono">{fmtPrice(action.price)}</td>
        <td className="py-1.5 px-2 text-right font-mono">{action.shares}</td>
        <td className="py-1.5 px-2 text-right font-mono text-[11px]"
          title={feeOverride ? '已手填覆盖' : '按券商费率自动估算 (万1.854 / 5元起)'}>
          {action.fee_effective != null ? `¥${action.fee_effective.toFixed(2)}` : '--'}
          {feeOverride && <span className="text-accent ml-0.5">·</span>}
        </td>
        <td className="py-1.5 px-2 text-[11px] text-text-muted">{action.note || '--'}</td>
        <td className="py-1.5 px-2 text-center">
          <button onClick={() => onEdit()} className="text-[11px] text-accent hover:underline cursor-pointer mr-2">编辑</button>
          <button onClick={() => onDelete()} className="text-[11px] text-bear hover:underline cursor-pointer">删除</button>
        </td>
      </tr>
    )
  }

  // draft.fee: null/undefined = 自动估; '' = 显式清空; 数字 = override
  const feeInput = draft.fee == null ? '' : String(draft.fee)
  const onFeeChange = (v) => setDraft({ ...draft, fee: v === '' ? null : (parseFloat(v) || 0), fee_set: true })

  return (
    <tr className="border-t border-border-subtle bg-surface-3/40">
      <td className="py-1.5 px-2 text-center">--</td>
      <td className="py-1.5 px-2">
        <input type="date" className="bg-bg border border-border rounded px-1.5 py-0.5 text-[12px] w-32" value={draft.trade_date || ''} onChange={e => setDraft({ ...draft, trade_date: e.target.value })} />
        <input type="time" step="1" className="bg-bg border border-border rounded px-1.5 py-0.5 text-[12px] w-28 mt-1 block text-text-dim" value={draft.trade_time || ''} onChange={e => setDraft({ ...draft, trade_time: e.target.value })} title="成交时刻(可选, 支持秒), 留空用录入时间, 供分时图打点" />
      </td>
      <td className="py-1.5 px-2">
        <select className="bg-bg border border-border rounded px-1.5 py-0.5 text-[12px]" value={draft.action_type} onChange={e => setDraft({ ...draft, action_type: e.target.value })}>
          {ACTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <select className="bg-bg border border-border rounded px-1.5 py-0.5 text-[11px] mt-1 block text-text-dim w-full" value={draft.broker || ''} onChange={e => setDraft({ ...draft, broker: e.target.value })} title="本笔券商, 留空用持仓默认">
          <option value="">默认券商</option>
          {brokers.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
        </select>
      </td>
      <td className="py-1.5 px-2"><input type="number" step="0.0001" className="bg-bg border border-border rounded px-1.5 py-0.5 text-[12px] w-20 text-right font-mono" value={draft.price} onChange={e => setDraft({ ...draft, price: parseFloat(e.target.value) || 0 })} /></td>
      <td className="py-1.5 px-2"><input type="number" step="100" min="100" className="bg-bg border border-border rounded px-1.5 py-0.5 text-[12px] w-20 text-right font-mono" value={draft.shares} onChange={e => setDraft({ ...draft, shares: parseInt(e.target.value) || 0 })} /></td>
      <td className="py-1.5 px-2">
        <input type="number" step="0.01" min="0"
          placeholder={action.fee_auto != null ? `估 ${action.fee_auto.toFixed(2)}` : '0'}
          className="bg-bg border border-border rounded px-1.5 py-0.5 text-[12px] w-20 text-right font-mono"
          value={feeInput} onChange={e => onFeeChange(e.target.value)}
          title="留空 = 用券商费率自动估算; 填值 = 覆盖" />
      </td>
      <td className="py-1.5 px-2"><input type="text" className="bg-bg border border-border rounded px-1.5 py-0.5 text-[12px] w-full" placeholder="备注" value={draft.note || ''} onChange={e => setDraft({ ...draft, note: e.target.value })} /></td>
      <td className="py-1.5 px-2 text-center">
        <button onClick={() => onSave(draft)} className="text-[11px] text-bull hover:underline cursor-pointer mr-2">保存</button>
        <button onClick={() => onCancel()} className="text-[11px] text-text-dim hover:underline cursor-pointer">取消</button>
      </td>
    </tr>
  )
}

export default function TransactionHistory({ stockCode, stockName, onClose, onChange }) {
  const [actions, setActions] = useState([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState(null)
  const [adding, setAdding] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkBroker, setBulkBroker] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkMsg, setBulkMsg] = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [deletingBulk, setDeletingBulk] = useState(false)
  const [brokers, setBrokers] = useState([])
  useEffect(() => { loadBrokers().then(setBrokers) }, [])
  const [newAction, setNewAction] = useState({
    action_type: 'BUY',
    broker: '',
    price: '',
    shares: '',
    fee: '',
    trade_date: new Date().toISOString().slice(0, 10),
    trade_time: '',     // 可选 HH:MM 成交时刻; 留空走录入时间, 供分时图打点
    note: '',
  })

  const load = async () => {
    try {
      const list = await fetchJSON(`/api/portfolio/${enc(stockCode)}/actions`)
      // Sort by trade_date ascending (oldest first)
      list.sort((a, b) => (a.trade_date || '').localeCompare(b.trade_date || ''))
      setActions(list)
      setSelectedIds(new Set())
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [stockCode])

  const handleAdd = async () => {
    if (!newAction.price || !newAction.shares || !newAction.trade_date) return alert('请填完整')
    const body = {
      ...newAction,
      price: parseFloat(newAction.price),
      shares: parseInt(newAction.shares),
    }
    if (newAction.fee != null && newAction.fee !== '') {
      body.fee = parseFloat(newAction.fee)
    } else {
      delete body.fee
    }
    await fetchJSON(`/api/portfolio/${enc(stockCode)}/actions`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    setAdding(false)
    setNewAction({ action_type: 'BUY', broker: '', price: '', shares: '', trade_date: new Date().toISOString().slice(0, 10), trade_time: '', note: '', fee: '' })
    await load()
    onChange?.()
  }

  const handleSave = async (draft) => {
    const body = {
      action_type: draft.action_type,
      price: parseFloat(draft.price),
      shares: parseInt(draft.shares),
      trade_date: draft.trade_date,
      trade_time: draft.trade_time || '',   // "" → 清空回退录入时间
      broker: draft.broker || '',           // "" → 用持仓默认券商
      note: draft.note || '',
    }
    // 用户改了 fee (fee_set 标记): 显式传 fee (null=清空回退自动估)
    if (draft.fee_set) {
      body.fee = draft.fee
      body.fee_set = true
    }
    await fetchJSON(`/api/portfolio/actions/${draft.id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
    setEditingId(null)
    await load()
    onChange?.()
  }

  const handleDelete = async (id) => {
    if (!confirm('确定删除这条记录？会重新计算持仓成本。')) return
    await fetchJSON(`/api/portfolio/actions/${id}`, { method: 'DELETE' })
    await load()
    onChange?.()
  }

  const visibleIds = actions.map(a => a.id)
  const selectedCount = selectedIds.size
  const allSelected = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id))
  const toggleSelect = (id, checked) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const toggleSelectAll = (checked) => {
    setSelectedIds(checked ? new Set(visibleIds) : new Set())
  }
  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds)
    if (!ids.length) return
    if (!confirm(`确定删除选中的 ${ids.length} 条记录？会重新计算持仓成本。`)) return
    setDeletingBulk(true)
    try {
      await fetchJSON(`/api/portfolio/${enc(stockCode)}/actions/bulk-delete`, {
        method: 'POST',
        body: JSON.stringify({ ids }),
      })
      await load()
      onChange?.()
    } finally {
      setDeletingBulk(false)
    }
  }

  const bulkParsed = parseBulkActions(bulkText, bulkBroker)

  const handleBulkImport = async () => {
    if (bulkParsed.errors.length) return setBulkMsg(bulkParsed.errors.slice(0, 3).join('\n'))
    if (!bulkParsed.rows.length) return setBulkMsg('没有可导入的记录')
    setBulkBusy(true)
    setBulkMsg('')
    try {
      const res = await fetchJSON(`/api/portfolio/${enc(stockCode)}/actions/bulk`, {
        method: 'POST',
        body: JSON.stringify({ actions: bulkParsed.rows }),
      })
      setBulkMsg(`已导入 ${res.inserted || bulkParsed.rows.length} 条`)
      setBulkText('')
      setBulkOpen(false)
      await load()
      onChange?.()
    } catch (e) {
      setBulkMsg(e.message || String(e))
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl p-5 w-[720px] max-w-[95vw] max-h-[85vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}>

        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[15px] font-semibold text-text-bright">
            交易历史 — {stockName} <span className="text-[12px] font-mono text-text-dim">({stockCode})</span>
          </h3>
          <button onClick={onClose} className="text-text-dim hover:text-text cursor-pointer">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="text-center text-text-dim py-6">加载中...</div>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-text-dim text-[11px] sticky top-0 bg-surface">
                  <th className="py-2 px-2 text-center font-normal w-8">
                    <input type="checkbox" checked={allSelected} onChange={e => toggleSelectAll(e.target.checked)} />
                  </th>
                  <th className="py-2 px-2 text-left font-normal">日期</th>
                  <th className="py-2 px-2 text-left font-normal">类型</th>
                  <th className="py-2 px-2 text-right font-normal">价格</th>
                  <th className="py-2 px-2 text-right font-normal">数量</th>
                  <th className="py-2 px-2 text-right font-normal" title="手续费 (自动按券商费率估; 编辑可填实际值覆盖)">手续费</th>
                  <th className="py-2 px-2 text-left font-normal">备注</th>
                  <th className="py-2 px-2 text-center font-normal w-24">操作</th>
                </tr>
              </thead>
              <tbody>
                {actions.map(a => (
                  <ActionRow
                    key={a.id}
                    action={a}
                    editing={editingId === a.id}
                    onSave={handleSave}
                    onCancel={() => setEditingId(null)}
                    onEdit={() => setEditingId(a.id)}
                    onDelete={() => handleDelete(a.id)}
                    selected={selectedIds.has(a.id)}
                    onSelect={(checked) => toggleSelect(a.id, checked)}
                    brokers={brokers}
                  />
                ))}

                {adding && (
                  <tr className="border-t border-border-subtle bg-bull-bg">
                    <td className="py-1.5 px-2 text-center">--</td>
                    <td className="py-1.5 px-2">
                      <input type="date" className="bg-bg border border-border rounded px-1.5 py-0.5 text-[12px] w-32" value={newAction.trade_date} onChange={e => setNewAction({ ...newAction, trade_date: e.target.value })} />
                      <input type="time" step="1" className="bg-bg border border-border rounded px-1.5 py-0.5 text-[12px] w-28 mt-1 block text-text-dim" value={newAction.trade_time} onChange={e => setNewAction({ ...newAction, trade_time: e.target.value })} title="成交时刻(可选, 支持秒), 留空用录入时间, 供分时图打点" />
                    </td>
                    <td className="py-1.5 px-2">
                      <select className="bg-bg border border-border rounded px-1.5 py-0.5 text-[12px]" value={newAction.action_type} onChange={e => setNewAction({ ...newAction, action_type: e.target.value })}>
                        {ACTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                      <select className="bg-bg border border-border rounded px-1.5 py-0.5 text-[11px] mt-1 block text-text-dim w-full" value={newAction.broker} onChange={e => setNewAction({ ...newAction, broker: e.target.value })} title="本笔券商, 留空用持仓默认">
                        <option value="">默认券商</option>
                        {brokers.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
                      </select>
                    </td>
                    <td className="py-1.5 px-2"><input type="number" step="0.0001" className="bg-bg border border-border rounded px-1.5 py-0.5 text-[12px] w-20 text-right font-mono" placeholder="价格" value={newAction.price} onChange={e => setNewAction({ ...newAction, price: e.target.value })} /></td>
                    <td className="py-1.5 px-2"><input type="number" step="100" min="100" className="bg-bg border border-border rounded px-1.5 py-0.5 text-[12px] w-20 text-right font-mono" placeholder="数量" value={newAction.shares} onChange={e => setNewAction({ ...newAction, shares: e.target.value })} /></td>
                    <td className="py-1.5 px-2"><input type="number" step="0.01" min="0" className="bg-bg border border-border rounded px-1.5 py-0.5 text-[12px] w-20 text-right font-mono" placeholder="自动估" value={newAction.fee ?? ''} onChange={e => setNewAction({ ...newAction, fee: e.target.value })} title="留空 = 按券商费率自动估; 填值 = 实际手续费" /></td>
                    <td className="py-1.5 px-2"><input type="text" className="bg-bg border border-border rounded px-1.5 py-0.5 text-[12px] w-full" placeholder="备注" value={newAction.note} onChange={e => setNewAction({ ...newAction, note: e.target.value })} /></td>
                    <td className="py-1.5 px-2 text-center">
                      <button onClick={handleAdd} className="text-[11px] text-bull hover:underline cursor-pointer mr-2">确认</button>
                      <button onClick={() => setAdding(false)} className="text-[11px] text-text-dim hover:underline cursor-pointer">取消</button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-border mt-2">
          <div className="text-[11px] text-text-muted">
            {actions.length} 条记录 · 每次修改会自动按 FIFO 重算持仓均价
            {selectedCount > 0 && <span className="ml-2 text-accent">已选 {selectedCount} 条</span>}
          </div>
          <div className="flex items-center gap-2">
            {selectedCount > 0 && (
              <button onClick={handleBulkDelete} disabled={deletingBulk}
                className="text-[12px] px-3 py-1 rounded bg-bear/15 text-bear hover:bg-bear/25 disabled:opacity-50 cursor-pointer">
                {deletingBulk ? '删除中...' : `删除选中 ${selectedCount}`}
              </button>
            )}
            {!adding && (
              <button onClick={() => setBulkOpen(!bulkOpen)}
                className="text-[12px] px-3 py-1 rounded border border-border text-text-dim hover:text-text cursor-pointer">
                批量导入
              </button>
            )}
            {!adding && (
              <button onClick={() => setAdding(true)}
                className="text-[12px] px-3 py-1 rounded bg-accent/10 text-accent hover:bg-accent/20 cursor-pointer">
                + 添加记录
              </button>
            )}
          </div>
        </div>

        {bulkOpen && (
          <div className="mt-3 border-t border-border pt-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] text-text-muted leading-relaxed">
                每行: <span className="font-mono text-text">日期 类型 价格 数量 [手续费|-] [HH:MM[:SS]] [备注]</span><br />
                示例: <span className="font-mono text-text">2026-07-01 买入 10.20 100 5 09:35 突破买入</span>
              </div>
              <select className="bg-bg border border-border rounded px-2 py-1 text-[11px] text-text-dim"
                value={bulkBroker} onChange={e => setBulkBroker(e.target.value)} title="批量记录默认券商">
                <option value="">默认券商</option>
                {brokers.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
              </select>
            </div>
            <textarea rows={7}
              className="w-full bg-bg border border-border rounded px-3 py-2 text-[12px] text-text font-mono outline-none focus:border-accent resize-y"
              placeholder={'2026-07-01 买入 10.20 100 5 09:35 首笔\n2026-07-03 加仓 9.80 200 - 14:20 补仓\n2026-07-08 卖出 10.50 100 5'}
              value={bulkText} onChange={e => setBulkText(e.target.value)} />
            <div className="flex items-center justify-between gap-2">
              <div className={`text-[11px] whitespace-pre-line ${bulkParsed.errors.length ? 'text-bear' : 'text-text-muted'}`}>
                {bulkParsed.errors.length ? bulkParsed.errors.slice(0, 3).join('\n') : `预解析 ${bulkParsed.rows.length} 条`}
                {bulkMsg && `\n${bulkMsg}`}
              </div>
              <button onClick={handleBulkImport} disabled={bulkBusy || !bulkParsed.rows.length || bulkParsed.errors.length > 0}
                className="px-4 py-1.5 rounded bg-accent text-bg font-medium text-[12px] hover:opacity-90 disabled:opacity-50 cursor-pointer">
                {bulkBusy ? '导入中...' : `确认导入 ${bulkParsed.rows.length} 条`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
