import { useEffect, useState } from 'react'
import { fetchJSON } from '../hooks/useApi'

const FREQ = { daily_trading: '每日交易日', weekly: '每周', monthly: '每月' }
const MODE = { amount: '金额', shares: '份额' }

export default function DCAManager() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState({ text: '', ok: null })

  const load = async () => {
    setLoading(true)
    try {
      const d = await fetchJSON('/api/dca')
      setRows(d.schedules || [])
    } catch (e) {
      setStatus({ text: '加载失败: ' + (e.message || e), ok: false })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const patch = async (id, payload) => {
    try {
      await fetchJSON(`/api/dca/${id}`, { method: 'PUT', body: JSON.stringify(payload) })
      await load()
    } catch (e) { setStatus({ text: '更新失败: ' + (e.message || e), ok: false }) }
  }

  const remove = async (id) => {
    if (!confirm('确定删除这个定投计划？')) return
    try {
      await fetchJSON(`/api/dca/${id}`, { method: 'DELETE' })
      await load()
    } catch (e) { setStatus({ text: '删除失败: ' + (e.message || e), ok: false }) }
  }

  const fireDue = async () => {
    setStatus({ text: '扫描中...', ok: null })
    try {
      const d = await fetchJSON('/api/dca/fire-due', { method: 'POST' })
      setStatus({ text: `已触发 ${d.count || 0} 笔到期定投`, ok: true })
      await load()
    } catch (e) { setStatus({ text: '触发失败: ' + (e.message || e), ok: false }) }
  }

  return (
    <div className="rounded-xl border border-border bg-surface-2 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-[13px] font-semibold text-text-bright">定投计划管理</div>
          <div className="text-[11px] text-text-muted mt-1">查看、暂停/恢复、删除计划；新增计划仍在资产加仓表单中创建。</div>
        </div>
        <button onClick={fireDue}
          className="px-3 py-1.5 rounded-md border border-accent/50 text-accent text-[12px] hover:bg-accent/10 cursor-pointer">
          手动扫描到期
        </button>
      </div>

      {loading ? <div className="text-[12px] text-text-dim py-3">加载中...</div> : rows.length === 0 ? (
        <div className="text-[12px] text-text-dim py-3">暂无定投计划。可在持仓页为基金/加密资产创建定投。</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] border-collapse">
            <thead className="text-[10.5px] text-text-muted border-b border-border-subtle">
              <tr>
                <th className="text-left py-1.5 font-normal">资产</th>
                <th className="text-left py-1.5 font-normal">模式</th>
                <th className="text-right py-1.5 font-normal">数值</th>
                <th className="text-left py-1.5 font-normal">频率</th>
                <th className="text-left py-1.5 font-normal">下次</th>
                <th className="text-left py-1.5 font-normal">状态</th>
                <th className="text-right py-1.5 font-normal">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="py-2 text-text-bright">#{r.asset_id}<span className="text-text-muted ml-1">{r.note || ''}</span></td>
                  <td className="py-2 text-text-dim">{MODE[r.mode] || r.mode}</td>
                  <td className="py-2 text-right font-mono text-text">{r.mode === 'amount' ? '¥' : ''}{r.value}</td>
                  <td className="py-2 text-text-dim">{FREQ[r.frequency] || r.frequency}{r.day_of_month ? ` · ${r.day_of_month}日` : ''}{r.day_of_week ? ` · 周${r.day_of_week}` : ''}</td>
                  <td className="py-2 font-mono text-text-dim">{r.next_due || '--'}</td>
                  <td className="py-2"><span className={r.status === 'active' ? 'text-bull' : 'text-text-muted'}>{r.status === 'active' ? '运行中' : '已暂停'}</span></td>
                  <td className="py-2 text-right space-x-2">
                    <button onClick={() => patch(r.id, { status: r.status === 'active' ? 'paused' : 'active' })}
                      className="text-[11px] text-accent hover:underline cursor-pointer">{r.status === 'active' ? '暂停' : '恢复'}</button>
                    <button onClick={() => remove(r.id)} className="text-[11px] text-bear hover:underline cursor-pointer">删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {status.text && <div className={`text-[12px] ${status.ok === true ? 'text-bull' : status.ok === false ? 'text-bear' : 'text-text-dim'}`}>{status.text}</div>}
    </div>
  )
}
