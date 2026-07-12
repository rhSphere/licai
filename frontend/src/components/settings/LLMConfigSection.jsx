import { useEffect, useState } from 'react'
import { api, fetchJSON } from '../../hooks/useApi'

export function LLMConfigSection() {
  const PRESETS = {
    anthropic: {
      label: 'Anthropic / Claude', provider: 'anthropic', baseUrl: 'https://api.anthropic.com',
      header: 'x-api-key', prefix: '', modelMap: { smart: 'claude-opus-4-8', balanced: 'claude-sonnet-5', fast: 'claude-sonnet-5' },
      extraBody: {},
      hint: 'Anthropic 官方 Messages API；不填 API Key 时可走 Claude Code OAuth。',
    },
    kimi: {
      label: 'Kimi / Moonshot', provider: 'openai_compatible', baseUrl: 'https://api.moonshot.cn/v1',
      header: 'Authorization', prefix: 'Bearer', modelMap: { smart: 'kimi-k2.6', balanced: 'kimi-k2.6', fast: 'kimi-k2.6' },
      extraBody: {},
      hint: 'Moonshot OpenAI-compatible: https://api.moonshot.cn/v1 + Authorization: Bearer。',
    },
    qwen: {
      label: '通义千问 / DashScope', provider: 'openai_compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      header: 'Authorization', prefix: 'Bearer', modelMap: { smart: 'qwen3.7-plus', balanced: 'qwen3.7-plus', fast: 'qwen3.7-plus' },
      extraBody: { enable_thinking: true },
      hint: '阿里百炼 DashScope OpenAI-compatible；如使用国际站/业务空间域名，可手动改 Base URL。',
    },
    minimax: {
      label: 'MiniMax', provider: 'openai_compatible', baseUrl: 'https://api.minimaxi.com/v1',
      header: 'Authorization', prefix: 'Bearer', modelMap: { smart: 'MiniMax-M3', balanced: 'MiniMax-M3', fast: 'MiniMax-M3' },
      extraBody: { thinking: { type: 'adaptive' } },
      hint: 'MiniMax OpenAI-compatible: https://api.minimaxi.com/v1 + Authorization: Bearer；按官方示例使用 thinking.type=adaptive。',
    },
    custom: {
      label: '自定义 OpenAI-compatible', provider: 'openai_compatible', baseUrl: '',
      header: 'Authorization', prefix: 'Bearer', modelMap: {},
      extraBody: {},
      hint: '任意 OpenAI-compatible 服务；Base URL 通常以 /v1 或 /compatible-mode/v1 结尾。',
    },
  }
  const guessPreset = (d) => {
    const p = d.db_provider || 'anthropic'
    const u = d.db_base_url || ''
    if (p === 'anthropic') return 'anthropic'
    if (u.includes('moonshot.cn')) return 'kimi'
    if (u.includes('dashscope') || u.includes('aliyuncs.com') || u.includes('maas.aliyuncs.com')) return 'qwen'
    if (u.includes('minimax.io') || u.includes('minimaxi.com')) return 'minimax'
    return 'custom'
  }
  const [provider, setProvider] = useState('anthropic')
  const [preset, setPreset] = useState('anthropic')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiKeyHeader, setApiKeyHeader] = useState('x-api-key')
  const [apiKeyPrefix, setApiKeyPrefix] = useState('')
  const [proxy, setProxy] = useState('')
  const [modelMap, setModelMap] = useState('')
  const [extraBody, setExtraBody] = useState('')
  const [status, setStatus] = useState({ text: '', ok: null })
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [dbHasKey, setDbHasKey] = useState(false)

  useEffect(() => {
    api.getLLMConfig().then(d => {
      setPreset(guessPreset(d))
      setProvider(d.db_provider || 'anthropic')
      setBaseUrl(d.db_base_url || '')
      setDbHasKey(d.has_api_key)
      setApiKeyHeader(d.db_api_key_header || 'x-api-key')
      setApiKeyPrefix(d.db_api_key_prefix || '')
      setProxy(d.db_proxy || '')
      setModelMap(d.db_model_map && Object.keys(d.db_model_map).length ? JSON.stringify(d.db_model_map, null, 2) : '')
      setExtraBody(d.db_extra_body && Object.keys(d.db_extra_body).length ? JSON.stringify(d.db_extra_body, null, 2) : '')
    }).catch(() => {})
  }, [])

  const applyPreset = (key) => {
    const p = PRESETS[key] || PRESETS.custom
    setPreset(key)
    setProvider(p.provider)
    setBaseUrl(p.baseUrl)
    setApiKeyHeader(p.header)
    setApiKeyPrefix(p.prefix)
    setModelMap(Object.keys(p.modelMap).length ? JSON.stringify(p.modelMap, null, 2) : '')
    setExtraBody(Object.keys(p.extraBody || {}).length ? JSON.stringify(p.extraBody, null, 2) : '')
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      let modelMapObj = {}
      let extraBodyObj = {}
      if (modelMap.trim()) {
        try { modelMapObj = JSON.parse(modelMap) } catch {
          setStatus({ text: '模型映射 JSON 格式错误', ok: false })
          setSaving(false)
          return
        }
      }
      if (extraBody.trim()) {
        try { extraBodyObj = JSON.parse(extraBody) } catch {
          setStatus({ text: '扩展请求参数 JSON 格式错误', ok: false })
          setSaving(false)
          return
        }
      }
      await api.saveLLMConfig({
        provider,
        base_url: baseUrl.trim(),
        api_key: apiKey.trim() || (dbHasKey ? '****' : ''),
        api_key_header: apiKeyHeader.trim() || 'x-api-key',
        api_key_prefix: apiKeyPrefix.trim(),
        proxy: proxy.trim(),
        model_map: modelMapObj,
        extra_body: extraBodyObj,
        update_api_key: apiKey.trim().length > 0,
      })
      setStatus({ text: '已保存', ok: true })
      if (apiKey.trim()) setDbHasKey(true)
      setApiKey('')
    } catch (e) {
      setStatus({ text: '保存失败: ' + (e.message || e), ok: false })
    }
    setSaving(false)
  }

  const handleTest = async () => {
    setTesting(true)
    setStatus({ text: '测试中...', ok: null })
    try {
      const r = await api.testLLM()
      if (r.ok) {
        setStatus({ text: `连接成功 · ${r.model} · ${r.latency_ms}ms`, ok: true })
      } else {
        setStatus({ text: `失败: ${r.error}`, ok: false })
      }
    } catch (e) {
      setStatus({ text: '测试失败: ' + (e.message || e), ok: false })
    }
    setTesting(false)
  }

  const clearApiKey = async () => {
    if (!confirm('确定清除已保存的 LLM API Key？清除后 Anthropic 可回退到 Claude OAuth/Keychain。')) return
    setStatus({ text: '清除中...', ok: null })
    try {
      const r = await fetchJSON('/api/settings/llm/api-key', { method: 'DELETE' })
      setDbHasKey(false)
      setApiKey('')
      setStatus({ text: r.message || 'API Key 已清除', ok: true })
    } catch (e) {
      setStatus({ text: '清除失败: ' + (e.message || e), ok: false })
    }
  }

  return (
    <>
      <label className="text-[12px] text-text-dim font-semibold">LLM 配置</label>
      <p className="text-[11px] text-text-muted mb-2 leading-relaxed">
        支持 Anthropic Messages 协议，以及 Kimi/Moonshot 等 OpenAI-compatible 接口。
        不配置则走原有 Anthropic 官方 + Keychain OAuth。
      </p>

      <div className="grid grid-cols-1 gap-2 mb-2">
        <div>
          <label className="text-[11px] text-text-muted">厂商预设</label>
          <select
            className="w-full bg-bg border border-border rounded px-3 py-1.5 text-[12px] text-text outline-none focus:border-accent"
            value={preset}
            onChange={e => applyPreset(e.target.value)}
          >
            {Object.entries(PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <p className="text-[10px] text-text-muted mt-0.5">{(PRESETS[preset] || PRESETS.custom).hint}</p>
        </div>

        <div>
          <label className="text-[11px] text-text-muted">Provider 协议</label>
          <select
            className="w-full bg-bg border border-border rounded px-3 py-1.5 text-[12px] text-text outline-none focus:border-accent"
            value={provider}
            onChange={e => {
              const v = e.target.value
              setProvider(v)
              if (v === 'openai_compatible') {
                setBaseUrl(prev => prev || 'https://api.moonshot.cn/v1')
                setApiKeyHeader('Authorization')
                setApiKeyPrefix('Bearer')
                setModelMap(prev => prev || JSON.stringify({ smart: 'kimi-k2.6', balanced: 'kimi-k2.6', fast: 'kimi-k2.6' }, null, 2))
              } else {
                setBaseUrl(prev => prev || 'https://api.anthropic.com')
                setApiKeyHeader('x-api-key')
                setApiKeyPrefix('')
              }
            }}
          >
            <option value="anthropic">Anthropic / Claude</option>
            <option value="openai_compatible">OpenAI-compatible</option>
          </select>
          <p className="text-[10px] text-text-muted mt-0.5">
            预设只负责自动填默认值；下面 Base URL / 模型映射 / Header 都可以继续手动改。
          </p>
        </div>

        <div>
          <label className="text-[11px] text-text-muted">API Base URL</label>
          <input
            className="w-full bg-bg border border-border rounded px-3 py-1.5 text-[12px] text-text font-mono outline-none focus:border-accent"
            placeholder={provider === 'openai_compatible' ? 'https://dashscope.aliyuncs.com/compatible-mode/v1' : 'https://api.anthropic.com'}
            value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[11px] text-text-muted">API Key Header</label>
            <input
              className="w-full bg-bg border border-border rounded px-3 py-1.5 text-[12px] text-text font-mono outline-none focus:border-accent"
              placeholder="x-api-key"
              value={apiKeyHeader} onChange={e => setApiKeyHeader(e.target.value)}
            />
          </div>
          <div>
            <label className="text-[11px] text-text-muted">API Key Prefix（如 Bearer）</label>
            <input
              className="w-full bg-bg border border-border rounded px-3 py-1.5 text-[12px] text-text font-mono outline-none focus:border-accent"
              placeholder="留空或填 Bearer"
              value={apiKeyPrefix} onChange={e => setApiKeyPrefix(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="text-[11px] text-text-muted">API Key {dbHasKey && <span className="text-bull">（已保存，留空则不动）</span>}</label>
          <input type="password"
            className="w-full bg-bg border border-border rounded px-3 py-1.5 text-[12px] text-text font-mono outline-none focus:border-accent"
            placeholder={dbHasKey ? '输入新 key 覆盖，留空保持原 key' : 'sk-...'}
            value={apiKey} onChange={e => setApiKey(e.target.value)}
          />
          {dbHasKey && (
            <button onClick={clearApiKey}
              className="mt-1 text-[11px] px-2 py-0.5 rounded border border-bear/40 text-bear hover:bg-bear/10 cursor-pointer">
              清除已保存 API Key
            </button>
          )}
        </div>

        <div>
          <label className="text-[11px] text-text-muted">HTTP 代理（可选）</label>
          <input
            className="w-full bg-bg border border-border rounded px-3 py-1.5 text-[12px] text-text font-mono outline-none focus:border-accent"
            placeholder="http://127.0.0.1:7890"
            value={proxy} onChange={e => setProxy(e.target.value)}
          />
        </div>

        <div>
          <label className="text-[11px] text-text-muted">模型别名映射（JSON，可选）</label>
          <textarea rows={3}
            className="w-full bg-bg border border-border rounded px-3 py-1.5 text-[12px] text-text font-mono outline-none focus:border-accent resize-none"
            placeholder={provider === 'openai_compatible' ? '{"smart":"qwen-max","balanced":"qwen-plus","fast":"qwen-turbo"}' : '{"smart":"claude-opus-4-8","balanced":"claude-sonnet-5","fast":"claude-sonnet-5"}'}
            value={modelMap} onChange={e => setModelMap(e.target.value)}
          />
          <p className="text-[10px] text-text-muted mt-0.5">逻辑名: smart / balanced / fast → 实际模型名</p>
        </div>

        <div>
          <label className="text-[11px] text-text-muted">OpenAI-compatible 扩展请求参数（JSON，可选）</label>
          <textarea rows={2}
            className="w-full bg-bg border border-border rounded px-3 py-1.5 text-[12px] text-text font-mono outline-none focus:border-accent resize-none"
            placeholder='{"enable_thinking": true}'
            value={extraBody} onChange={e => setExtraBody(e.target.value)}
          />
          <p className="text-[10px] text-text-muted mt-0.5">千问深度思考示例: {`{"enable_thinking": true}`}；自定义服务不需要可留空。</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={saving}
          className="px-4 py-1.5 rounded-md bg-accent text-bg font-medium text-[13px] hover:opacity-90 disabled:opacity-50 cursor-pointer">
          {saving ? '保存中...' : '保存'}
        </button>
        <button onClick={handleTest} disabled={testing}
          className="px-4 py-1.5 rounded-md border border-border text-text-dim text-[13px] hover:text-text transition-colors cursor-pointer">
          {testing ? '测试中...' : '测试连接'}
        </button>
        {status.text && (
          <span className={`text-[12px] font-medium break-all
            ${status.ok === true ? 'text-bull' : status.ok === false ? 'text-bear' : 'text-text-dim'}`}>
            {status.text}
          </span>
        )}
      </div>
    </>
  )
}
