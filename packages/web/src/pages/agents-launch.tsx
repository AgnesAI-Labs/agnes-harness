import type { AgentPlan, AgentRef, BundleLaunch } from '@agnes/protocol'
import {
  AGENTS_NAMESPACE,
  agentsCatalog,
  type BusinessAgentsData,
  openStartedSession,
  useBusinessAgentStart,
} from '@agnes/web-admin/agents'
import { homeNavigation } from '@agnes/web-client'
import { Banner, Button, Loadable, PushPage, usePushStack, useUiText } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { AgentLaunchReview } from './agents-launch-review.js'
import type { AgentCard } from './agents-model.js'

type Attempt = { plan: AgentPlan; launchTicket: string; operationId: string }
type Launch = {
  ref: AgentRef
  name: string
  pageId: string
  phase: 'preparing' | 'review' | 'starting' | 'failed'
  attempt?: Attempt
  error?: string
}

/** Installed agents use the B2 ticket facade. Catalog-only agents use B2's public install flow,
 * which also prepares, reviews and starts through that facade after package admission.
 */
export function useAgentLaunch(data: BusinessAgentsData) {
  const { t, locale } = useUiText(AGENTS_NAMESPACE, agentsCatalog)
  const nav = usePushStack()
  const [launch, setLaunch] = useState<Launch>()
  const current = useRef<Launch>()
  const set = (next: Launch | undefined) => {
    current.current = next
    setLaunch(next)
  }
  useEffect(
    () => () => {
      current.current = undefined
    },
    [],
  )
  const catalog = useBusinessAgentStart({
    api: data.api,
    features: data.features,
    onChanged: data.refreshInstalled,
  })
  const prepare = async (card: Pick<AgentCard, 'ref' | 'name' | 'slug'>) => {
    if (!data.api) return
    const pending: Launch = {
      ref: card.ref,
      name: card.name,
      pageId: `agent-${card.slug}`,
      phase: 'preparing',
    }
    set(pending)
    nav.open(pending.pageId)
    try {
      const result = await data.api.prepareAgent(card.ref)
      if (current.current !== pending) return
      if (result.presentation.ref !== card.ref) throw new Error(t('reason.changed'))
      set({
        ...pending,
        phase: 'review',
        attempt: {
          plan: result.presentation,
          launchTicket: result.launchTicket,
          operationId: crypto.randomUUID(),
        },
      })
    } catch (error) {
      if (current.current === pending)
        set({
          ...pending,
          phase: 'failed',
          error: error instanceof Error ? error.message : t('reason.request'),
        })
    }
  }
  const start = async (pending: Launch, recover = false) => {
    const api = data.api
    if (!api || !pending.attempt || current.current !== pending || pending.phase === 'starting') return
    const attempt = pending.attempt
    const running: Launch = { ...pending, phase: 'starting' }
    set(running)
    const complete = (result: { sessionId: string; draft?: BundleLaunch['prompt'] }) => {
      if (current.current !== running) return
      set(undefined)
      nav.back()
      openStartedSession({
        sessionId: result.sessionId,
        prompt: result.draft?.text[locale] ?? result.draft?.text.en,
      })
    }
    const read = async () => {
      const result = await api.readAgent(attempt.operationId)
      if (result.state !== 'completed' || !result.sessionId)
        throw new Error(result.code ?? (result.state === 'running' ? 'START_PENDING' : 'OUTCOME_UNKNOWN'))
      complete({ ...result, sessionId: result.sessionId })
    }
    try {
      if (recover) await read()
      else {
        try {
          complete(await api.startAgent(attempt.launchTicket, attempt.operationId))
        } catch {
          await read()
        }
      }
    } catch (error) {
      if (current.current === running)
        set({
          ...pending,
          phase: 'failed',
          error: error instanceof Error ? error.message : t('reason.request'),
        })
    }
  }
  const shown = useRef<string>()
  useEffect(() => {
    if (!launch) return
    if (nav.stack.includes(launch.pageId)) shown.current = launch.pageId
    else if (shown.current === launch.pageId && (launch.phase === 'preparing' || launch.phase === 'review')) {
      shown.current = undefined
      current.current = undefined
      setLaunch(undefined)
    }
  }, [launch, nav.stack])
  const close = () => {
    if (launch?.phase === 'preparing' || launch?.phase === 'review' || !launch?.attempt) set(undefined)
    nav.back()
  }
  return {
    start(card: AgentCard) {
      const pending = current.current
      if (pending) {
        // Keep the original receipt reachable until its result is known or a new intent is explicit.
        nav.open(pending.pageId)
        return
      }
      if (catalog.pageId) {
        nav.open(catalog.pageId)
        return
      }
      if (card.catalogAgent) {
        catalog.start({ ...card.catalogAgent, slug: card.slug })
        return
      }
      void prepare(card)
    },
    pageId: launch?.pageId ?? catalog.pageId,
    dialog: (
      <>
        {catalog.dialog}
        {launch && (
          <PushPage id={launch.pageId} title={launch.name}>
            {launch.phase === 'preparing' || launch.phase === 'starting' ? (
              <Loadable loading hasData={false} />
            ) : null}
            {launch.phase === 'review' && launch.attempt && (
              <AgentLaunchReview
                plan={launch.attempt.plan}
                onConfirm={() => {
                  void start(launch)
                }}
              />
            )}
            {launch.phase === 'failed' && (
              <>
                <Banner tone="error">{launch.error}</Banner>
                <Button onClick={() => homeNavigation.open('plugins')}>{t('plugins')}</Button>
                {launch.attempt && <p>{t('launch.uncertain')}</p>}
                <Button
                  data-testid="agent-launch-retry"
                  onClick={() => {
                    if (launch.attempt) void start(launch, true)
                    else
                      void prepare({
                        ref: launch.ref,
                        name: launch.name,
                        slug: encodeURIComponent(launch.ref),
                      })
                  }}
                >
                  {t(launch.attempt ? 'launch.check' : 'dialog.retry')}
                </Button>
                {launch.attempt && (
                  <Button
                    data-testid="agent-launch-new-intent"
                    onClick={() => {
                      void prepare({
                        ref: launch.ref,
                        name: launch.name,
                        slug: encodeURIComponent(launch.ref),
                      })
                    }}
                  >
                    {t('launch.another')}
                  </Button>
                )}
              </>
            )}
            <Button data-testid="agent-launch-close" onClick={close}>
              {t(
                launch.phase === 'preparing' || launch.phase === 'review' ? 'dialog.cancel' : 'dialog.close',
              )}
            </Button>
          </PushPage>
        )}
      </>
    ),
  }
}
