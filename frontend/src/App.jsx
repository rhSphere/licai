import { useState, useEffect, useCallback, useRef } from 'react'
import { useWebSocket } from './hooks/useWebSocket'
import { api } from './hooks/useApi'
import Header from './components/Header'
import Sidebar, { NAV } from './components/Sidebar'
import Dashboard from './components/Dashboard'
import RiskBanner from './components/RiskBanner'
import StaleBundleNotice from './components/StaleBundleNotice'
import UnifiedPortfolio from './components/UnifiedPortfolio'
import Rankings from './components/Rankings'
import StockAsk from './components/StockAsk'
import Settings from './components/Settings'
import EditModal from './components/EditModal'
import TransactionHistory from './components/TransactionHistory'
// 市场·开盘情绪
import MorningBriefing from './components/MorningBriefing'
import SentimentThermometer from './components/SentimentThermometer'
// 市场·板块
import SectorShare from './components/SectorShare'
import SectorMatrix from './components/SectorMatrix'
import SectorOpportunities from './components/SectorOpportunities'
import EtfXray from './components/EtfXray'
// 市场·大盘股池
import MarketPools from './components/MarketPools'
import AnalyzerLists from './components/AnalyzerLists'
// 市场·资金机构 / 宏观 / 资讯
import ProviderInstTheme from './components/ProviderInstTheme'
import MacroDashboard from './components/MacroDashboard'
import PortfolioNews from './components/PortfolioNews'
import AITradeReview from './components/AITradeReview'
// 我的·资金现金流
import Cashflow from './components/Cashflow'
// 我的·绩效基准
import BenchmarkCompare from './components/BenchmarkCompare'
import SectorRadar from './components/SectorRadar'
import PortfolioCurve from './components/PortfolioCurve'
import PortfolioCorrelation from './components/PortfolioCorrelation'
// 我的·配置建议
import AllocationAdvisor from './components/AllocationAdvisor'
import AShareSectorGap from './components/AShareSectorGap'
import BulkTradeImport from './components/BulkTradeImport'

