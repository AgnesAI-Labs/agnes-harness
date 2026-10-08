import {
  appServerErrorMessage,
  Button,
  configIssues,
  Field,
  SchemaControl,
  SettingsCard,
  SettingsInput,
  SettingsState,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { searchConfigSchema } from './config-schemas.js'

const PROVIDER_IDS = ['brave', 'tavily', 'exa', 'perplexity', 'searxng'] as const
type ProviderId = (typeof PROVIDER_IDS)[number]
type SearchRow = {
  id: ProviderId
  label: string
  needsKey: boolean
  enabled: boolean
  endpoint: string
  maxResults: number
  timeoutMs: number
  ratePerMinute: number
  secretRef: string
  secretConfigured: boolean
  isDefault: boolean
  ready: boolean
}
type SearchStatus = {
  version: 1
  configured: boolean
  invalid: boolean
  defaultProvider: ProviderId | null
  providers: SearchRow[]
}
type SearchHit = { title: string; url: string; snippet: string }

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDER_IDS.some((id) => id === value)
}
function isRow(value: unknown): value is SearchRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    isProviderId(row.id) &&
    typeof row.label === 'string' &&
    typeof row.needsKey === 'boolean' &&
    typeof row.enabled === 'boolean' &&
    typeof row.endpoint === 'string' &&
    typeof row.maxResults === 'number' &&
    typeof row.timeoutMs === 'number' &&
    typeof row.ratePerMinute === 'number' &&
    typeof row.secretRef === 'string' &&
    typeof row.secretConfigured === 'boolean' &&
    typeof row.isDefault === 'boolean' &&
    typeof row.ready === 'boolean'
  )
}
function isStatus(value: unknown): value is SearchStatus {
  if (typeof value !== 'object' || value === null) return false
  const status = value as Record<string, unknown>
  return (
    status.version === 1 &&
    typeof status.configured === 'boolean' &&
    typeof status.invalid === 'boolean' &&
    (status.defaultProvider === null || isProviderId(status.defaultProvider)) &&
    Array.isArray(status.providers) &&
    status.providers.every(isRow)
  )
}
function integer(value: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return parsed >= min && parsed <= max ? parsed : undefined
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined
    throw Object.assign(new Error('search unavailable'), { envelope: body?.error })
  }
  return response.json() as Promise<unknown>
}

