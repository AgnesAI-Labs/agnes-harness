import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'
import {
  Button,
  EmptyState,
  hasPermission,
  Icon,
  MetaText,
  PLUGIN_PRESENTATION_NAMESPACE,
  pluginPresentationCatalog,
  SearchBar,
  Segmented,
  SettingsState,
  StatusDot,
  Tag,
  useUiText,
} from '@agnes/web-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PluginAdminApi } from '../admin/plugins/api.js'
import type { AdminContext } from '../admin/plugins/types.js'
import { AGENTS_NAMESPACE, agentsCatalog } from './agents-locale.js'
import {
  type BusinessAgent,
  type BusinessAgentState,
  businessAgentState,
  businessAgentView,
  readBusinessAgents,
} from './catalog.js'
import { type StartedSession, useBusinessAgentStart } from './start-dialog.js'

type Loaded = {
  api: PluginAdminApi
  context: AdminContext
  rows: readonly PackageCatalogDescriptor[]
  installed: readonly PackageInstalledDescriptor[]
}
export type BusinessAgentsSource = {
  /** Injected by tests and by hosts that already hold an admin session. */
  connect?: () => Promise<{ api: PluginAdminApi; context: AdminContext }>
}

const connectAdmin = async () => {
  const context = await PluginAdminApi.context()
  return { api: new PluginAdminApi(context), context }
}

/**
 * The business agents a daemon offers and how far along each one is. The gallery and the
 * new-session empty state read the same list.
 */
export function useBusinessAgents(source: BusinessAgentsSource = {}) {
  const { locale } = useUiText(AGENTS_NAMESPACE, agentsCatalog)
  const [loaded, setLoaded] = useState<Loaded>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(true)
  const [revision, setRevision] = useState(0)
  const connect = useRef(source.connect ?? connectAdmin)
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an explicit reload.
  useEffect(() => {
    const pending = new AbortController()
    setBusy(true)
    setFailed(false)
    void connect
      .current()
      .then(async ({ api, context }) => {
        const [rows, list] = await Promise.all([readBusinessAgents(api, pending.signal), api.list()])
        if (!pending.signal.aborted) setLoaded({ api, context, rows, installed: list.packages })
      })
      .catch(() => {
        if (!pending.signal.aborted) setFailed(true)
      })
      .finally(() => {
        if (!pending.signal.aborted) setBusy(false)
      })
    return () => pending.abort()
  }, [revision])
  /** Re-reads only what a start changes; the catalog itself stays as loaded. */
  const refreshInstalled = useCallback(() => {
    const api = loaded?.api
    if (!api) return
    void api
      .list()
      .then((list) => setLoaded((current) => (current ? { ...current, installed: list.packages } : current)))
      .catch(() => {})
  }, [loaded?.api])
  const agents = useMemo(
    () => (loaded?.rows ?? []).map((row) => businessAgentView(row, locale)),
    [loaded?.rows, locale],
  )
  const context = loaded?.context
  const denied = !context
    ? undefined
    : context.readOnly
      ? ('readOnly' as const)
      : ['packages.install', 'packages.trust', 'packages.activate'].every((permission) =>
            hasPermission(context.permissions, permission),
          )
        ? undefined
        : ('noPermission' as const)
  return {
    agents,
    api: loaded?.api,
    features: context?.features,
    installed: loaded?.installed ?? [],
    /** Why package changes are refused here; undefined when the user may start any agent. */
    denied,
    busy,
    failed,
    reload: () => setRevision((value) => value + 1),
    refreshInstalled,
  }
}

function AgentCard({
  agent,
  state,
  disabledReason,
  onStart,
}: {
  agent: BusinessAgent
  state: BusinessAgentState
  /** Set when the user may not change packages; a ready agent can still open a session. */
  disabledReason: string | undefined
  onStart(): void
}) {
  const { t } = useUiText(AGENTS_NAMESPACE, agentsCatalog)
  const { t: presentation } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  const ready = state === 'ready'
  const blocked = !ready && disabledReason !== undefined
  return (
    <article className="agent-card" data-state={state} data-testid={`business-agent-${agent.slug}`}>
      <header>
        <span className="agent-tile" data-tint={agent.tint} aria-hidden="true" translate="no">
          {agent.glyph}
        </span>
        <div className="agent-card-heading">
          <h3>{agent.name}</h3>
          {agent.category && <MetaText>{presentation(`category.${agent.category}`)}</MetaText>}
        </div>
      </header>
      {agent.summary && <p className="agent-card-summary">{agent.summary}</p>}
      {agent.samplePrompt && (
        <p className="agent-card-sample" data-testid="business-agent-sample">
          {t('try', { prompt: agent.samplePrompt })}
        </p>
      )}
      <footer>
        {ready ? (
          <span className="agent-card-state">
            <StatusDot tone="success" />
            {t('state.ready')}
          </span>
        ) : state === 'attention' ? (
          <Tag tone="warn">{t('state.attention')}</Tag>
        ) : (
          <MetaText className="agent-card-state" aria-busy={state === 'starting' || undefined}>
            {t(`state.${state}`)}
          </MetaText>
        )}
        <Button
          size="small"
          appearance={ready ? 'secondary' : 'primary'}
          data-testid={`business-agent-start-${agent.slug}`}
          loading={state === 'starting'}
          disabled={blocked}
          {...(blocked ? { disabledReason } : {})}
          aria-label={t(ready ? 'startSessionLabel' : 'startLabel', { name: agent.name })}
          onClick={onStart}
        >
          {t(ready ? 'startSession' : state === 'attention' ? 'review' : 'start')}
        </Button>
      </footer>
    </article>
  )
}

