import { useMemo, useState } from 'react'
import { fetchJSON } from '../hooks/useApi'

const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/

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

const normalizeCode = (raw) => {
  const s = String(raw || '').trim().toUpperCase()
  if (!s) return ''
  if (/^HK\.?\d{1,5}$/.test(s)) return 'HK.' + s.replace(/^HK\.?/, '').padStart(5, '0')
  if (/^US\.?[A-Z.]+$/.test(s)) return 'US.' + s.replace(/^US\.?/, '')
  if (/^\d{6}$/.test(s)) return s
  return s
}

const splitLine = (line) => {
  const s = line.trim()
  if (!s) return []
  if (s.includes('\t')) return s.split('\t').map(x => x.trim()).filter(Boolean)
  if (s.includes(',')) return s.split(',').map(x => x.trim()).filter(Boolean)
  return s.split(/\s+/).map(x => x.trim()).filter(Boolean)
}

const extractHeader = (line) => {
  const codeMatch = line.match(/[（(]\s*((?:HK\.?|US\.?)?[A-Za-z0-9.]{2,10}|\d{6})\s*[）)]/)
  if (!codeMatch) return null
  const code = normalizeCode(codeMatch[1])
  let name = line.replace(/^[#*\-\s]+/, '').replace(/[`*_]/g, '')
  name = name.split(/[（(]/)[0].replace(/[—-].*$/, '').trim()
  return { code, name }
}

const parseActionLine = (line, lineNo) => {
  const cols = splitLine(line)
  if (cols.length < 4 || !/^\d{4}-\d{2}-\d{2}$/.test(cols[0])) return { skip: true }
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
  const errors = []
  if (!action_type) errors.push(`第 ${lineNo} 行: 类型无法识别 (${typeRaw})`)
  if (!(price >= 0)) errors.push(`第 ${lineNo} 行: 价格无效`)
  if (!(shares > 0)) errors.push(`第 ${lineNo} 行: 数量无效`)
  if (feeRaw !== '' && feeRaw !== '-' && !(fee >= 0)) errors.push(`第 ${lineNo} 行: 手续费无效`)
  if (errors.length) return { errors }
  return {
    action: {
      trade_date, action_type, price, shares,
      ...(fee != null ? { fee } : {}),
      ...(trade_time ? { trade_time } : {}),
      ...(note ? { note } : {}),
    },
  }
}

function parseMultiSymbolText(text) {
  const groups = []
  const errors = []
  let current = null
  const lines = String(text || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('```') || /^[-—]+$/.test(line)) continue
    const header = extractHeader(line)
    if (header) {
      current = { stock_code: header.code, stock_name: header.name, actions: [] }
      groups.push(current)
      continue
    }
    const parsed = parseActionLine(line, i + 1)
    if (parsed.skip) continue
    if (parsed.errors) {
      errors.push(...parsed.errors)
      continue
    }
    if (!current) {
      errors.push(`第 ${i + 1} 行: 找不到所属标的标题, 请先写 **名称（代码）**`)
      continue
    }
    current.actions.push(parsed.action)
  }
  return { groups: groups.filter(g => g.actions.length), errors }
}

export default function BulkTradeImport({ onDone }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState({ text: '', ok: null })
  const parsed = useMemo(() => parseMultiSymbolText(text), [text])
  const total = parsed.groups.reduce((s, g) => s + g.actions.length, 0)

  const submit = async () => {
    if (parsed.errors.length) return setStatus({ text: parsed.errors.slice(0, 5).join('\n'), ok: false })
    if (!total) return setStatus({ text: '没有识别到可导入的流水', ok: false })
    if (!confirm(`确认导入 ${parsed.groups.length} 个标的、${total} 条流水？已存在流水不会自动去重。`)) return
    setBusy(true)
    setStatus({ text: '导入中...', ok: null })
    try {
      const res = await fetchJSON('/api/portfolio/actions/import-groups', {
        method: 'POST',
        body: JSON.stringify({ groups: parsed.groups }),
      })
      setStatus({ text: `导入完成: ${res.groups?.length || parsed.groups.length} 个标的, ${res.inserted || total} 条`, ok: true })
      setText('')
      onDone?.()
    } catch (e) {
      setStatus({ text: '导入失败: ' + (e.message || e), ok: false })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface/60 overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full px-4 py-2.5 text-left text-[13px] text-accent font-semibold bg-surface-2/60 hover:bg-surface-2 cursor-pointer">
        多标的批量导入 {open ? '▴' : '▾'}
        {!open && <span className="ml-2 text-[11px] text-text-muted font-normal">粘贴自然文本 / Markdown 交易记录</span>}
      </button>
      {open && (
        <div className="p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] text-text-muted leading-relaxed">
              标题写 <span className="font-mono text-text">**名称（代码）**</span>, 下方每行 <span className="font-mono text-text">日期 类型 价格 数量 手续费 [时间]</span>。
              已清仓标的也会自动创建历史占位行。
            </div>
          </div>
          <textarea rows={12}
            className="w-full bg-bg border border-border rounded px-3 py-2 text-[12px] text-text font-mono outline-none focus:border-accent resize-y"
            placeholder={'**半导体ETF国联安（512480）**\n```\n2026-01-23 卖出 1.705 1500 0.26\n2026-01-21 买入 1.749 1000 0.17\n```'}
            value={text} onChange={e => setText(e.target.value)} />
          <div className="flex items-center justify-between gap-3">
            <div className={`text-[11px] whitespace-pre-line ${parsed.errors.length ? 'text-bear' : 'text-text-muted'}`}>
              {parsed.errors.length
                ? parsed.errors.slice(0, 5).join('\n')
                : `预解析 ${parsed.groups.length} 个标的 / ${total} 条流水`}
              {status.text && `\n${status.text}`}
            </div>
            <button onClick={submit} disabled={busy || !total || parsed.errors.length > 0}
              className="px-4 py-1.5 rounded bg-accent text-bg text-[12px] font-semibold hover:opacity-90 disabled:opacity-50 cursor-pointer">
              {busy ? '导入中...' : `确认导入 ${total} 条`}
            </button>
          </div>
          {!!parsed.groups.length && (
            <div className="max-h-28 overflow-y-auto text-[10.5px] text-text-muted border-t border-border pt-2">
              {parsed.groups.map(g => <div key={g.stock_code}><span className="font-mono text-text">{g.stock_code}</span> {g.stock_name} · {g.actions.length} 条</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
