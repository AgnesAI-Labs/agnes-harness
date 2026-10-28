import type { AgentPlan, AgentRef, BundleLaunch } from '@agnes/protocol'
import {
  AGENTS_NAMESPACE,
  AgentLaunchReview,
  agentsCatalog,
  type BusinessAgentsData,
  openStartedSession,
  useBusinessAgentStart,
} from '@agnes/web-admin/agents'
import {
  type ApplicationWorkRequest,
  type ComposerLaunch,
  composerLaunchAgent,
  homeNavigation,
  rememberApplicationWork,
  rememberSessionAgent,
  resolveApplicationWork,
} from '@agnes/web-client'
import { Banner, Button, Loadable, PushPage, usePushStack, useUiText } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import type { AgentCard } from './agents-model.js'

type Attempt = { plan: AgentPlan; launchTicket: string; operationId: string }
type Launch = {
  ref: AgentRef
  name: string
  pageId: string
  phase: 'preparing' | 'review' | 'starting' | 'failed'
  /** Re-reading the original receipt: the failure panel stays up with a busy action. */
  checking?: boolean
  attempt?: Attempt
  error?: string
  /** The daemon refused the start: no session exists, so retrying cannot create a duplicate. */
  definite?: boolean
  consent?: 'covered' | 'changed' | 'unavailable'
  changes?: string[]
  work?: ApplicationWorkRequest
  /** The user's first composer message: a covered launch starts and sends it, a review keeps it until confirmed. */
  compose?: ComposerLaunch
}

/** Installed agents use the agent launch-ticket facade. Catalog-only agents use the public agent install flow,
 * which also prepares, reviews and starts through that facade after package admission.
 */
