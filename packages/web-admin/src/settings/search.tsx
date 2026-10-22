import {
  appServerErrorMessage,
  Badge,
  Banner,
  Button,
  type ConfigIssue,
  ConfirmDialog,
  configIssues,
  EmptyState,
  Field,
  Icon,
  IconButton,
  IconTile,
  ListRow,
  Menu,
  PushPage,
  reportSuccess,
  SchemaControl,
  SearchBar,
  SettingsDetails,
  SettingsGroup,
  SettingsInput,
  SettingsItem,
  SettingsList,
  SettingsPageActions,
  SettingsPageDescription,
  SettingsSection,
  SettingsSelect,
  SettingsState,
  SettingsTechnicalDetails,
  SettingsToolbar,
  StateSwitch,
  StatusMessage,
  setDisclosureOpen,
  Tag,
  usePushStack,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { captureRequest, useRequestScope } from './async-request.js'
import { searchConfigSchema } from './config-schemas.js'
import { useSettingsOverlay } from './overlay.js'
import { SEARCH_NAMESPACE, searchCatalog } from './search-locale.js'

/** The page that adds or edits a search service, pushed over 网页搜索. */
const EDITOR_PAGE = 'search-engine'
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
  // Adding or editing a service is a page over 网页搜索 (`search-engine`), not a dialog.
  const pages = usePushStack()
  const editor = pages.stack.at(-1) === EDITOR_PAGE
  const leaveEditor = () => {
    if (pages.stack.at(-1) === EDITOR_PAGE) pages.back()
  }
  const [confirmClear, setConfirmClear] = useState<SearchRow>()
  const [reload, setReload] = useState(0)
  const lifetime = useRequestScope(fetcher, `${canSave}:${reload}:${editor}`)
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
  useSettingsOverlay(!!confirmClear)
  const selected = status?.providers.find((row) => row.id === providerId)
  // biome-ignore lint/correctness/useExhaustiveDependencies: each page or connection starts a fresh operation scope.
  useEffect(() => {
    setBusy(false)
    setError('')
    setNotice('')
    setProbeFailure(undefined)
    setElapsed(undefined)
    setHits([])
  }, [fetcher, canSave, reload, editor])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the retry counter explicitly starts a fresh read.
  useEffect(() => {
    const controller = new AbortController()
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
      const advanced = document.querySelector('[data-testid="search-advanced"]')
      if (advanced) setDisclosureOpen(advanced, true)
      if (field) document.getElementById(field)?.focus()
      return
    }
    const savedDefault = status.defaultProvider
    const defaultProvider = makeDefault ? providerId : savedDefault === providerId ? null : savedDefault
    const request = captureRequest(lifetime)
    setBusy(true)
    setError('')
    setErrorEnvelope(undefined)
    setNotice('')
    try {
      const value = await readJson(
        await fetcher('/admin/api/search', {
          method: 'PUT',
          credentials: 'same-origin',
          signal: request.signal ?? null,
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
      if (!request.isCurrent()) return
      if (!isStatus(value)) throw new Error('invalid')
      // A closed dialog stops rendering, so the key leaves the field before the dialog closes.
      flushSync(() => setApiKey(''))
      setStatus(value)
      reportSuccess('search', t('searchSaved'))
      leaveEditor()
    } catch (error) {
      if (!request.isCurrent()) return
      setErrorEnvelope((error as { envelope?: unknown })?.envelope)
      setError('searchFailed')
    } finally {
      if (request.isCurrent()) setBusy(false)
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
    const request = captureRequest(lifetime)
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
        signal: request.signal ?? null,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: status?.defaultProvider ?? providerId, query: probe }),
      })
      const value = (await response.json()) as {
        ok?: boolean
        error?: unknown
        message?: string
        results?: SearchHit[]
      }
      if (!request.isCurrent()) return
      if (!response.ok || !value.ok) {
        setProbeFailure(appServerErrorMessage(value.error, document.documentElement.lang) ?? ux('testFailed'))
        return
      }
      setHits(Array.isArray(value.results) ? value.results : [])
      setNotice('tested')
      reportSuccess('search-test', ux('testCompleted'))
    } catch (error) {
      if (!request.isCurrent()) return
      setProbeFailure(
        appServerErrorMessage((error as { envelope?: unknown })?.envelope, document.documentElement.lang) ??
          ux('testFailed'),
      )
    } finally {
      if (request.isCurrent()) {
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
    const request = captureRequest(lifetime)
    setBusy(true)
    setError('')
    setErrorEnvelope(undefined)
    try {
      const value = await readJson(
        await fetcher('/admin/api/search', {
          method: 'PUT',
          credentials: 'same-origin',
          signal: request.signal ?? null,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            // A disabled service cannot stay the default (the daemon refuses it); clear it, as the editor does.
            defaultProvider: patch.makeDefault
              ? row.id
              : patch.enabled === false && row.isDefault
                ? null
                : status.defaultProvider,
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
      if (!request.isCurrent()) return
      if (!isStatus(value)) throw new Error('invalid search status')
      setStatus(value)
      setConfirmClear(undefined)
      reportSuccess('search', t('searchSaved'))
    } catch (failure) {
      if (!request.isCurrent()) return
      setErrorEnvelope((failure as { envelope?: unknown })?.envelope)
      setError('searchFailed')
    } finally {
      if (request.isCurrent()) setBusy(false)
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
    pages.open(EDITOR_PAGE)
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
  const numbers = new Intl.NumberFormat(document.documentElement.lang || 'en')
  const listed = status?.providers.filter(configured) ?? []
  const current = listed.filter((row) => row.isDefault)
  const others = listed.filter((row) => !row.isDefault)
  const serviceRow = (row: SearchRow) => (
    <ListRow
      key={row.id}
      data-testid={`search-provider-${row.id}`}
      icon={<IconTile name="globe" />}
      title={row.label}
      titleLabel={`${ux('settings')}: ${row.label}`}
      onOpen={() => edit(row.id)}
      description={row.secretConfigured ? ux('keySaved') : row.needsKey ? ux('keyMissing') : row.endpoint}
      status={
        <>
          {row.isDefault && <Tag tone="info">{ux('default')}</Tag>}
          {row.enabled &&
            (row.ready ? (
              <Badge tone="ok">
                {ux(row.id === status?.defaultProvider && status.configured ? 'connected' : 'ready')}
              </Badge>
            ) : (
              <Tag tone="warn">{t('searchNotReady')}</Tag>
            ))}
        </>
      }
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
          <Menu
            label={ux('actions')}
            trigger={<IconButton name="ellipsis" label={`${ux('actions')}: ${row.label}`} />}
            items={[
              { id: 'settings', label: ux('settings'), onSelect: () => edit(row.id) },
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
    />
  )
  return (
    <section className="capability-panel" data-testid="search-providers" aria-busy={busy}>
      <SettingsPageActions>
        <Button
          appearance="primary"
          icon={<Icon name="plus" />}
          data-testid="search-add"
          disabled={!canSave || busy || !status}
          disabledReason={t('searchReadOnly')}
          onClick={() => edit(status?.providers.find((row) => !configured(row))?.id ?? 'brave')}
        >
          {ux('add')}
        </Button>
      </SettingsPageActions>
      <SettingsPageDescription>{ux('help')}</SettingsPageDescription>
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
      {!canSave && <SettingsState>{t('searchReadOnly')}</SettingsState>}
      {status && !listed.length && (
        <EmptyState
          data-testid="search-empty"
          icon={<Icon name="search" size={48} />}
          title={ux('empty')}
          description={ux('emptyHelp')}
        />
      )}
      {!!readyWithoutDefault.length && (
        <Banner
          data-testid="search-needs-default"
          action={readyWithoutDefault.map((row) => (
            <Button
              key={row.id}
              data-testid={`search-set-default-${row.id}`}
              disabled={!canSave || busy}
              onClick={() => void changeRow(row, { makeDefault: true })}
            >
              {ux('useAsDefault').replace('{name}', row.label)}
            </Button>
          ))}
        >
          {ux('needsDefault')}
        </Banner>
      )}
      {!!current.length && (
        <SettingsSection title={ux('current')}>
          <SettingsList>{current.map(serviceRow)}</SettingsList>
        </SettingsSection>
      )}
      {!!others.length && (
        <SettingsSection title={ux(current.length ? 'otherServices' : 'services')}>
          <SettingsList>{others.map(serviceRow)}</SettingsList>
        </SettingsSection>
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
              loading={busy}
              data-testid="search-test"
              disabled={!canSave || busy || !status?.configured}
              {...(status?.configured ? {} : { disabledReason: ux('needsDefault') })}
              onClick={() => void testProvider()}
            >
              {ux('test')}
            </Button>
          }
        />
        {probeFailure && (
          <StatusMessage
            kind="error"
            data-testid="search-test-error"
            action={{ label: ux('test'), onSelect: () => void testProvider(), busy }}
          >
            {probeFailure}
            {elapsed !== undefined ? ` · ${numbers.format(elapsed)} ms` : ''}
          </StatusMessage>
        )}
        {notice && (
          <SettingsState data-testid="search-notice">
            {notice === 'tested'
              ? `${ux('tested')} · ${ux('results').replace('{count}', String(hits.length))} · ${numbers.format(elapsed ?? 0)} ms`
              : t(notice)}
          </SettingsState>
        )}
        <div data-testid="search-test-result" aria-live="polite">
          {!!hits.length && (
            <SettingsList>
              {hits.map((hit) => (
                <ListRow
                  key={hit.url}
                  icon={<IconTile name="globe" />}
                  title={
                    <a href={hit.url} target="_blank" rel="noreferrer">
                      {hit.title || hit.url}
                    </a>
                  }
                  description={hit.snippet}
                />
              ))}
            </SettingsList>
          )}
        </div>
      </SettingsSection>
      {status && (
        <SettingsTechnicalDetails data-testid="search-technical">
          <dl className="capability-facts">
            {status.providers.map((row) => (
              <div key={row.id}>
                <dt>{row.label}</dt>
                <dd translate="no" data-testid={`search-secret-${row.id}`}>
                  {row.secretRef}
                </dd>
              </div>
            ))}
          </dl>
        </SettingsTechnicalDetails>
      )}
      <PushPage id={EDITOR_PAGE} title={ux(selected && configured(selected) ? 'editTitle' : 'add')}>
        <form id="search-settings-editor" className="capability-form" onSubmit={(event) => void save(event)}>
          <Field label={ux('provider')}>
            <SettingsSelect
              id="search-edit-provider"
              data-testid="search-edit-provider"
              aria-label={ux('provider')}
              disabled={!canSave || busy || !status}
              value={providerId}
              onChange={(event) => {
                const value = event.currentTarget.value
                if (isProviderId(value)) setProviderId(value)
              }}
            >
              {(status?.providers ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </SettingsSelect>
          </Field>
          <Field
            label={t('searchApiKey')}
            htmlFor="search-api-key"
            hint={selected?.secretConfigured ? t('searchApiKeyStored') : t('searchApiKeyHint')}
          >
            <SettingsInput
              id="search-api-key"
              data-testid="search-api-key"
              type="password"
              value={apiKey}
              autoComplete="off"
              spellCheck={false}
              disabled={!canSave || busy || !status}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>
          <SettingsGroup>
            <SettingsItem label={t('searchEnabled')}>
              <StateSwitch
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
              <StateSwitch
                id="search-editor-default"
                testId="search-editor-default"
                label={t('searchMakeDefault')}
                checked={makeDefault}
                disabled={!canSave || busy || !enabled}
                onToggle={setMakeDefault}
              />
            </SettingsItem>
          </SettingsGroup>
          <SettingsDetails
            title={ux('advanced')}
            summary={ux('advancedSummary')}
            data-testid="search-advanced"
          >
            <fieldset className="capability-form" disabled={!canSave || busy || !status}>
              <Field label={t('searchEndpoint')} htmlFor="search-endpoint" hint={t('searchEndpointHint')}>
                <SchemaControl
                  schema={searchConfigSchema.properties.endpoint}
                  value={endpoint}
                  t={t}
                  onChange={(value) => setEndpoint(String(value))}
                />
              </Field>
              <div className="capability-form-columns">
                {(
                  [
                    ['maxResults', 'search-max-results', 'searchMaxResults', maxResults, setMaxResults],
                    ['timeoutMs', 'search-timeout', 'searchTimeout', timeoutMs, setTimeoutMs],
                    ['ratePerMinute', 'search-rate', 'searchRate', rate, setRate],
                  ] as const
                ).map(([name, id, label, value, set]) => (
                  <Field
                    key={name}
                    label={t(label)}
                    htmlFor={id}
                    error={invalid(name) ? <span id={`${id}-error`}>{t(`${label}Error`)}</span> : undefined}
                  >
                    <SchemaControl
                      schema={searchConfigSchema.properties[name]}
                      value={value}
                      t={t}
                      invalid={invalid(name)}
                      describedBy={invalid(name) ? `${id}-error` : undefined}
                      onChange={(next) => {
                        set(String(next))
                        setIssues((current) => current.filter((issue) => issue.path !== `/${name}`))
                      }}
                    />
                  </Field>
                ))}
              </div>
            </fieldset>
          </SettingsDetails>
        </form>
        {error && (
          <StatusMessage
            kind="error"
            action={{ label: ux('retry'), onSelect: () => void save({ preventDefault() {} }), busy }}
          >
            {appServerErrorMessage(errorEnvelope, document.documentElement.lang) ?? t(error)}
          </StatusMessage>
        )}
        <SettingsToolbar className="capability-save">
          <Button disabled={busy} onClick={leaveEditor}>
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
        </SettingsToolbar>
      </PushPage>
      <ConfirmDialog
        open={!!confirmClear}
        title={t('searchClearKey')}
        destructive
        busy={busy}
        confirmLabel={t('searchClearKey')}
        testIds={{ confirm: 'search-clear-confirm' }}
        onCancel={() => setConfirmClear(undefined)}
        onConfirm={() => {
          if (confirmClear) void changeRow(confirmClear, { clearKey: true })
        }}
      >
        <p>{ux('clearHelp')}</p>
        {error && <SettingsState tone="error">{t(error)}</SettingsState>}
      </ConfirmDialog>
    </section>
  )
}