export type BusinessAgentsData = ReturnType<typeof useBusinessAgents>

/**
 * 业务 Agent · FDE: every business agent as a card, each one click away from a session. The page
 * that hosts it owns the title and the refresh action; `data` comes from `useBusinessAgents`.
 */
export function BusinessAgentGallery({
  data,
  openSession,
  onOpenPlugins,
}: {
  data: BusinessAgentsData
  openSession?: (target: StartedSession) => void
  onOpenPlugins?: (agent: BusinessAgent) => void
}) {
  const { t } = useUiText(AGENTS_NAMESPACE, agentsCatalog)
  const [query, setQuery] = useState('')
  const [readyOnly, setReadyOnly] = useState(false)
  const starter = useBusinessAgentStart({
    api: data.api,
    features: data.features,
    onChanged: data.refreshInstalled,
    ...(openSession ? { openSession } : {}),
    ...(onOpenPlugins ? { onOpenPlugins } : {}),
  })
  const stateOf = (agent: BusinessAgent): BusinessAgentState =>
    starter.failedId === agent.entry.id
      ? 'attention'
      : businessAgentState(
          data.installed.find((item) => item.id === agent.entry.id),
          starter.startingId === agent.entry.id,
        )
  const needle = query.trim().toLocaleLowerCase()
  const readyCount = data.agents.filter((agent) => stateOf(agent) === 'ready').length
  const shown = data.agents.filter(
    (agent) =>
      (!readyOnly || stateOf(agent) === 'ready') &&
      (!needle ||
        [agent.name, agent.summary, agent.samplePrompt, agent.slug].some((text) =>
          text?.toLocaleLowerCase().includes(needle),
        )),
  )
  const disabledReason = data.denied ? t(data.denied) : undefined
  return (
    <div className="agent-gallery-page" data-testid="business-agents" aria-busy={data.busy}>
      {data.agents.length > 0 && (
        <SearchBar
          label={t('search')}
          placeholder={t('searchPlaceholder')}
          value={query}
          onChange={setQuery}
          inputProps={{ 'data-testid': 'business-agents-search' }}
          filters={
            <Segmented
              label={t('filter')}
              testId="business-agents-filter"
              value={readyOnly ? 'ready' : 'all'}
              onChange={(value) => setReadyOnly(value === 'ready')}
              options={[
                {
                  value: 'all',
                  label: t('filterAll', { count: data.agents.length }),
                  testId: 'business-agents-filter-all',
                },
                {
                  value: 'ready',
                  label: t('filterReady', { count: readyCount }),
                  testId: 'business-agents-filter-ready',
                },
              ]}
            />
          }
        />
      )}
      {data.busy && data.agents.length === 0 && <SettingsState tone="loading">{t('loading')}</SettingsState>}
      {data.failed && (
        <SettingsState tone="error" data-testid="business-agents-error">
          {t('failed')}
        </SettingsState>
      )}
      {!data.busy && !data.failed && data.agents.length === 0 && (
        <EmptyState
          data-testid="business-agents-empty"
          icon={<Icon name="bot" size={48} />}
          title={t('emptyTitle')}
          description={t('emptyHelp')}
          actions={<Button onClick={data.reload}>{t('refresh')}</Button>}
        />
      )}
      {data.agents.length > 0 && shown.length === 0 && (
        <EmptyState
          icon={<Icon name="search" size={48} />}
          title={t('noMatchTitle')}
          description={t('noMatchHelp')}
        />
      )}
      {shown.length > 0 && (
        <div className="agent-gallery" data-testid="business-agents-gallery">
          {shown.map((agent) => {
            const state = stateOf(agent)
            return (
              <AgentCard
                key={agent.entry.id}
                agent={agent}
                state={state}
                disabledReason={disabledReason}
                onStart={() => starter.start(agent, { quiet: state === 'ready' })}
              />
            )
          })}
        </div>
      )}
      {starter.dialog}
    </div>
  )
}
