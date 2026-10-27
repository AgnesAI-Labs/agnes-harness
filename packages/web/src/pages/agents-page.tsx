import {
  defaultLoop,
  type PackageCatalogDescriptor,
  type PackageInstalledDescriptor,
  resolvePluginMetadata,
} from '@agnes/protocol'
import {
  AGENTS_NAMESPACE,
  ApplicationCard,
  agentsCatalog,
  type BusinessAgentsData,
  useBusinessAgents,
} from '@agnes/web-admin/agents'
import { choiceName } from '@agnes/web-admin/settings/choices'
import { sessionStartUrl } from '@agnes/web-admin/settings/runtime-panels'
import {
  type ApplicationWorkRequest,
  applicationAgents,
  applicationIdentity,
  homeNavigation,
  resolveApplicationWork,
  type UiExtensionContext,
} from '@agnes/web-client'
import {
  Banner,
  Button,
  Disclosure,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Loadable,
  PluginPrimaryStatus,
  PushPage,
  SearchBar,
  Select,
  scopedResourceKey,
  usePushStack,
  useResource,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { homeAdmin } from './admin-api.js'
import { useAgentLaunch } from './agents-launch.js'
import { declaredAgentCards } from './agents-model.js'
import { HomePageFrame } from './page-frame.js'
import { workLaunch } from './work-launch.js'

const source = { connect: homeAdmin }

function AgentList({
  data,
  selection,
}: {
  data: BusinessAgentsData
  selection: UiExtensionContext['selection']
}) {
  const { t, locale } = useUiText(AGENTS_NAMESPACE, agentsCatalog)
  const [query, setQuery] = useState('')
  const [loop, setLoop] = useState<string>()
  const loops = useResource(data.api ? scopedResourceKey(data.api, 'agents:loops') : undefined, async () => {
    if (!data.api) throw new Error('Admin unavailable')
    return data.api.loops()
  })
  const starter = useAgentLaunch(data)
  useSyncExternalStore(applicationIdentity.subscribe, applicationIdentity.getSnapshot)
  const declared = declaredAgentCards(
    data.agents.map((agent) => agent.entry),
    locale,
    data.installed,
  )
  const cards = applicationAgents(declared)
  const needle = query.trim().toLocaleLowerCase()
  const showGeneral = !needle || `${t('general')} ${t('generalHelp')}`.toLocaleLowerCase().includes(needle)
  const products = new Map<string, PackageCatalogDescriptor | PackageInstalledDescriptor>()
  for (const agent of data.agents) products.set(agent.entry.id, agent.entry)
  for (const installed of data.installed) products.set(installed.id, installed)
  const applications = [...products.values()]
    .filter((entry) => entry.application)
    .map((entry) => {
      const assets = data.agents.find((agent) => agent.entry.id === entry.id)?.entry.applicationAssets
      return {
        ...entry,
        agents: declared.filter((card) => card.entry.id === entry.id).map((card) => card.declaration),
        ...(assets ? { applicationAssets: assets } : {}),
      }
    })
  const shownApplications = applications.filter((entry) =>
    JSON.stringify([entry.application?.brand, entry.metadata, entry.id]).toLocaleLowerCase().includes(needle),
  )
  const shown = cards
    .filter((card) => !applications.some((entry) => entry.id === card.entry.id))
    .filter((card) =>
      [card.name, card.summary, card.entry.id].some((text) => text?.toLocaleLowerCase().includes(needle)),
    )
  const request = selection as { focus?: string; agent?: string; start?: boolean } | undefined
  const handled = useRef<unknown>()
  const focused = cards.find(
    (card) =>
      card.ref === (request?.agent ?? request?.focus) ||
      (!request?.agent && card.entry.id === request?.focus),
  )
  useEffect(() => {
    if (!focused || !request?.start || handled.current === selection) return
    handled.current = selection
    starter.start(focused)
  }, [focused, request?.start, selection, starter])
  const workRequest = (selection as { workAction?: ApplicationWorkRequest } | undefined)?.workAction
  const work = workRequest && resolveApplicationWork(workRequest, locale)
  const workHandled = useRef<unknown>()
  const workCard = work && cards.find((item) => item.ref === work.agent && !item.catalogAgent)
  const workStuck = (!!workRequest && (!workCard || !data.api)) || starter.attention
  useEffect(() => {
    if (workStuck) workLaunch.surface()
  }, [workStuck])
  useEffect(() => {
    if (!workRequest || !work || workHandled.current === selection) return
    const card = cards.find((item) => item.ref === work.agent && !item.catalogAgent)
    if (!card) return
    workHandled.current = selection
    starter.start(card, workRequest)
  }, [workRequest, work, selection, cards, starter])
  const navigation = usePushStack()
  const linkedPage = navigation.stack.at(-1)
  const linked = cards.find(
    (card) =>
      linkedPage === `agent-${card.slug}` ||
      // A hand-typed or shared link holds the plain ref (`agent-@pkg/id#agent`), the route having decoded it once.
      linkedPage === `agent-${card.ref}` ||
      linkedPage === `agent-${card.entry.id.split('/').at(-1)}`,
  )
  const linkHandled = useRef<string>()
  useEffect(() => {
    if (!linkedPage?.startsWith('agent-')) {
      linkHandled.current = undefined
      return
    }
    if (starter.pageId === linkedPage || linkHandled.current === linkedPage) return
    // The agents are loaded and none matches: a link to an agent that is not here would wait forever.
    if (!linked) {
      navigation.backTo(0)
      return
    }
    const canonical = `agent-${linked.slug}`
    if (linkedPage !== canonical) {
      navigation.replace(canonical)
      return
    }
    linkHandled.current = linkedPage
    starter.start(linked)
  }, [linkedPage, linked, navigation, starter])
  const initialLoop =
    loops.data &&
    (loops.data.loops.find((item) => item.id === 'agnes.default') ??
      defaultLoop(loops.data.defaults) ??
      loops.data.loops[0])
  const chosenLoop = loops.data?.loops.find((item) =>
    loop === undefined
      ? item.id === initialLoop?.id && item.version === initialLoop.version
      : `${item.id}@${item.version}` === loop,
  )
  return (
    <>
      {data.catalogError !== undefined && <Banner tone="warning">{t('catalogUnavailable')}</Banner>}
      <SearchBar label={t('search')} placeholder={t('searchPlaceholder')} value={query} onChange={setQuery} />
      {/* One feed: cards keep their own height and pack into columns instead of sharing row heights. */}
      <div className="agent-feed" data-testid="agents-gallery">
        {showGeneral && (
          <article className="agent-card" data-testid="general-agent">
            <header>
              <span className="agent-tile" data-tint={0} aria-hidden="true">
                <Icon name="bot" />
              </span>
              <div className="agent-card-heading">
                <h3>{t('general')}</h3>
              </div>
            </header>
            <p className="agent-card-summary">{t('generalHelp')}</p>
            <Disclosure variant="plain" summary={t('otherModes')}>
              <Loadable
                loading={loops.loading}
                error={loops.error}
                hasData={!!loops.data}
                onRetry={loops.reload}
              >
                <Field label={t('runningMode')}>
                  <Select
                    value={chosenLoop ? `${chosenLoop.id}@${chosenLoop.version}` : undefined}
                    aria-label={t('runningMode')}
                    onChange={setLoop}
                    options={(loops.data?.loops ?? []).map((item) => ({
                      value: `${item.id}@${item.version}`,
                      label: choiceName(item, t),
                    }))}
                  />
                </Field>
              </Loadable>
            </Disclosure>
            <footer>
              <Button
                appearance="primary"
                disabled={!chosenLoop}
                disabledReason={t('noRunningMode')}
                // The agent launch facade is AgentRef-only. Ordinary Loop selection stays on the plain
                // new-session branch, with no agent, combination or permission overrides.
                onClick={() =>
                  chosenLoop && location.assign(sessionStartUrl(undefined, undefined, undefined, chosenLoop))
                }
              >
                {t('generalStart')}
              </Button>
            </footer>
          </article>
        )}
        {shownApplications.map((entry) => (
          <ApplicationCard
            key={entry.id}
            entry={entry}
            data={data}
            startableAgents={cards.map((card) => card.ref)}
            onStartAgent={
              cards.some((card) => card.entry.id === entry.id)
                ? (ref) => {
                    const card = cards.find((item) => item.ref === ref)
                    if (card) starter.start(card)
                  }
                : undefined
            }
          />
        ))}
        {shown.map((card) => {
          const installed = data.installed.find((item) => item.id === card.entry.id)
          const blocked = data.denied && !(installed?.trusted && installed.desired === 'enabled')
          return (
            <article className="agent-card" key={card.declaration.ref} data-agent-ref={card.declaration.ref}>
              <header>
                <span className="agent-tile" data-tint={card.tint} aria-hidden="true" translate="no">
                  {card.glyph}
                </span>
                <div className="agent-card-heading">
                  <h3>{card.name}</h3>
                </div>
              </header>
              <p className="agent-card-summary">{card.summary}</p>
              <p className="agent-card-meta">
                {t('sourcePlugin')}:{' '}
                {resolvePluginMetadata(card.entry.metadata, locale)?.displayName ?? card.entry.id}
              </p>
              {installed ? (
                <PluginPrimaryStatus status={installed.primaryStatus} />
              ) : (
                <p className="agent-card-meta">{t('state.available')}</p>
              )}
              <footer>
                <Button
                  disabled={!!blocked}
                  {...(data.denied ? { disabledReason: t(data.denied) } : {})}
                  onClick={() => starter.start(card)}
                >
                  {t('start')}
                </Button>
              </footer>
            </article>
          )
        })}
      </div>
      {!showGeneral && !shown.length && !shownApplications.length && (
        <EmptyState
          icon={<Icon name="bot" size={48} />}
          title={t('noMatchTitle')}
          description={t('noMatchHelp')}
          actions={<Button onClick={() => homeNavigation.open('plugins')}>{t('plugins')}</Button>}
        />
      )}
      {starter.dialog}
      {linkedPage?.startsWith('agent-') && starter.pageId !== linkedPage && (
        <PushPage id={linkedPage} title={linked?.name ?? ''}>
          <Loadable loading hasData={false} />
        </PushPage>
      )}
    </>
  )
}

export function AgentsPage({ context }: { context: UiExtensionContext }) {
  const { t } = useUiText(AGENTS_NAMESPACE, agentsCatalog)
  const data = useBusinessAgents(source)
  useEffect(() => {
    if (data.error) workLaunch.surface()
  }, [data.error])
  return (
    <HomePageFrame
      id="agents"
      title={context.t('home.entry.agents')}
      pushTitle={context.t('home.entry.agents')}
      description={t('description')}
      actions={
        <IconButton name="refresh-cw" label={t('refresh')} disabled={data.busy} onClick={data.reload} />
      }
    >
      <Loadable loading={data.busy} error={data.error} hasData={data.loaded} onRetry={data.reload}>
        <AgentList data={data} selection={context.selection} />
      </Loadable>
    </HomePageFrame>
  )
}