export default function App() {
  const [holdings, setHoldings] = useState([])
  const [marketOpen, setMarketOpen] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [historyTarget, setHistoryTarget] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [view, _setView] = useState(resolveHash)
  const setView = (v) => {
    const next = normalizeView(v)
    _setView(next)
    try { window.location.hash = next } catch {}
  }
  // 前进/后退键。缺了它, hash 变了但 view state 不动 —— 地址栏和页面对不上,
  // 看着像后退键坏了。setView 自己写 hash 也会触发这里, 但算出来是同一个值,
  // React 对相同 state 直接跳过重渲染, 不会来回打转。
  // ⚠️ 只管到"哪一页"。榜单页签那类页内子参数(#rankings?t=inst)由组件在挂载时
  // 各读一次, 单纯改子参数的前进/后退仍然不会切 —— 那要各组件自己听, 不在这里。
  useEffect(() => {
    const onHashChange = () => _setView(resolveHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  // 侧栏(NAV) 与页面映射(PAGES) 必须一一对应。两边都手写, 漂了各有一种静默失败:
  // NAV 多一项 → 点了是空内容区(现在会显示兜底文案); PAGES 多一项 → 一页谁也点不到。
  // 生产构建里 import.meta.env.DEV 是常量 false, 整块被摇掉。
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const pageKeys = Object.keys(PAGES)
    const noPage = VIEWS.filter(k => !pageKeys.includes(k))
    const noNav = pageKeys.filter(k => !VIEWS.includes(k))
    if (noPage.length) console.error(`App: 这些 NAV 项没有对应页面: ${noPage.join(', ')}`)
    if (noNav.length) console.error(`App: 这些页面点不到(不在 NAV 里): ${noNav.join(', ')}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [dataVersion, setDataVersion] = useState(0)
  const quotesRef = useRef({})

  const loadPortfolio = useCallback(async () => {
    try { setHoldings(await api.getPortfolio()) } catch {}
  }, [])
  useEffect(() => { loadPortfolio() }, [loadPortfolio])
  // 港美股的 today_valid(今日涨跌算不算今天)只在 /api/portfolio 里按「港交所交易日 / 美股那场收盘距今」
  // 判, WebSocket 推价不带它(带了就直接用, 见下)。它只在开收盘/跨日这类时段边界翻转, 所以有港美股
  // 持仓时每 10 分钟整体重拉一次就够, 不在前端复刻两地交易日历。
  const hasForeign = holdings.some(h => /^(HK|US)\./i.test(String(h.stock_code || '')))
  useEffect(() => {
    if (!hasForeign) return
    const t = setInterval(loadPortfolio, 10 * 60 * 1000)
    return () => clearInterval(t)
  }, [hasForeign, loadPortfolio])

  const handleWsMessage = useCallback((msg) => {
    if (msg.type === 'price_update') {
      quotesRef.current = msg.data
      setMarketOpen(msg.market_open || false)
      setLastUpdate(new Date())
      setHoldings(prev => prev.map(h => {
        const q = msg.data[h.stock_code]
        if (!q) return h
        const currentPrice = q.price
        const fxRate = q.fx_rate || h.fx_rate || 1
        const originalCostValue = h.cost_price * h.shares
        const originalMarketValue = currentPrice * h.shares
        const pnl = (originalMarketValue - originalCostValue) * fxRate
        const pnlPct = h.cost_price > 0 ? (currentPrice - h.cost_price) / h.cost_price * 100 : 0
        return {
          ...h,
          current_price: currentPrice,
          fx_rate: fxRate,
          fx_time: q.fx_time || h.fx_time || '',
          fx_source: q.fx_source || h.fx_source || '',
          price_change_pct: q.change_pct,
          today_valid: q.today_valid !== undefined ? q.today_valid : h.today_valid,
          unrealized_pnl: Math.round(pnl * 100) / 100,
          pnl_pct: Math.round(pnlPct * 100) / 100,
          original_cost_value: Math.round(originalCostValue * 100) / 100,
          original_market_value: Math.round(originalMarketValue * 100) / 100,
          cost_value: Math.round(originalCostValue * fxRate * 100) / 100,
          market_value: Math.round(originalMarketValue * fxRate * 100) / 100,
        }
      }))
    }
  }, [])
  useWebSocket(handleWsMessage)

  const handleHoldingChange = () => { loadPortfolio(); setDataVersion(v => v + 1) }

  const PAD = 'max-w-[1440px] mx-auto px-2 md:px-4 py-3 md:py-4'

  // view key → 这一页渲染什么。写成映射而不是一串 `{view === 'x' && ...}`:
  // 那种写法下"侧栏有这一项、但没人渲染它"是个静默失败(内容区一片空白, 不报错),
  // 而映射的键集合是可枚举的 —— 见下面 DEV 里对 NAV 的自检。
  const PAGES = {
    portfolio: () => (
      <div className={`${PAD} space-y-3 md:space-y-4`}>
        <UnifiedPortfolio
          holdings={holdings}
          onEdit={setEditTarget}
          onHistory={setHistoryTarget}
          onAdd={handleHoldingChange}
          dataVersion={dataVersion}
        />
      </div>
    ),

    cashflow: () => (
      <div className={`${PAD} space-y-3 md:space-y-4`}>
        <Cashflow />
      </div>
    ),

    performance: () => (
      <div className={`${PAD} space-y-3 md:space-y-4`}>
        <BenchmarkCompare />
        <SectorRadar />
        {/* 这两张卡原先住在 AI 复盘卡内部, 自身没有卡壳 —— 外壳见上面的 CardShell */}
        <CardShell title="盈亏曲线" sub="时间加权 · 对照沪深300">
          <PortfolioCurve />
        </CardShell>

        <CardShell title="同源风险" sub="在持标的两两相关性 · 分散是否名义">
          <PortfolioCorrelation />
        </CardShell>
      </div>
    ),

    allocation: () => (
      <div className={`${PAD} space-y-3 md:space-y-4`}>
        <AllocationAdvisor />
        <AShareSectorGap />
        <EtfXray mode="mine" />
      </div>
    ),

    review: () => (
      <div className={`${PAD} space-y-3 md:space-y-4`}>
        <AITradeReview />
        <EntryReview />
      </div>
    ),

    open: () => (
      <div className={`${PAD} space-y-3 md:space-y-4`}>
        <MorningBriefing />
        <SentimentThermometer />
      </div>
    ),

    sector: () => (
      <div className={`${PAD} space-y-3 md:space-y-4`}>
        <SectorShare />
        <SectorMatrix />
        <SectorOpportunities />
        <EtfXray mode="theme" />
      </div>
    ),

    // 榜单是"占满一屏"的视图: 外壳撑满滚动区, 面板自己吃掉剩余高度。
    // 原来面板写死 h-[calc(100vh-11rem)] —— 那 11rem 是照着某个窗口估的顶栏高度,
    // 窗口一变高、顶栏一换行就对不上, 底下留出一条谁也用不上的空带。
    rankings: () => (
      <div className={`${PAD} h-full flex flex-col`}>
        <Rankings />
      </div>
    ),

    // 大盘·股池: 三列卡 + 连板梯队 + 历史分池回测表, 是"昨日涨停今天怎么样"的复盘面板,
    // 信息形态跟榜单那种左列表+右K线天生冲突 —— 所以单独上页, 满宽铺开。
    // MarketPools 的 onPick 可选, 不传就用它自带的 K 线弹窗。
    pools: () => (
      <div className={`${PAD} space-y-3 md:space-y-4`}>
        <MarketPools />
        <AnalyzerLists />
      </div>
    ),

    capital: () => (
      <div className={`${PAD} space-y-3 md:space-y-4`}>
        <ProviderInstTheme standalone />
      </div>
    ),

    macro: () => (
      <div className={`${PAD} space-y-3 md:space-y-4`}>
        <MacroDashboard />
      </div>
    ),

    news: () => (
      <div className={`${PAD} space-y-3 md:space-y-4`}>
        <PortfolioNews />
      </div>
    ),

    ask: () => (
      <div className={`${PAD} max-w-[900px] h-[calc(100vh-8rem)]`}>
        <StockAsk page />
      </div>
    ),

    settings: () => (
      <div className={`${PAD} max-w-[900px]`}>
        <Settings onClose={() => setView('portfolio')} />
      </div>
    ),
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Header
        marketOpen={marketOpen}
        lastUpdate={lastUpdate}
        onRefresh={loadPortfolio}
        onSettings={() => setView('settings')}
      />

      <div className="flex flex-1 min-h-0">
        <Sidebar active={view} onNav={setView} open={sidebarOpen} onToggle={() => setSidebarOpen(o => !o)} />

        <main className="flex-1 min-w-0 flex flex-col min-h-0">
          {/* 仪表盘概览条 + 风险条: 固定在内容区顶部, 不随内容滚动 */}
          <div className="shrink-0">
            <Dashboard holdings={holdings} />
            <RiskBanner holdings={holdings} />
          </div>

          {/* 视图内容: 唯一滚动区 — 侧边栏/顶栏/仪表盘全部固定 */}
          <div className="flex-1 min-h-0 overflow-y-auto">

          {view === 'portfolio' && (
            <div className={`${PAD} space-y-3 md:space-y-4`}>
              <UnifiedPortfolio
                holdings={holdings}
                onEdit={setEditTarget}
                onHistory={setHistoryTarget}
                onAdd={handleHoldingChange}
                dataVersion={dataVersion}
              />
              <DCAManager />
              <BulkTradeImport onDone={handleHoldingChange} />
            </div>
          )}

          {view === 'unwind' && (
            <div className={`${PAD} space-y-3 md:space-y-4`}>
              <UnwindView />
            </div>
          )}

          {view === 'sector' && (
            <div className={`${PAD} space-y-3 md:space-y-4`}>
              <MorningBriefing />
              <MarketAIInsights />
              <SentimentThermometer />
              <EtfXray />
              <SectorMatrix />
              <HotRank />
              <SectorRadar />
              <SectorOpportunities />
            </div>
          )}

          {view === 'rankings' && (
            <div className={PAD}>
              <Rankings />
            </div>
          )}

          {view === 'macro' && (
            <div className={`${PAD} space-y-3 md:space-y-4`}>
              <MacroDashboard />
            </div>
          )}

          {view === 'news' && (
            <div className={`${PAD} space-y-3 md:space-y-4`}>
              <PortfolioNews />
            </div>
          )}

          {view === 'review' && (
            <div className={`${PAD} space-y-3 md:space-y-4`}>
              <AITradeReview />
              <TradeReview />
              <TradeJournal />
              <ThesisReview />
              <BenchmarkCompare />
              <Cashflow />
              <AllocationAdvisor />
              <AShareSectorGap />
            </div>
          )}

          {view === 'ask' && (
            <div className={`${PAD} max-w-[900px] h-[calc(100vh-8rem)]`}>
              <StockAsk page />
            </div>
          )}

          {view === 'settings' && (
            <div className={`${PAD} max-w-[900px]`}>
              <Settings onClose={() => setView('dashboard')} />
            </div>
          )}
          </div>
        </main>
      </div>

      {editTarget && (
        <EditModal holding={editTarget} onClose={() => setEditTarget(null)} onChange={handleHoldingChange} />
      )}
      {historyTarget && (
        <TransactionHistory
          stockCode={historyTarget.stock_code}
          stockName={historyTarget.stock_name}
          onClose={() => setHistoryTarget(null)}
          onChange={handleHoldingChange}
        />
      )}
      <StaleBundleNotice />
    </div>
  )
}
