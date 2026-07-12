import { useCallback, useEffect, useState } from 'react'
import { fetchJSON } from '../hooks/useApi'
import BudgetAllocator from './BudgetAllocator'
import UnwindCard from './UnwindCard'
import SkeletonCard from './Skeleton'

export default function UnwindView() {
  const [plans, setPlans] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [showAllocator, setShowAllocator] = useState(false)

  const loadPlans = useCallback(async () => {
    setErr('')
    try {
      setPlans(await fetchJSON('/api/unwind/plans'))
    } catch (e) {
      setErr(e.message || '加载解套计划失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadPlans() }, [loadPlans])

  const riskyPlans = plans.filter(p => (p.nominal_loss_pct || 0) < 0)
  const displayPlans = riskyPlans.length ? riskyPlans : plans

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-surface px-4 py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3"
        style={{ boxShadow: '0 8px 24px -14px var(--color-bg-deeper)' }}>
        <div>
          <div className="text-[16px] font-semibold text-text-bright">解套工具</div>
          <div className="text-[12px] text-text-dim mt-1 leading-relaxed">
            按 A 股持仓生成真实成本、机会成本、NPV 对比和反弹减仓阶梯；当前只对 A 股持仓启用。
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadPlans}
            className="px-3 py-1.5 rounded-md border border-border text-[12px] text-text-dim hover:text-text transition-colors cursor-pointer">
            刷新
          </button>
          <button onClick={() => setShowAllocator(v => !v)}
            className="px-3 py-1.5 rounded-md bg-accent text-bg text-[12px] font-medium hover:opacity-90 cursor-pointer">
            {showAllocator ? '收起预算' : '预算分配'}
          </button>
        </div>
      </div>

      {showAllocator && <BudgetAllocator onAllocated={loadPlans} />}

      {loading && <SkeletonCard rows={6} label="解套计划计算中" />}

      {!loading && err && (
        <div className="rounded-xl border border-bear/40 bg-bear/10 px-4 py-3 text-[13px] text-bear">
          {err}
        </div>
      )}

      {!loading && !err && !plans.length && (
        <div className="rounded-xl border border-border bg-surface px-4 py-8 text-center">
          <div className="text-[14px] text-text-bright font-medium">暂无可分析的 A 股持仓</div>
          <div className="text-[12px] text-text-muted mt-1">先在“持仓”页录入 A 股持仓后，再回到这里生成解套计划。</div>
        </div>
      )}

      {!loading && !err && plans.length > 0 && displayPlans.length === 0 && (
        <div className="rounded-xl border border-border bg-surface px-4 py-8 text-center">
          <div className="text-[14px] text-text-bright font-medium">当前没有亏损持仓</div>
          <div className="text-[12px] text-text-muted mt-1">所有 A 股持仓当前都未处于名义亏损状态。</div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {displayPlans.map(plan => (
          <UnwindCard key={plan.stock_code} plan={plan} onChange={loadPlans} />
        ))}
      </div>
    </div>
  )
}
