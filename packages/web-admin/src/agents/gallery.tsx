import type { PackageCatalogDescriptor, PackageInstalledDescriptor, PackageListResult } from '@agnes/protocol'
import {
  Button,
  EmptyState,
  hasPermission,
  Icon,
  Loadable,
  MetaText,
  PushPage,
  SearchBar,
  Segmented,
  StatusDot,
  setResource,
  Tag,
  usePushStack,
  useResource,
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
import { discoverableAgent } from './discovery.js'
import { agentPageId, type StartedSession, useBusinessAgentStart } from './start-dialog.js'

type Loaded = {
  api: PluginAdminApi
  context: AdminContext
  rows: readonly PackageCatalogDescriptor[]
  installed: readonly PackageInstalledDescriptor[]
  readyAgents: readonly string[]
  catalogError?: unknown
}
export type BusinessAgentsSource = {
  /** Injected by tests and by hosts that already hold an admin session. */
  connect?: () => Promise<{ api: PluginAdminApi; context: AdminContext; inventory?: PackageListResult }>
}

const connectAdmin = async () => {
  const { context, inventory } = await PluginAdminApi.overview()
  return { api: new PluginAdminApi(context), context, inventory }
}

/**
 * The business agents a daemon offers and how far along each one is. The gallery and the
 * new-session empty state read the same list.
 */
/** One cache entry per way of connecting, so a host or a test with its own admin keeps its own list. */
const sourceKeys = new WeakMap<object, string>()
let sources = 0
function catalogKey(connect: object): string {
  let key = sourceKeys.get(connect)
  if (!key) {
    key = `agents:catalog:${++sources}`
    sourceKeys.set(connect, key)
  }
  return key
}

function readyAgentRefs(
  rows: readonly PackageCatalogDescriptor[],
  installed: readonly PackageInstalledDescriptor[],
): string[] {
  // Readiness is a display projection. Only an explicit start enters launch admission.
  return rows.flatMap((row) => {
    const current = installed.find((pkg) => pkg.id === row.id && pkg.integrity === row.integrity)
    return businessAgentState(current) === 'ready' ? (row.agents ?? []).map((agent) => agent.ref) : []
  })
}

export function useBusinessAgents(
  source: BusinessAgentsSource = {},
  options: Readonly<{ enabled?: boolean }> = {},
) {
  const { locale } = useUiText(AGENTS_NAMESPACE, agentsCatalog)
  const connect = useRef(source.connect ?? connectAdmin)
  const key = options.enabled === false ? undefined : catalogKey(connect.current)
  // One cached read: a return visit shows the cards at once and refreshes them behind.
  const read = useResource<Loaded>(key, async () => {
    const { api, context, inventory } = await connect.current()
    const [catalog, list] = await Promise.all([
      readBusinessAgents(api).then(
        (rows) => ({ rows, error: undefined as unknown }),
        (error: unknown) => ({ rows: [], error }),
      ),
      inventory ?? api.list(),
    ])
    return {
      api,
      context,
      rows: catalog.rows,
      installed: list.packages,
      catalogError: catalog.error,
      readyAgents: readyAgentRefs(catalog.rows, list.packages),
    }
  })
  const loaded = read.data
  /** Re-reads only what a start changes; the catalog itself stays as loaded. */
  const refreshInstalled = useCallback(() => {
    const current = loaded
    if (!current || !key) return
    void current.api
      .list()
      .then((list) =>
        setResource<Loaded>(key, {
          ...current,
          installed: list.packages,
          readyAgents: readyAgentRefs(current.rows, list.packages),
        }),
      )
      .catch(() => {})
  }, [loaded, key])
  const agents = useMemo(
    () =>
      (loaded?.rows ?? [])
        .filter((row) => discoverableAgent(row, loaded?.installed))
        .map((row) => businessAgentView(row, locale)),
    [loaded?.rows, loaded?.installed, locale],
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
    readyAgents: loaded?.readyAgents ?? [],
    /** Why package changes are refused here; undefined when the user may start any agent. */
    denied,
    ...(context
      ? {
          adoptionDenied: context.readOnly
            ? ('readOnly' as const)
            : !hasPermission(context.permissions, 'packages.activate')
              ? ('noPermission' as const)
              : undefined,
        }
      : {}),
    busy: read.loading,
    failed: read.error !== undefined,
    error: read.error,
    catalogError: loaded?.catalogError,
    /** The list has been read once (it may be refreshing). */
    loaded: loaded !== undefined,
    reload: read.reload,
    refreshInstalled,
  }
}

function AgentCard({
  agent,
  state,
  focused,
  disabledReason,
  onStart,
}: {
  agent: BusinessAgent
  state: BusinessAgentState
  focused: boolean
  /** Set when the user may not change packages; a ready agent can still open a session. */
  disabledReason: string | undefined
  onStart(): void
}) {
  const { t } = useUiText(AGENTS_NAMESPACE, agentsCatalog)
  const ready = state === 'ready'
  const blocked = !ready && disabledReason !== undefined
  return (
    <article
      className="agent-card"
      data-state={state}
      data-package={agent.entry.id}
      data-focused={focused || undefined}
      data-testid={`business-agent-${agent.slug}`}
    >
      <header>
        <span className="agent-tile" data-tint={agent.tint} aria-hidden="true" translate="no">
          {agent.glyph}
        </span>
        <div className="agent-card-heading">
          <h3>{agent.name}</h3>
        </div>
      </header>
      {agent.summary && <p className="agent-card-summary">{agent.summary}</p>}
      {agent.samplePrompt && (
        <p className="agent-card-sample" data-testid="business-agent-sample">
          <span>{t('try', { prompt: agent.samplePrompt })}</span>
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
 * Business Agent · FDE: every business agent as a card, each one click away from a session. The page
 * that hosts it owns the title and the refresh action; `data` comes from `useBusinessAgents`.
 */
export function BusinessAgentGallery({
  data,
  focus,
  openSession,
  onOpenPlugins,
}: {
  data: BusinessAgentsData
  /**
   * A card another surface points at: it is scrolled into view and marked. With `start`, one-click
   * start begins for it once, exactly as if its button had been pressed. A new object asks again.
   */
  focus?: { id: string; ref?: string; start?: boolean } | undefined
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
      : data.readyAgents.includes(agent.ref)
        ? 'ready'
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
  const gallery = useRef<HTMLDivElement>(null)
  // A link that names an agent's page (`view=agent-<slug>`) starts it once the list is read.
  const nav = usePushStack()
  const top = nav.stack.at(-1)
  const linked = top?.startsWith('agent-')
    ? data.agents.find((agent) => agentPageId(agent) === top)
    : undefined
  const linkHandled = useRef<string>()
  // biome-ignore lint/correctness/useExhaustiveDependencies: a linked page is acted on once, when its agent is known.
  useEffect(() => {
    if (!top?.startsWith('agent-')) {
      linkHandled.current = undefined
      return
    }
    if (!linked || starter.pageId === top || linkHandled.current === top) return
    linkHandled.current = top
    starter.start(linked)
  }, [top, linked])
  const handled = useRef<object>()
  const focused = focus
    ? data.agents.find((agent) => agent.entry.id === focus.id && (!focus.ref || agent.ref === focus.ref))
    : undefined
  // biome-ignore lint/correctness/useExhaustiveDependencies: a focus request is acted on once, when its card exists.
  useEffect(() => {
    if (!focus || !focused || data.busy || handled.current === focus) return
    handled.current = focus
    for (const card of gallery.current?.querySelectorAll<HTMLElement>('[data-package]') ?? [])
      if (card.dataset.package === focus.id) card.scrollIntoView({ block: 'center' })
    if (!focus.start) return
    const state = stateOf(focused)
    // Without permission to change packages only a ready agent can start; the card says why.
    if (state === 'ready' || !data.denied) starter.start(focused, { quiet: state === 'ready' })
  }, [focus, focused, data.busy])
  return (
    <div className="agent-gallery-page" data-testid="business-agents" aria-busy={data.busy}>
      {
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
      }
      <Loadable
        loading={data.busy}
        error={data.error}
        hasData={data.loaded}
        onRetry={data.reload}
        errorText={<span data-testid="business-agents-error">{t('failed')}</span>}
        shape="cards"
      >
        {data.agents.length === 0 && (
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
          <div className="agent-gallery" data-testid="business-agents-gallery" ref={gallery}>
            {shown.map((agent) => {
              const state = stateOf(agent)
              return (
                <AgentCard
                  key={agent.ref}
                  agent={agent}
                  state={state}
                  focused={focus?.id === agent.entry.id && (!focus.ref || focus.ref === agent.ref)}
                  disabledReason={disabledReason}
                  onStart={() => starter.start(agent, { quiet: state === 'ready' })}
                />
              )
            })}
          </div>
        )}
      </Loadable>
      {starter.dialog}
      {/* A linked agent's page shows at once; its start fills it when the list has been read. */}
      {top?.startsWith('agent-') && starter.pageId !== top && (
        <PushPage id={top} title={linked?.name ?? ''}>
          <Loadable loading hasData={false} shape="rows" />
        </PushPage>
      )}
    </div>
  )
}
