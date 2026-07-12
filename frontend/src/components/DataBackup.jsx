import { useRef, useState } from 'react'

export default function DataBackup() {
  const fileRef = useRef(null)
  const [mode, setMode] = useState('replace')
  const [busy, setBusy] = useState('')
  const [status, setStatus] = useState({ text: '', ok: null })

  const exportData = () => {
    setStatus({ text: '正在导出...', ok: null })
    window.location.href = '/api/data/export'
    setTimeout(() => setStatus({ text: '已触发下载', ok: true }), 500)
  }

  const importData = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) return setStatus({ text: '请先选择 JSON 备份文件', ok: false })
    if (!confirm(`${mode === 'replace' ? '替换' : '合并'}导入会先自动备份当前数据库，确定继续？`)) return
    setBusy('import')
    setStatus({ text: '导入中...', ok: null })
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`/api/data/import?mode=${mode}`, { method: 'POST', body: form })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      const total = Object.values(data.imported || {}).reduce((s, n) => s + (n || 0), 0)
      setStatus({ text: `导入完成 · ${total} 行 · 备份 ${data.pre_import_backup}`, ok: true })
      if (fileRef.current) fileRef.current.value = ''
    } catch (e) {
      setStatus({ text: '导入失败: ' + (e.message || e), ok: false })
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface-2 p-4 space-y-3">
      <div>
        <div className="text-[13px] font-semibold text-text-bright">数据导入 / 导出</div>
        <div className="text-[11px] text-text-muted mt-1 leading-relaxed">
          导出当前本地 SQLite 用户数据为 JSON；导入前会自动备份当前数据库到 backups/。
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={exportData}
          className="px-3 py-1.5 rounded-md bg-accent text-bg text-[12px] font-medium hover:opacity-90 cursor-pointer">
          导出 JSON 备份
        </button>
        <select value={mode} onChange={e => setMode(e.target.value)}
          className="bg-bg border border-border rounded px-2 py-1.5 text-[12px] text-text outline-none">
          <option value="replace">替换导入</option>
          <option value="merge">合并导入</option>
        </select>
        <input ref={fileRef} type="file" accept="application/json,.json"
          className="text-[12px] text-text-dim file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-surface-3 file:text-text" />
        <button onClick={importData} disabled={busy === 'import'}
          className="px-3 py-1.5 rounded-md border border-border text-[12px] text-text-dim hover:text-text disabled:opacity-50 cursor-pointer">
          {busy === 'import' ? '导入中...' : '导入'}
        </button>
      </div>

      {status.text && (
        <div className={`text-[12px] ${status.ok === true ? 'text-bull' : status.ok === false ? 'text-bear' : 'text-text-dim'}`}>
          {status.text}
        </div>
      )}
    </div>
  )
}