export function useAgentLaunch(data: BusinessAgentsData, selectedWorkspace?: () => string | undefined) {
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
  const prepare = async (
    card: Pick<AgentCard, 'ref' | 'name' | 'slug'>,
    work?: ApplicationWorkRequest,
    compose?: ComposerLaunch,
  ) => {
    if (!data.api) return
    const pending: Launch = {
      ref: card.ref,
      name: card.name,
      pageId: `agent-${card.slug}`,
      phase: 'preparing',
      ...(work ? { work } : {}),
      ...(compose ? { compose } : {}),
    }
    set(pending)
    nav.open(pending.pageId)
    try {
      // An explicit composer workspace wins; otherwise the user's selected one, else the launcher's own.
      const workspace = compose?.workspace ?? selectedWorkspace?.()
      const result = await data.api.prepareAgent(card.ref, ...(workspace ? [workspace] : []))
      if (current.current !== pending) return
      if (result.presentation.ref !== card.ref) throw new Error(t('reason.changed'))
      const prepared: Launch = {
        ...pending,
        consent: result.consent ?? 'unavailable',
        ...(result.changes ? { changes: result.changes } : {}),
        phase: 'review',
        attempt: {
          plan: result.presentation,
          launchTicket: result.launchTicket,
          operationId: crypto.randomUUID(),
        },
      }
      set(prepared)
      if ((work || compose) && result.consent === 'covered') await start(prepared)
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
    if (
      !api ||
      !pending.attempt ||
      current.current !== pending ||
      pending.phase === 'starting' ||
      pending.checking
    )
      return
    if (pending.work && resolveApplicationWork(pending.work, locale)?.agent !== pending.ref) {
      set({ ...pending, phase: 'failed', error: t('reason.changed') })
      return
    }
    if (pending.compose && composerLaunchAgent(pending.compose) !== pending.ref) {
      set({ ...pending, phase: 'failed', error: t('reason.changed') })
      return
    }
    const attempt = pending.attempt
    const running: Launch = recover ? { ...pending, checking: true } : { ...pending, phase: 'starting' }
    set(running)
    const complete = (result: { sessionId: string; draft?: BundleLaunch['prompt'] }) => {
      if (current.current !== running) return
      set(undefined)
      // `finish` closes the review page at once; `back` is a late popstate that would reopen the page behind the session.
      nav.finish()
      rememberSessionAgent(result.sessionId, pending.ref, attempt.plan.launch.title)
      const work = pending.work && resolveApplicationWork(pending.work, locale)
      if (work && work.agent === pending.ref)
        rememberApplicationWork(result.sessionId, work.request, pending.ref, attempt.plan.launch.title)
      openStartedSession({
        sessionId: result.sessionId,
        prompt:
          work?.prompt ?? pending.compose?.prompt ?? result.draft?.text[locale] ?? result.draft?.text.en,
        ...(pending.compose ? { send: pending.compose.send } : {}),
      })
    }
    const read = async () => {
      const result = await api.readAgent(attempt.operationId)
      if (result.state !== 'completed' || !result.sessionId) {
        const code = result.code ?? (result.state === 'running' ? 'START_PENDING' : 'OUTCOME_UNKNOWN')
        const text =
          code === 'OUTCOME_UNKNOWN'
            ? `${t('launch.unknown')}${result.cause ? ` (${result.cause})` : ''}`
            : code === 'START_PENDING'
              ? t('launch.pending')
              : code === 'E_PACKAGE_PREVIEW_STALE'
                ? t('reason.changed')
                : `${t('launch.refused')} (${code})`
        throw Object.assign(new Error(text), { definite: result.state === 'failed' })
      }
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
          definite: (error as { definite?: boolean } | null)?.definite === true,
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
  const uncertain = !!launch?.attempt && !launch.definite
  return {
    start(card: AgentCard, work?: ApplicationWorkRequest, compose?: ComposerLaunch) {
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
        if (work) return
        catalog.start({ ...card.catalogAgent, slug: card.slug })
        return
      }
      void prepare(card, work, compose)
    },
    pageId: launch?.pageId ?? catalog.pageId,
    /** The launch waits for the user's decision, or has failed. */
    attention: launch?.phase === 'review' || launch?.phase === 'failed',
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
                onCancel={close}
                cancelTestId="agent-launch-close"
                consent={launch.consent}
                changes={launch.changes}
                object={
                  launch.work ? resolveApplicationWork(launch.work, locale)?.request.object?.id : undefined
                }
                draft={
                  launch.work ? resolveApplicationWork(launch.work, locale)?.prompt : launch.compose?.prompt
                }
                onConfirm={() => {
                  void start(launch)
                }}
              />
            )}
            {launch.phase === 'failed' && (
              <>
                <Banner tone="error">{launch.error}</Banner>
                <Button disabled={!!launch.checking} onClick={() => homeNavigation.open('plugins')}>
                  {t('plugins')}
                </Button>
                {uncertain && <p>{t('launch.uncertain')}</p>}
                <Button
                  data-testid="agent-launch-retry"
                  loading={!!launch.checking}
                  disabled={!!launch.checking}
                  onClick={() => {
                    if (uncertain) void start(launch, true)
                    else
                      void prepare(
                        {
                          ref: launch.ref,
                          name: launch.name,
                          slug: encodeURIComponent(launch.ref),
                        },
                        launch.work,
                        launch.compose,
                      )
                  }}
                >
                  {t(uncertain ? 'launch.check' : 'dialog.retry')}
                </Button>
                {uncertain && (
                  <Button
                    data-testid="agent-launch-new-intent"
                    disabled={!!launch.checking}
                    onClick={() => {
                      void prepare(
                        {
                          ref: launch.ref,
                          name: launch.name,
                          slug: encodeURIComponent(launch.ref),
                        },
                        launch.work,
                        launch.compose,
                      )
                    }}
                  >
                    {t('launch.another')}
                  </Button>
                )}
              </>
            )}
            {launch.phase !== 'review' && (
              <Button data-testid="agent-launch-close" disabled={!!launch.checking} onClick={close}>
                {t(launch.phase === 'preparing' ? 'dialog.cancel' : 'dialog.close')}
              </Button>
            )}
          </PushPage>
        )}
      </>
    ),
  }
}
