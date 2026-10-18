import { defaultLoop, resolvePluginMetadata } from '@agnes/protocol'
import {
  AGENTS_NAMESPACE,
  agentsCatalog,
  type BusinessAgentsData,
  useBusinessAgents,
} from '@agnes/web-admin/agents'
import { sessionStartUrl } from '@agnes/web-admin/settings/runtime-panels'
import {
  applicationAgents,
  applicationIdentity,
  homeNavigation,
  type UiExtensionContext,
} from '@agnes/web-client'
import {
  Banner,
  Button,
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
  const cards = applicationAgents(
    declaredAgentCards(
      data.agents.map((agent) => agent.entry),
      locale,
      data.installed,
    ),
  )
  const needle = query.trim().toLocaleLowerCase()
  const shown = cards.filter((card) =>
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
  const navigation = usePushStack()
  const linkedPage = navigation.stack.at(-1)
  const linked = cards.find(
    (card) =>
      linkedPage === `agent-${card.slug}` || linkedPage === `agent-${card.entry.id.split('/').at(-1)}`,
  )
  const linkHandled = useRef<string>()
  useEffect(() => {
    if (!linkedPage?.startsWith('agent-')) {
      linkHandled.current = undefined
      return
    }
    if (!linked || starter.pageId === linkedPage || linkHandled.current === linkedPage) return
    const canonical = `agent-${linked.slug}`
    if (linkedPage !== canonical) {
      navigation.replace(canonical)
      return
    }
    linkHandled.current = linkedPage
    starter.start(linked)
  }, [linkedPage, linked, navigation, starter])
  const initialLoop = loops.data && (defaultLoop(loops.data.defaults) ?? loops.data.loops[0])
  const chosenLoop = loops.data?.loops.find((item) =>
    loop === undefined
      ? item.id === initialLoop?.id && item.version === initialLoop.version
      : `${item.id}@${item.version}` === loop,
  )
  return (
    <>
      {data.catalogError !== undefined && <Banner tone="warning">{t('catalogUnavailable')}</Banner>}
      <SearchBar label={t('search')} value={query} onChange={setQuery} />
      <div className="agent-gallery" data-testid="agents-gallery">
        {(!needle || `${t('general')} ${t('generalHelp')}`.toLocaleLowerCase().includes(needle)) && (
          <article className="agent-card" data-testid="general-agent">
            <header>
              <span className="agent-tile" data-tint={0} aria-hidden="true">
                <Icon name="bot" />
              </span>
              <div className="agent-card-heading">
                <h3>{t('general')}</h3>
              </div>
            </header>
            <p>{t('generalHelp')}</p>
            <Field label={t('runningMode')}>
              <Select
                value={chosenLoop ? `${chosenLoop.id}@${chosenLoop.version}` : undefined}
                aria-label={t('runningMode')}
                onChange={setLoop}
                options={(loops.data?.loops ?? []).map((item) => ({
                  value: `${item.id}@${item.version}`,
                  label: item.label ?? item.id,
                }))}
              />
            </Field>
            <Loadable
              loading={loops.loading}
              error={loops.error}
              hasData={!!loops.data}
              onRetry={loops.reload}
            />
            <Button
              disabled={!chosenLoop}
              disabledReason={t('noRunningMode')}
              // B2's agent facade is AgentRef-only. Ordinary Loop selection stays on the plain
              // new-session branch, with no agent, combination or permission overrides.
              onClick={() =>
                chosenLoop && location.assign(sessionStartUrl(undefined, undefined, undefined, chosenLoop))
              }
            >
              {t('start')}
            </Button>
          </article>
        )}
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
              <p>
                {t('sourcePlugin')}:{' '}
                {resolvePluginMetadata(card.entry.metadata, locale)?.displayName ?? card.entry.id}
              </p>
              {installed ? (
                <PluginPrimaryStatus status={installed.primaryStatus} />
              ) : (
                <p>{t('state.available')}</p>
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
      {!shown.length && (
        <p>
          {t('emptyTitle')} <Button onClick={() => homeNavigation.open('plugins')}>{t('plugins')}</Button>
        </p>
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
