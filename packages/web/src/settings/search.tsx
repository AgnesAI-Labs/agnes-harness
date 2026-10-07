import { Button, Field } from '@agnes/web-ui'
import { useEffect, useState } from 'react'

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
  if (!response.ok) throw new Error(String(response.status))
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
    if (!status || !canSave) return
    const results = integer(maxResults, 1, 10)
    const timeout = integer(timeoutMs, 1000, 60_000)
    const ratePerMinute = integer(rate, 1, 600)
    if (results === undefined || timeout === undefined || ratePerMinute === undefined) {
      setError(t('searchFailed'))
      return
    }
    const savedDefault = status.providers.find((row) => row.isDefault)?.id ?? null
    const defaultProvider = makeDefault ? providerId : savedDefault === providerId ? null : savedDefault
    setBusy(true)
    setError('')
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
      setNotice(t('searchSaved'))
    } catch {
      setError(t('searchFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function testProvider() {
    const probe = query.trim()
    if (!probe) {
      setError(t('searchTestEmpty'))
      return
    }
    setBusy(true)
    setError('')
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
        message?: string
        results?: SearchHit[]
      }
      if (!response.ok || !value.ok) {
        setError(typeof value.message === 'string' ? value.message : t('searchFailed'))
        return
      }
      setHits(Array.isArray(value.results) ? value.results : [])
      setNotice(t('searchSaved'))
    } catch {
      setError(t('searchFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="search-providers" aria-busy={busy}>
      <p>{t('searchHelp')}</p>
      {busy && (
        <p role="status" data-testid="search-loading">
          {t('loading')}
        </p>
      )}
      {failed && (
        <p role="alert" data-testid="search-error">
          {t('searchUnavailable')}
        </p>
      )}
      {status && !status.configured && (
        <p data-testid="search-empty" role="status">
          {t('searchEmpty')}
        </p>
      )}
      {status?.invalid && <p role="alert">{t('searchInvalid')}</p>}
      {status?.configured && <p role="status">{t('searchConfigured')}</p>}
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
            <select
              id="search-edit-provider"
              data-testid="search-edit-provider"
              value={providerId}
              onChange={(event) => {
                if (isProviderId(event.target.value)) setProviderId(event.target.value)
              }}
            >
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {status?.providers.find((row) => row.id === id)?.label ?? id}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('searchEndpoint')} htmlFor="search-endpoint" hint={t('searchEndpointHint')}>
            <input
              id="search-endpoint"
              data-testid="search-endpoint"
              value={endpoint}
              autoComplete="off"
              onChange={(event) => setEndpoint(event.target.value)}
            />
          </Field>
          <Field label={t('searchApiKey')} htmlFor="search-api-key" hint={t('searchApiKeyHint')}>
            <input
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
            <input
              id="search-clear-key"
              data-testid="search-clear-key"
              type="checkbox"
              checked={clearKey}
              onChange={(event) => setClearKey(event.target.checked)}
            />
          </Field>
          <Field label={t('searchMaxResults')} htmlFor="search-max-results">
            <input
              id="search-max-results"
              data-testid="search-max-results"
              inputMode="numeric"
              value={maxResults}
              onChange={(event) => setMaxResults(event.target.value)}
            />
          </Field>
          <Field label={t('searchTimeout')} htmlFor="search-timeout">
            <input
              id="search-timeout"
              data-testid="search-timeout"
              inputMode="numeric"
              value={timeoutMs}
              onChange={(event) => setTimeoutMs(event.target.value)}
            />
          </Field>
          <Field label={t('searchRate')} htmlFor="search-rate">
            <input
              id="search-rate"
              data-testid="search-rate"
              inputMode="numeric"
              value={rate}
              onChange={(event) => setRate(event.target.value)}
            />
          </Field>
          <Field label={t('searchEnabled')} htmlFor="search-enabled">
            <input
              id="search-enabled"
              data-testid="search-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
          </Field>
          <Field label={t('searchMakeDefault')} htmlFor="search-make-default">
            <input
              id="search-make-default"
              data-testid="search-make-default"
              type="checkbox"
              checked={makeDefault}
              onChange={(event) => setMakeDefault(event.target.checked)}
            />
          </Field>
          <Button htmlType="submit" data-testid="search-save" disabled={!canSave || busy}>
            {t('searchSave')}
          </Button>
        </fieldset>
      </form>
      <Field label={t('searchTestQuery')} htmlFor="search-test-query">
        <input
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
        <p role="status" data-testid="search-notice">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" data-testid="search-error">
          {error}
        </p>
      )}
      <ul data-testid="search-test-result" aria-live="polite">
        {hits.map((hit) => (
          <li key={hit.url}>
            <a href={hit.url}>{hit.title || hit.url}</a>
            <pre>{hit.snippet}</pre>
          </li>
        ))}
      </ul>
    </div>
  )
}
