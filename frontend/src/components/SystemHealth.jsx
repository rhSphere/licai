import { useEffect, useState } from 'react'
import { fetchJSON } from '../hooks/useApi'

const ORDER = ['db', 'frontend', 'llm', 'proxy', 'tdx', 'feishu', 'okx']
const NAME = {
  db: '数据库', frontend: '前端资源', llm: 'LLM', proxy: '代理',
  tdx: 'TDX', feishu: '飞书', okx: 'OKX',
}

export default function SystemHealth() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = async () => {
    setLoading(true); setErr('')
    try { setData(await fetchJSON('/api/health')) }
    catch (e) { setErr(e.message || '健康状态加载失败') }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  return (
    <div className="rounded-xl border border-border bg-surface-2 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-[13px] font-semibold text-text-bright">系统健康状态</div>
          <div className="text-[11px] text-text-muted mt-1">本地服务、数据库、配置和可选集成状态总览。</div>
        </div>
        <button onClick={load} disabled={loading}
          className="px-3 py-1.5 rounded-md border border-border text-[12px] text-text-dim hover:text-text disabled:opacity-50 cursor-pointer">
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>

      {err && <div className="text-[12px] text-bear">{err}</div>}
      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Metric label="持仓" value={data.counts?.holdings ?? 0} />
            <Metric label="外部资产" value={data.counts?.external_assets ?? 0} />
            <Metric label="定投计划" value={data.counts?.dca_schedules ?? 0} />
            <Metric label="端口" value={data.port || '--'} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {ORDER.map(k => {
              const c = data.checks?.[k]
              if (!c) return null
              return <Check key={k} name={NAME[k] || k} check={c} />
            })}
          </div>

          <div className="text-[10px] text-text-muted border-t border-border-subtle pt-2">
            生成时间 {data.generated_at || '--'} · 实时外部连通性请使用各设置项的“测试连接”。
          </div>
        </>
      )}
    </div>
  )
}

function Metric({ label, value }) {
  return (
    <div className="rounded-lg bg-surface-3 px-3 py-2">
      <div className="text-[10px] text-text-muted mb-0.5">{label}</div>
      <div className="font-mono text-[15px] text-text-bright font-semibold">{value}</div>
    </div>
  )
}

function Check({ name, check }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-3/40 px-3 py-2 flex items-start gap-2">
      <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${check.ok ? 'bg-bull' : 'bg-text-muted'}`}
        style={{ boxShadow: check.ok ? '0 0 6px currentColor' : undefined }} />
      <div className="min-w-0">
        <div className="text-[12px] text-text-bright font-medium">{name} · {check.label}</div>
        {check.detail && <div className="text-[10.5px] text-text-muted font-mono break-all mt-0.5">{check.detail}</div>}
      </div>
    </div>
  )
}