export function SearchPanel({
  t,
  canSave,
  fetcher = fetch,
}: {
  t(key: string): string
  canSave: boolean
  fetcher?: typeof fetch
}) {
  const [status, setStatus] = useState<SearchStatus>()
  const [providerId, setProviderId] = useState<ProviderId>('brave')
  const [endpoint, setEndpoint] = useState('')
  const [maxResults, setMaxResults] = useState('5')
  const [timeoutMs, setTimeoutMs] = useState('15000')
  const [rate, setRate] = useState('30')
  const [enabled, setEnabled] = useState(false)
  const [makeDefault, setMakeDefault] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [errorEnvelope, setErrorEnvelope] = useState<unknown>()
  const [hits, setHits] = useState<SearchHit[]>([])
  const selected = status?.providers.find((row) => row.id === providerId)

  useEffect(() => {
    let current = true
    setFailed(false)
    setBusy(true)
    void fetcher('/admin/api/search', { credentials: 'same-origin', cache: 'no-store' })
      .then(readJson)
      .then((value) => {
        if (!current) return
        if (!isStatus(value)) {
          setFailed(true)
          return
        }
        setStatus(value)
        setFailed(false)
      })
      .catch(() => {
        if (current) setFailed(true)
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
    }
  }, [fetcher])

  useEffect(() => {
    if (!selected) return
    setEndpoint(selected.endpoint)
    setMaxResults(String(selected.maxResults))
    setTimeoutMs(String(selected.timeoutMs))
    setRate(String(selected.ratePerMinute))
    setEnabled(selected.enabled)
    setMakeDefault(selected.isDefault)
    setApiKey('')
    setClearKey(false)
  }, [selected])

  async function save(event: { preventDefault(): void }) {
    event.preventDefault()
    if (!status || !canSave || busy) return
    const results = integer(maxResults, 1, 10)
    const timeout = integer(timeoutMs, 1000, 60_000)
    const ratePerMinute = integer(rate, 1, 600)
    if (
      configIssues(searchConfigSchema, {
        id: providerId,
        endpoint,
        maxResults: results,
        timeoutMs: timeout,
        ratePerMinute,
        enabled,
        makeDefault,
      }).length
    ) {
      setError('searchFailed')
      return
    }
    const savedDefault = status.providers.find((row) => row.isDefault)?.id ?? null
    const defaultProvider = makeDefault ? providerId : savedDefault === providerId ? null : savedDefault
    setBusy(true)
    setError('')
    setErrorEnvelope(undefined)
    setNotice('')
    try {
      const value = await readJson(
        await fetcher('/admin/api/search', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            defaultProvider,
            provider: {
              id: providerId,
              enabled,
              endpoint,
              maxResults: results,
              timeoutMs: timeout,
              ratePerMinute,
            },
            ...(apiKey ? { apiKey } : clearKey ? { apiKey: '' } : {}),
          }),
        }),
      )
      if (!isStatus(value)) throw new Error('invalid')
      setStatus(value)
      setApiKey('')
      setClearKey(false)
      setNotice('searchSaved')
    } catch (error) {
      setErrorEnvelope((error as { envelope?: unknown })?.envelope)
      setError('searchFailed')
    } finally {
      setBusy(false)
    }
  }

  async function testProvider() {
    if (!canSave || busy) return
    const probe = query.trim()
    if (!probe) {
      setError('searchTestEmpty')
      return
    }
    setBusy(true)
    setError('')
    setErrorEnvelope(undefined)
    setHits([])
    try {
      const response = await fetcher('/admin/api/search/test', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: providerId, query: probe }),
      })
      const value = (await response.json()) as {
        ok?: boolean
        error?: unknown
        message?: string
        results?: SearchHit[]
      }
      if (!response.ok || !value.ok) {
        setErrorEnvelope(value.error)
        setError('searchFailed')
        return
      }
      setHits(Array.isArray(value.results) ? value.results : [])
      setNotice('searchSaved')
    } catch (error) {
      setErrorEnvelope((error as { envelope?: unknown })?.envelope)
      setError('searchFailed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard data-testid="search-providers" aria-busy={busy}>
      <p>{t('searchHelp')}</p>
      {busy && (
        <SettingsState tone="loading" data-testid="search-loading">
          {t('loading')}
        </SettingsState>
      )}
      {failed && (
        <SettingsState tone="error" data-testid="search-error">
          {t('searchUnavailable')}
        </SettingsState>
      )}
      {status && !status.configured && (
        <SettingsState data-testid="search-empty">{t('searchEmpty')}</SettingsState>
      )}
      {status?.invalid && <SettingsState tone="error">{t('searchInvalid')}</SettingsState>}
      {status?.configured && <SettingsState tone="success">{t('searchConfigured')}</SettingsState>}
      {!canSave && <p>{t('searchReadOnly')}</p>}
      {status && (
        <ul>
          {status.providers.map((row) => (
            <li key={row.id} data-testid={`search-provider-${row.id}`}>
              {row.label} · {row.ready ? t('searchReady') : t('searchNotReady')}
              {row.isDefault ? ` · ${t('searchDefault')}` : ''}
              <span data-testid={`search-secret-${row.id}`}> {row.secretRef}</span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(event) => void save(event)}>
        <fieldset disabled={!canSave || busy || !status}>
          <Field label={t('searchProvider')} htmlFor="search-edit-provider">
            <SchemaControl
              schema={searchConfigSchema.properties.id}
              value={providerId}
              t={(key) => status?.providers.find((row) => row.id === key)?.label ?? key}
              onChange={(value) => {
                if (isProviderId(value)) setProviderId(value)
              }}
            />
          </Field>
          <Field label={t('searchEndpoint')} htmlFor="search-endpoint" hint={t('searchEndpointHint')}>
            <SchemaControl
              schema={searchConfigSchema.properties.endpoint}
              value={endpoint}
              t={t}
              onChange={(value) => setEndpoint(String(value))}
            />
          </Field>
          <Field label={t('searchApiKey')} htmlFor="search-api-key" hint={t('searchApiKeyHint')}>
            <SettingsInput
              id="search-api-key"
              data-testid="search-api-key"
              type="password"
              value={apiKey}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>
          {selected?.secretConfigured && <p>{t('searchApiKeyStored')}</p>}
          <Field label={t('searchClearKey')} htmlFor="search-clear-key">
            <SettingsInput
              id="search-clear-key"
              data-testid="search-clear-key"
              type="checkbox"
              checked={clearKey}
              onChange={(event) => setClearKey(event.target.checked)}
            />
          </Field>
          <Field label={t('searchMaxResults')} htmlFor="search-max-results">
            <SchemaControl
              schema={searchConfigSchema.properties.maxResults}
              value={maxResults}
              t={t}
              onChange={(value) => setMaxResults(String(value))}
            />
          </Field>
          <Field label={t('searchTimeout')} htmlFor="search-timeout">
            <SchemaControl
              schema={searchConfigSchema.properties.timeoutMs}
              value={timeoutMs}
              t={t}
              onChange={(value) => setTimeoutMs(String(value))}
            />
          </Field>
          <Field label={t('searchRate')} htmlFor="search-rate">
            <SchemaControl
              schema={searchConfigSchema.properties.ratePerMinute}
              value={rate}
              t={t}
              onChange={(value) => setRate(String(value))}
            />
          </Field>
          <Field label={t('searchEnabled')} htmlFor="search-enabled">
            <SchemaControl
              schema={searchConfigSchema.properties.enabled}
              value={enabled}
              t={t}
              onChange={(value) => setEnabled(value === true)}
            />
          </Field>
          <Field label={t('searchMakeDefault')} htmlFor="search-make-default">
            <SchemaControl
              schema={searchConfigSchema.properties.makeDefault}
              value={makeDefault}
              t={t}
              onChange={(value) => setMakeDefault(value === true)}
            />
          </Field>
          <Button htmlType="submit" data-testid="search-save" disabled={!canSave || busy}>
            {t('searchSave')}
          </Button>
        </fieldset>
      </form>
      <Field label={t('searchTestQuery')} htmlFor="search-test-query">
        <SettingsInput
          id="search-test-query"
          data-testid="search-test-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </Field>
      <Button
        htmlType="button"
        data-testid="search-test"
        disabled={!canSave || busy}
        onClick={() => void testProvider()}
      >
        {t('searchTest')}
      </Button>
      {notice && (
        <SettingsState tone="success" data-testid="search-notice">
          {t(notice)}
        </SettingsState>
      )}
      {error && (
        <SettingsState tone="error" data-testid="search-error">
          {appServerErrorMessage(errorEnvelope, document.documentElement.lang) ?? t(error)}
        </SettingsState>
      )}
      <ul data-testid="search-test-result" aria-live="polite">
        {hits.map((hit) => (
          <li key={hit.url}>
            <a href={hit.url}>{hit.title || hit.url}</a>
            <pre>{hit.snippet}</pre>
          </li>
        ))}
      </ul>
    </SettingsCard>
  )
}
