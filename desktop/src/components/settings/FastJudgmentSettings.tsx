import { useEffect, useId, useState } from 'react'
import { fastJudgmentApi, type FastJudgmentStatus } from '../../api/fastJudgment'
import { useTranslation } from '../../i18n'
import { openExternalUrl } from '../../lib/openExternalUrl'
import { SettingsSection, Switch } from './SettingsLayout'

export function FastJudgmentSettings({ pruningEnabled }: { pruningEnabled: boolean }) {
  const t = useTranslation()
  const apiKeyId = useId()
  const [status, setStatus] = useState<FastJudgmentStatus | null>(null)
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:8008/v1/systemone')
  const [model, setModel] = useState('Qwen/Qwen3.5-4B')
  const [timeoutMs, setTimeoutMs] = useState(800)
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fastJudgmentApi.status().then(value => {
      if (!active) return
      setStatus(value)
      setEndpoint(value.endpoint)
      setModel(value.model)
      setTimeoutMs(value.timeoutMs)
    }).catch(() => { if (active) setError(t('fastJudgment.failed')) })
    return () => { active = false }
  }, [t])

  const switchProvider = async (provider: FastJudgmentStatus['provider']) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const value = await fastJudgmentApi.save({ provider })
      setStatus(value)
      setEndpoint(value.endpoint)
      setModel(value.model)
      setTimeoutMs(value.timeoutMs)
      setApiKey('')
      setClearKey(false)
    } catch { setError(t('fastJudgment.failed')) } finally { setBusy(false) }
  }

  const dirty = Boolean(status && (endpoint !== status.endpoint || model !== status.model || timeoutMs !== status.timeoutMs || apiKey || clearKey))
  const save = async () => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const value = await fastJudgmentApi.save({
        endpoint, model, timeoutMs,
        ...(apiKey || clearKey ? { apiKey: clearKey ? '' : apiKey } : {}),
      })
      setStatus(value)
      setEndpoint(value.endpoint)
      setModel(value.model)
      setApiKey('')
      setClearKey(false)
      setMessage(t('fastJudgment.saved'))
    } catch { setError(t('fastJudgment.failed')) } finally { setBusy(false) }
  }

  const toggle = async (enabled: boolean, browser = false) => {
    setBusy(true)
    setError('')
    setMessage('')
    try { setStatus(await fastJudgmentApi.save(browser ? { browserEnabled: enabled } : { enabled })) }
    catch { setError(t('fastJudgment.failed')) } finally { setBusy(false) }
  }

  const test = async () => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const value = await fastJudgmentApi.test()
      setStatus(value)
      if (value.ok) setMessage(t('fastJudgment.connected', { ms: value.stats.lastLatencyMs ?? 0 }))
      else setError(t('fastJudgment.testFailed'))
    } catch { setError(t('fastJudgment.testFailed')) } finally { setBusy(false) }
  }

  const inputClass = 'mt-1 w-full rounded-[6px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 py-2 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-border-focus)]'
  const buttonClass = 'rounded-[6px] border border-[var(--color-border)] px-3 py-2 text-[12px] font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40'
  return (
    <SettingsSection
      title={t('fastJudgment.title')}
      description={t('fastJudgment.description')}
      action={<Switch checked={status?.enabled ?? false} disabled={!status || busy || (!status.enabled && (dirty || (!status.hasApiKey && status.provider === 'jev' && new URL(status.endpoint).hostname === 'api.typesafe.ai')))} onChange={enabled => void toggle(enabled)} ariaLabel={t('fastJudgment.toggle')} />}
    >
      <div className="space-y-4 px-5 py-4">
        <label className="block text-[12px] text-[var(--color-text-secondary)]">
          {t('fastJudgment.provider')}
          <select className={inputClass} value={status?.provider ?? 'reflex'} disabled={!status || busy || dirty} onChange={event => void switchProvider(event.target.value as FastJudgmentStatus['provider'])}>
            <option value="reflex">{t('fastJudgment.reflex')}</option>
            <option value="jev">{t('fastJudgment.jev')}</option>
          </select>
        </label>
        {dirty && <p className="text-[12px] text-[var(--color-text-tertiary)]">{t('fastJudgment.saveBeforeSwitch')}</p>}
        {status?.provider === 'reflex' && <div className="rounded-[6px] border border-[var(--color-border)] p-3 text-[12px] leading-5 text-[var(--color-text-secondary)]">
          <p>{t('fastJudgment.localHelp')}</p>
          <code className="mt-2 block break-all select-text text-[11px]">uv run reflex-serve --stable --port 8008</code>
          <a className="mt-2 inline-block underline" href="https://github.com/kshetrajna12/reflex#run-it-as-a-server" target="_blank" rel="noreferrer">{t('fastJudgment.localGuide')}</a>
        </div>}
        <p className="text-[12px] leading-5 text-[var(--color-text-secondary)]">{t('fastJudgment.dataNotice')}</p>
        {!pruningEnabled && <p className="text-[12px] text-[var(--color-text-tertiary)]">{t('fastJudgment.needsPruning')}</p>}
        <div className="flex items-start justify-between gap-4 rounded-[6px] border border-[var(--color-border)] p-3">
          <div className="text-[12px] leading-5">
            <p className="font-medium text-[var(--color-text-primary)]">{t('fastJudgment.browserTitle')}</p>
            <p className="text-[var(--color-text-secondary)]">{t('fastJudgment.browserHelp')}</p>
          </div>
          <Switch checked={status?.browserEnabled ?? false} disabled={!status || busy || (!status.browserEnabled && (!status.enabled || dirty))} onChange={enabled => void toggle(enabled, true)} ariaLabel={t('fastJudgment.browserToggle')} />
        </div>
        <fieldset disabled={!status || busy} className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="text-[12px] text-[var(--color-text-secondary)] sm:col-span-2">
            {t('fastJudgment.endpoint')}
            <input className={inputClass} value={endpoint} onChange={event => setEndpoint(event.target.value)} spellCheck={false} />
          </label>
          <label className="text-[12px] text-[var(--color-text-secondary)]">
            {t('fastJudgment.model')}
            <input className={inputClass} value={model} onChange={event => setModel(event.target.value)} spellCheck={false} />
          </label>
          <label className="text-[12px] text-[var(--color-text-secondary)]">
            {t('fastJudgment.timeout')}
            <input className={inputClass} type="number" min={100} max={3000} step={100} value={timeoutMs} onChange={event => setTimeoutMs(Number(event.target.value))} />
          </label>
          <div className="text-[12px] text-[var(--color-text-secondary)] sm:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor={apiKeyId}>API Key</label>
              {status?.provider === 'jev' && <a
                className="underline underline-offset-2 hover:text-[var(--color-text-primary)]"
                href="https://console.typesafe.ai/keys"
                target="_blank"
                rel="noopener noreferrer"
                onClick={event => {
                  event.preventDefault()
                  setError('')
                  void openExternalUrl(event.currentTarget.href).catch(() => setError(t('fastJudgment.openKeyFailed')))
                }}
              >{t('fastJudgment.getKey')}</a>}
            </div>
            <input id={apiKeyId} className={inputClass} type="password" autoComplete="new-password" value={apiKey} disabled={clearKey} placeholder={status?.hasApiKey ? t('fastJudgment.keySaved') : t(status?.provider === 'reflex' ? 'fastJudgment.localKeyPlaceholder' : 'fastJudgment.keyPlaceholder')} onChange={event => setApiKey(event.target.value)} />
          </div>
          {status?.hasApiKey && <label className="flex items-center gap-2 text-[12px] text-[var(--color-text-secondary)]"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} />{t('fastJudgment.clearKey')}</label>}
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={buttonClass} disabled={!status || busy || !dirty} onClick={() => void save()}>{t('common.save')}</button>
          <button type="button" className={buttonClass} disabled={!status || busy || dirty} onClick={() => void test()}>{t('fastJudgment.test')}</button>
          <button type="button" className={buttonClass} disabled={!status || busy} onClick={() => {
            void fastJudgmentApi.status().then(setStatus).catch(() => setError(t('fastJudgment.failed')))
          }}>{t('fastJudgment.refresh')}</button>
        </div>
        {status && <p className="text-[11px] text-[var(--color-text-tertiary)]">{t('fastJudgment.stats', { requests: status.stats.requests, hits: status.stats.cacheHits, fallbacks: status.stats.fallbacks, ms: status.stats.lastLatencyMs ?? '—' })}</p>}
        {status?.stats.lastError && <p className="text-[11px] text-[var(--color-text-tertiary)]">{t('fastJudgment.fallbackReason')}: {status.stats.lastError}</p>}
        {message && <p role="status" className="text-[12px] text-[var(--color-text-secondary)]">{message}</p>}
        {error && <p role="alert" className="text-[12px] text-red-500">{error}</p>}
      </div>
    </SettingsSection>
  )
}
