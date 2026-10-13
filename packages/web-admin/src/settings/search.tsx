import {
  appServerErrorMessage,
  Banner,
  Button,
  type ConfigIssue,
  configIssues,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  Icon,
  IconButton,
  LabeledSwitch,
  ListRow,
  Menu,
  SchemaControl,
  SearchBar,
  SettingsDetails,
  SettingsGroup,
  SettingsInput,
  SettingsItem,
  SettingsPageActions,
  SettingsPageDescription,
  SettingsSection,
  SettingsState,
  StateSwitch,
  Tag,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { searchConfigSchema } from './config-schemas.js'
import { useSettingsOverlay } from './overlay.js'
import { SEARCH_NAMESPACE, searchCatalog } from './search-locale.js'

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
  const { t: ux } = useUiText(SEARCH_NAMESPACE, searchCatalog)
  const lifetime = useRef<AbortController>()
  const [editor, setEditor] = useState(false)
  const [confirmClear, setConfirmClear] = useState<SearchRow>()
  const [reload, setReload] = useState(0)
  const [elapsed, setElapsed] = useState<number>()
  const [probeFailure, setProbeFailure] = useState<string>()
  const [status, setStatus] = useState<SearchStatus>()
  const [providerId, setProviderId] = useState<ProviderId>('brave')
  const [endpoint, setEndpoint] = useState('')
  const [maxResults, setMaxResults] = useState('5')
  const [timeoutMs, setTimeoutMs] = useState('15000')
  const [rate, setRate] = useState('30')
  const [enabled, setEnabled] = useState(false)
  const [makeDefault, setMakeDefault] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [errorEnvelope, setErrorEnvelope] = useState<unknown>()
  const [issues, setIssues] = useState<readonly ConfigIssue[]>([])
  const invalid = (name: string) => issues.some((issue) => issue.path === `/${name}`)
  const [hits, setHits] = useState<SearchHit[]>([])
  useSettingsOverlay(editor || !!confirmClear)
  const selected = status?.providers.find((row) => row.id === providerId)

  // biome-ignore lint/correctness/useExhaustiveDependencies: the retry counter explicitly starts a fresh read.
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    let current = true
    setFailed(false)
    setBusy(true)
    void fetcher('/admin/api/search', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
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
      controller.abort()
    }
  }, [fetcher, reload])

  useEffect(() => {
    if (!selected) return
    setEndpoint(selected.endpoint)
    setMaxResults(String(selected.maxResults))
    setTimeoutMs(String(selected.timeoutMs))
    setRate(String(selected.ratePerMinute))
    setEnabled(selected.enabled)
    setMakeDefault(selected.isDefault)
    setApiKey('')
  }, [selected])

  async function save(event: { preventDefault(): void }) {
    event.preventDefault()
    if (!status || !canSave || busy) return
    const results = integer(maxResults, 1, 10)
    const timeout = integer(timeoutMs, 1000, 60_000)
    const ratePerMinute = integer(rate, 1, 600)
    const validation = configIssues(searchConfigSchema, {
      id: providerId,
      endpoint,
      maxResults: results,
      timeoutMs: timeout,
      ratePerMinute,
      enabled,
      makeDefault,
    })
    setIssues(validation)
    if (validation.length) {
      setErrorEnvelope(undefined)
      setError('searchFailed')
      const field = Object.entries(searchConfigSchema.properties).find(
        ([name]) => validation[0]?.path === `/${name}`,
      )?.[1]['x-ui'].id
      const advanced = document.querySelector<HTMLDetailsElement>('[data-testid="search-advanced"]')
      if (advanced) advanced.open = true
      if (field) document.getElementById(field)?.focus()
      return
    }
    const savedDefault = status.defaultProvider
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
          signal: lifetime.current?.signal ?? null,
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
            ...(apiKey ? { apiKey } : {}),
          }),
        }),
      )
      if (lifetime.current?.signal.aborted) return
      if (!isStatus(value)) throw new Error('invalid')
      setStatus(value)
      setApiKey('')
      setNotice('searchSaved')
      setEditor(false)
    } catch (error) {
      if (lifetime.current?.signal.aborted) return
      setErrorEnvelope((error as { envelope?: unknown })?.envelope)
      setError('searchFailed')
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false)
    }
  }

  async function testProvider() {
    if (!canSave || busy) return
    const probe = query.trim()
    if (!probe) {
      setProbeFailure(ux('testEmpty'))
      setElapsed(undefined)
      return
    }
    setBusy(true)
    setNotice('')
    setProbeFailure(undefined)
    setError('')
    setErrorEnvelope(undefined)
    setHits([])
    setElapsed(undefined)
    const started = performance.now()
    try {
      const response = await fetcher('/admin/api/search/test', {
        method: 'POST',
        credentials: 'same-origin',
        signal: lifetime.current?.signal ?? null,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: status?.defaultProvider ?? providerId, query: probe }),
      })
      const value = (await response.json()) as {
        ok?: boolean
        error?: unknown
        message?: string
        results?: SearchHit[]
      }
      if (lifetime.current?.signal.aborted) return
      if (!response.ok || !value.ok) {
        setProbeFailure(appServerErrorMessage(value.error, document.documentElement.lang) ?? ux('testFailed'))
        return
      }
      setHits(Array.isArray(value.results) ? value.results : [])
      setNotice('tested')
    } catch (error) {
      if (lifetime.current?.signal.aborted) return
      setProbeFailure(
        appServerErrorMessage((error as { envelope?: unknown })?.envelope, document.documentElement.lang) ??
          ux('testFailed'),
      )
    } finally {
      if (!lifetime.current?.signal.aborted) {
        setElapsed(Math.round(performance.now() - started))
        setBusy(false)
      }
    }
  }

  async function changeRow(
    row: SearchRow,
    patch: { enabled?: boolean; makeDefault?: boolean; clearKey?: boolean },
  ) {
    if (!canSave || busy || !status) return
    setBusy(true)
    setError('')
    setErrorEnvelope(undefined)
    try {
      const value = await readJson(
        await fetcher('/admin/api/search', {
          method: 'PUT',
          credentials: 'same-origin',
          signal: lifetime.current?.signal ?? null,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            defaultProvider: patch.makeDefault ? row.id : status.defaultProvider,
            provider: {
              id: row.id,
              enabled: patch.enabled ?? row.enabled,
              endpoint: row.endpoint,
              maxResults: row.maxResults,
              timeoutMs: row.timeoutMs,
              ratePerMinute: row.ratePerMinute,
            },
            ...(patch.clearKey ? { apiKey: '' } : {}),
          }),
        }),
      )
      if (lifetime.current?.signal.aborted) return
      if (!isStatus(value)) throw new Error('invalid search status')
      setStatus(value)
      setConfirmClear(undefined)
      setNotice('searchSaved')
    } catch (failure) {
      if (lifetime.current?.signal.aborted) return
      setErrorEnvelope((failure as { envelope?: unknown })?.envelope)
      setError('searchFailed')
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false)
    }
  }
  function edit(id: ProviderId) {
    const row = status?.providers.find((row) => row.id === id)
    if (row) {
      setEndpoint(row.endpoint)
      setMaxResults(String(row.maxResults))
      setTimeoutMs(String(row.timeoutMs))
      setRate(String(row.ratePerMinute))
      setEnabled(row.enabled)
      setMakeDefault(row.isDefault)
    }
    setProviderId(id)
    setApiKey('')
    setError('')
    setIssues([])
    setEditor(true)
  }
  const problem = failed
    ? t('searchUnavailable')
    : error
      ? (appServerErrorMessage(errorEnvelope, document.documentElement.lang) ?? t(error))
      : status?.invalid
        ? t('searchInvalid')
        : ''
  const configured = (row: SearchRow) =>
    row.enabled || row.secretConfigured || row.isDefault || (!row.needsKey && !!row.endpoint)
  const readyWithoutDefault =
    status && !status.configured ? status.providers.filter((row) => row.enabled && row.ready) : []
  const serviceRow = (row: SearchRow) => (
    <ListRow
      key={row.id}
      data-testid={`search-provider-${row.id}`}
      title={row.label}
      meta={[
        row.isDefault ? ux('default') : '',
        row.ready
          ? ux(row.id === status?.defaultProvider && status.configured ? 'connected' : 'ready')
          : row.secretConfigured
            ? ux('keySaved')
            : '',
      ]
        .filter(Boolean)
        .join(' · ')}
      status={row.enabled && !row.ready ? <Tag tone="warn">{t('searchNotReady')}</Tag> : undefined}
      actions={
        <>
          <StateSwitch
            id={`search-enabled-${row.id}`}
            testId={`search-enabled-${row.id}`}
            label={`${t('searchEnabled')}: ${row.label}`}
            checked={row.enabled}
            disabled={!canSave || busy}
            onToggle={(enabled) => void changeRow(row, { enabled })}
          />
          {readyWithoutDefault.some((ready) => ready.id === row.id) && (
            <Button
              data-testid={`search-set-default-${row.id}`}
              disabled={!canSave || busy}
              onClick={() => void changeRow(row, { makeDefault: true })}
            >
              {t('searchMakeDefault')}
            </Button>
          )}
          <Button data-testid={`search-settings-${row.id}`} onClick={() => edit(row.id)}>
            {ux('settings')}
          </Button>
          <Menu
            label={ux('actions')}
            trigger={<IconButton name="ellipsis" label={`${ux('actions')}: ${row.label}`} />}
            items={[
              {
                id: 'default',
                label: t('searchMakeDefault'),
                disabled: !canSave || busy || row.isDefault,
                onSelect: () => void changeRow(row, { makeDefault: true }),
              },
              {
                id: 'clear',
                label: t('searchClearKey'),
                danger: true,
                disabled: !canSave || busy || !row.secretConfigured,
                onSelect: () => setConfirmClear(row),
              },
            ]}
          />
        </>
      }
    >
      <SettingsDetails compact title={t('searchTechnicalDetails')} data-testid={`search-technical-${row.id}`}>
        <span data-testid={`search-secret-${row.id}`}>{row.secretRef}</span>
      </SettingsDetails>
    </ListRow>
  )
  return (
    <section data-testid="search-providers" aria-busy={busy}>
      <SettingsPageActions>
        <Button
          appearance="primary"
          data-testid="search-add"
          disabled={!canSave || busy || !status}
          disabledReason={t('searchReadOnly')}
          onClick={() => edit(status?.providers.find((row) => !row.enabled)?.id ?? 'brave')}
        >
          {ux('add')}
        </Button>
      </SettingsPageActions>
      <SettingsPageDescription>
        {status?.defaultProvider
          ? `${ux('current')}: ${status.providers.find((row) => row.id === status.defaultProvider)?.label ?? ''}`
          : ux('help')}
      </SettingsPageDescription>
      {busy && !status && (
        <SettingsState tone="loading" data-testid="search-loading">
          {t('loading')}
        </SettingsState>
      )}
      {problem && (
        <Banner
          tone="error"
          data-testid="search-error"
          action={
            failed ? (
              <Button onClick={() => setReload((value) => value + 1)}>{ux('retry')}</Button>
            ) : undefined
          }
        >
          {problem}
        </Banner>
      )}
      {!canSave && <p>{t('searchReadOnly')}</p>}
      {status && !status.providers.some(configured) && (
        <EmptyState
          data-testid="search-empty"
          icon={<Icon name="search" size={48} />}
          title={ux('empty')}
          description={ux('emptyHelp')}
        />
      )}
      {!!readyWithoutDefault.length && (
        <Banner data-testid="search-needs-default">{ux('needsDefault')}</Banner>
      )}
      {status?.providers.filter(configured).map(serviceRow)}
      {status?.providers.some((row) => !configured(row)) && (
        <SettingsDetails title={ux('otherServices')} data-testid="search-other-services">
          {status.providers.filter((row) => !configured(row)).map(serviceRow)}
        </SettingsDetails>
      )}
      <SettingsSection title={ux('trySearch')} description={ux('tryHelp')}>
        <SearchBar
          label={ux('trySearch')}
          placeholder={ux('tryPlaceholder')}
          value={query}
          onChange={setQuery}
          onSubmit={() => {
            if (canSave && !busy && status?.configured) void testProvider()
          }}
          inputProps={{ id: 'search-test-query', 'data-testid': 'search-test-query' }}
          actions={
            <Button
              data-testid="search-test"
              disabled={!canSave || busy || !status?.configured}
              onClick={() => void testProvider()}
            >
              {ux('test')}
            </Button>
          }
        />
      </SettingsSection>
      {probeFailure && (
        <SettingsState tone="error" data-testid="search-test-error">
          {probeFailure}
          {elapsed !== undefined
            ? ` · ${new Intl.NumberFormat(document.documentElement.lang || 'en').format(elapsed)} ms`
            : ''}
        </SettingsState>
      )}
      {notice && (
        <SettingsState tone="success" data-testid="search-notice">
          {notice === 'tested'
            ? `${ux('tested')} · ${new Intl.NumberFormat(document.documentElement.lang || 'en').format(elapsed ?? 0)} ms`
            : t(notice)}
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
      <Drawer
        open={editor}
        title={ux('settings')}
        onClose={() => {
          if (!busy) setEditor(false)
        }}
        footer={
          <>
            <Button disabled={busy} onClick={() => setEditor(false)}>
              {ux('cancel')}
            </Button>
            <Button
              appearance="primary"
              htmlType="submit"
              form="search-settings-editor"
              data-testid="search-save"
              disabled={!canSave || busy}
              loading={busy}
            >
              {t('searchSave')}
            </Button>
          </>
        }
      >
        <form id="search-settings-editor" onSubmit={(event) => void save(event)}>
          <fieldset disabled={!canSave || busy || !status}>
            <SettingsGroup>
              <SettingsItem label={t('searchEnabled')}>
                <LabeledSwitch
                  id="search-editor-enabled"
                  testId="search-editor-enabled"
                  label={t('searchEnabled')}
                  checked={enabled}
                  disabled={!canSave || busy}
                  onToggle={(value) => {
                    setEnabled(value)
                    if (!value) setMakeDefault(false)
                  }}
                />
              </SettingsItem>
              <SettingsItem label={t('searchMakeDefault')}>
                <LabeledSwitch
                  id="search-editor-default"
                  testId="search-editor-default"
                  label={t('searchMakeDefault')}
                  checked={makeDefault}
                  disabled={!canSave || busy || !enabled}
                  onToggle={setMakeDefault}
                />
              </SettingsItem>
            </SettingsGroup>
            <Field label={ux('provider')} htmlFor="search-edit-provider">
              <SchemaControl
                schema={searchConfigSchema.properties.id}
                value={providerId}
                t={(key) => status?.providers.find((row) => row.id === key)?.label ?? key}
                onChange={(value) => {
                  if (isProviderId(value)) setProviderId(value)
                }}
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
            <SettingsDetails title={ux('advanced')} data-testid="search-advanced">
              <Field label={t('searchEndpoint')} htmlFor="search-endpoint" hint={t('searchEndpointHint')}>
                <SchemaControl
                  schema={searchConfigSchema.properties.endpoint}
                  value={endpoint}
                  t={t}
                  onChange={(value) => setEndpoint(String(value))}
                />
              </Field>
              <Field
                label={t('searchMaxResults')}
                htmlFor="search-max-results"
                error={
                  invalid('maxResults') ? (
                    <span id="search-max-results-error">{t('searchMaxResultsError')}</span>
                  ) : undefined
                }
              >
                <SchemaControl
                  schema={searchConfigSchema.properties.maxResults}
                  value={maxResults}
                  t={t}
                  invalid={invalid('maxResults')}
                  describedBy={invalid('maxResults') ? 'search-max-results-error' : undefined}
                  onChange={(value) => {
                    setMaxResults(String(value))
                    setIssues((current) => current.filter((issue) => issue.path !== '/maxResults'))
                  }}
                />
              </Field>
              <Field
                label={t('searchTimeout')}
                htmlFor="search-timeout"
                error={
                  invalid('timeoutMs') ? (
                    <span id="search-timeout-error">{t('searchTimeoutError')}</span>
                  ) : undefined
                }
              >
                <SchemaControl
                  schema={searchConfigSchema.properties.timeoutMs}
                  value={timeoutMs}
                  t={t}
                  invalid={invalid('timeoutMs')}
                  describedBy={invalid('timeoutMs') ? 'search-timeout-error' : undefined}
                  onChange={(value) => {
                    setTimeoutMs(String(value))
                    setIssues((current) => current.filter((issue) => issue.path !== '/timeoutMs'))
                  }}
                />
              </Field>
              <Field
                label={t('searchRate')}
                htmlFor="search-rate"
                error={
                  invalid('ratePerMinute') ? (
                    <span id="search-rate-error">{t('searchRateError')}</span>
                  ) : undefined
                }
              >
                <SchemaControl
                  schema={searchConfigSchema.properties.ratePerMinute}
                  value={rate}
                  t={t}
                  invalid={invalid('ratePerMinute')}
                  describedBy={invalid('ratePerMinute') ? 'search-rate-error' : undefined}
                  onChange={(value) => {
                    setRate(String(value))
                    setIssues((current) => current.filter((issue) => issue.path !== '/ratePerMinute'))
                  }}
                />
              </Field>
            </SettingsDetails>
          </fieldset>
        </form>
        {error && (
          <SettingsState tone="error">
            {appServerErrorMessage(errorEnvelope, document.documentElement.lang) ?? t(error)}
          </SettingsState>
        )}
      </Drawer>
      <Dialog
        focusable={{ focusTriggerAfterClose: false }}
        scrollLock={false}
        getContainer={() => document.body}
        open={!!confirmClear}
        title={t('searchClearKey')}
        onCancel={() => {
          if (!busy) setConfirmClear(undefined)
        }}
        footer={
          <>
            <Button disabled={busy} onClick={() => setConfirmClear(undefined)}>
              {ux('cancel')}
            </Button>
            <Button
              danger
              dangerFilled
              loading={busy}
              data-testid="search-clear-confirm"
              onClick={() => {
                if (confirmClear) void changeRow(confirmClear, { clearKey: true })
              }}
            >
              {t('searchClearKey')}
            </Button>
          </>
        }
      >
        <p>{ux('clearHelp')}</p>
        {error && <SettingsState tone="error">{t(error)}</SettingsState>}
      </Dialog>
    </section>
  )
}
