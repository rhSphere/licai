import { useState, useEffect } from 'react'
import { fetchJSON } from '../hooks/useApi'
import { fmtMoney } from '../helpers'

export default function RiskBanner({ holdings }) {
  const [riskConfig, setRiskConfig] = useState({ max_daily_loss: 500, max_daily_loss_pct: 0.01 })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    fetchJSON('/api/settings/feishu').catch(() => {}) // warm up
    // Load risk config
    fetch('/api/settings/risk').then(r => r.json()).then(d => {
      setRiskConfig({
        max_daily_loss: parseFloat(d.max_daily_loss || 500),
        max_daily_loss_pct: parseFloat(d.max_daily_loss_pct || 0.01),
      })
    }).catch(() => {})
  }, [])

  if (!holdings || holdings.length === 0 || dismissed) return null

  // Suppress risk banner outside A-share trading days (price_change_pct is stale).
  const dow = new Date().getDay()
  if (dow === 0 || dow === 6) return null

  const rows = holdings.map(h => {
    if (!h.current_price || !h.price_change_pct) return null
    const prevPrice = h.current_price / (1 + h.price_change_pct / 100)
    const fx = h.fx_rate || 1
    const pnl = (h.current_price - prevPrice) * h.shares * fx
    const mv = (h.market_value ?? (h.current_price * h.shares * fx)) || 0
    return { name: h.stock_name || h.stock_code, code: h.stock_code, pnl, mv }
  }).filter(Boolean)

  const todayPnl = rows.reduce((s, r) => s + r.pnl, 0)
  const totalMv = rows.reduce((s, r) => s + r.mv, 0)
  const lossPct = totalMv > 0 ? Math.abs(todayPnl) / totalMv : 0
  const lossRows = rows.filter(r => r.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 3)

  const amountThreshold = riskConfig.max_daily_loss || 500
  const pctThreshold = riskConfig.max_daily_loss_pct || 0.01
  const pctThresholdAmount = totalMv * pctThreshold
  const threshold = Math.max(amountThreshold, pctThresholdAmount)
  const isWarning = todayPnl < -threshold

  if (!isWarning) return null

  return (
    <div className="mx-4 mt-3 px-4 py-2 rounded-lg bg-bear/15 border border-bear/30 flex items-center justify-between"
      style={{ animation: 'fade-up 0.3s ease-out' }}>
      <div className="flex items-center gap-2">
        <span className="text-bear text-[14px]">&#9888;</span>
        <span className="text-[13px] text-bear-bright font-medium">
          风控警告：今日浮亏 {fmtMoney(Math.abs(todayPnl))}，超过阈值 {fmtMoney(threshold)}，建议暂停加仓
          <span className="ml-2 text-[11px] text-bear/80 font-normal">
            ({(lossPct * 100).toFixed(2)}% / 阈值{(pctThreshold * 100).toFixed(2)}%)
          </span>
          {lossRows.length > 0 && (
            <span className="block text-[11px] text-bear/80 font-normal mt-0.5">
              主要来源：{lossRows.map(r => `${r.name} ${fmtMoney(r.pnl)}`).join('；')}
            </span>
          )}
        </span>
      </div>
      <button onClick={() => setDismissed(true)}
        className="text-[11px] px-2 py-0.5 rounded border border-bear/30 text-bear hover:bg-bear/20 cursor-pointer shrink-0">
        知道了
      </button>
    </div>
  )
}
