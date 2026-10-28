import type { PackageBlocker, PackageInstalledDescriptor, PackagePreview } from '@agnes/protocol'
import {
  Banner,
  Button,
  Icon,
  type IconName,
  Loadable,
  PushPage,
  SettingsGroup,
  SettingsItem,
  Tag,
  usePushStack,
  useUiText,
} from '@agnes/web-ui'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { InstallReview, shortSource } from '../admin/plugins/install-review.js'
import { AGENTS_NAMESPACE, agentsCatalog } from './agents-locale.js'
import type { BusinessAgent } from './catalog.js'
import { AgentLaunchReview } from './launch-review.js'
import {
  planBlocked,
  planBusinessAgentStart,
  runBusinessAgentStart,
  START_STEPS,
  type StartApi,
  StartError,
  type StartFailure,
  type StartPlan,
  type StartProgress,
  type StartStep,
  type StartTarget,
  startFailureText,
} from './start-flow.js'

type Text = (key: string, vars?: Record<string, string | number>) => string
export type StartedSession = {
  sessionId: string
  prompt?: string | undefined
  /** The prompt is the user's own message: send it instead of leaving it as an editable draft. */
  send?: boolean | undefined
}
/** The workbench listens for this on `window` and opens the session in place, without a reload. */
export const OPEN_SESSION_EVENT = 'agnes:open-session'
/**
 * Opens the started session in the running workbench: the conversation is selected and the sample
 * prompt is filled into its composer, never sent.
 */
export const openStartedSession = (target: StartedSession): void => {
  window.dispatchEvent(new CustomEvent<StartedSession>(OPEN_SESSION_EVENT, { detail: target }))
}

type Reviewed = PackagePreview | PackageInstalledDescriptor
type GetsRow = { icon: IconName; title: string; detail?: string | undefined; caution?: boolean }

const list = (items: readonly string[] | undefined, limit = 4) =>
  items?.length ? items.slice(0, limit).join(', ') + (items.length > limit ? ' …' : '') : undefined

/** What the package declares, in plain words. Nothing here is a promise the daemon did not make. */
export function startGets(reviewed: Reviewed, t: Text): GetsRow[] {
  const capabilities = reviewed.declaredCapabilities
  const rows: GetsRow[] = []
  const tools = capabilities?.tools?.names
  if (tools?.length)
    rows.push({
      icon: 'terminal',
      title: tools.length === 1 ? t('gets.tool') : t('gets.tools', { count: tools.length }),
      detail: list(tools),
    })
  if (reviewed.provides?.includes('loop')) rows.push({ icon: 'bot', title: t('gets.loop') })
  const skills = reviewed.contributions.filter((item) => item.kind === 'skill').map((item) => item.id)
  if (skills.length)
    rows.push({
      icon: 'sparkles',
      title: skills.length === 1 ? t('gets.skill') : t('gets.skills', { count: skills.length }),
      detail: list(skills),
    })
  if (capabilities?.model)
    rows.push({ icon: 'message-square', title: t('gets.model'), detail: t('gets.modelHelp') })
  if (capabilities?.filesystem?.read?.length)
    rows.push({ icon: 'folder-open', title: t('gets.read'), detail: list(capabilities.filesystem.read) })
  if (capabilities?.filesystem?.write?.length)
    rows.push({ icon: 'file-text', title: t('gets.write'), detail: list(capabilities.filesystem.write) })
  if (capabilities?.network?.length || capabilities?.['network.publicRead'])
    rows.push({ icon: 'globe', title: t('gets.network'), detail: list(capabilities.network), caution: true })
  if (capabilities?.exec?.length)
    rows.push({ icon: 'terminal', title: t('gets.exec'), detail: list(capabilities.exec), caution: true })
  const secrets = [...(capabilities?.secrets ?? []), ...(capabilities?.credentials ?? [])]
  if (secrets.length)
    rows.push({ icon: 'key-round', title: t('gets.secrets'), detail: list(secrets), caution: true })
  if (capabilities?.childAgents || capabilities?.subagent)
    rows.push({ icon: 'git-branch', title: t('gets.childAgents'), caution: true })
  return rows
}

type Presets = NonNullable<NonNullable<Reviewed['presentation']>['presets']>

/**
 * What the daemon derived about every session bundle of the package. A line appears only when all
 * of them say so outright; "unknown" and "no" promise nothing and the capability list speaks instead.
 */
export function startGuarantees(presets: Presets | undefined, t: Text): GetsRow[] {
  if (!presets?.length) return []
  const rows: GetsRow[] = []
  if (presets.every((preset) => preset.readOnly === 'yes'))
    rows.push({ icon: 'eye', title: t('promise.readOnly'), detail: t('promise.readOnlyHelp') })
  if (presets.every((preset) => preset.confirmBeforeActions === 'yes'))
    rows.push({ icon: 'shield-check', title: t('promise.confirm'), detail: t('promise.confirmHelp') })
  if (presets.every((preset) => preset.network === 'none'))
    rows.push({ icon: 'globe', title: t('promise.offline'), detail: t('promise.offlineHelp') })
  return rows
}

const actionKey = (plan: StartPlan) =>
  plan.needed.install
    ? 'action.install'
    : plan.needed.trust
      ? 'action.trust'
      : plan.needed.enable
        ? 'action.enable'
        : 'action.session'

const STEP_ICON: Partial<Record<StartProgress[StartStep], IconName>> = {
  done: 'check',
  skipped: 'check',
  failed: 'x',
}

/** The four steps in a row; each says where it stands in words as well as by mark. */
export function StartSteps({ progress, t }: { progress: StartProgress; t: Text }) {
  return (
    <ol className="agent-start-steps" data-testid="agent-start-steps">
      {START_STEPS.map((step, index) => {
        const state = progress[step]
        const icon = STEP_ICON[state]
        return (
          <li
            key={step}
            data-state={state}
            data-testid={`agent-start-step-${step}`}
            aria-current={state === 'running' ? 'step' : undefined}
          >
            <span className="agent-start-step-mark" aria-hidden="true">
              {icon ? <Icon name={icon} size={16} /> : index + 1}
            </span>
            <span className="agent-start-step-name">{t(`step.${step}`)}</span>
            <span className="agent-start-step-state">{t(`stepState.${state}`)}</span>
          </li>
        )
      })}
    </ol>
  )
}

const idle: StartProgress = { install: 'pending', trust: 'pending', enable: 'pending', session: 'pending' }
type LaunchAttempt = { target: StartTarget; operationId: string }

type Phase =
  | { kind: 'idle' }
  | { kind: 'planning'; agent: BusinessAgent }
  | { kind: 'confirm'; agent: BusinessAgent; plan: StartPlan }
  | { kind: 'launch-review'; agent: BusinessAgent; plan: StartPlan; target: StartTarget; operationId: string }
  | {
      kind: 'running'
      agent: BusinessAgent
      plan: StartPlan
      progress: StartProgress
      launch?: LaunchAttempt
    }
  | {
      kind: 'failed'
      agent: BusinessAgent
      plan: StartPlan | undefined
      progress: StartProgress
      failure: StartFailure
      launch?: LaunchAttempt
      /** Re-reading the original receipt: the failure stays on screen with a busy action. */
      checking?: boolean
    }

/** The page a start opens inside Agent FDE: `agent-<slug>`, so a link opens the agent's start. */
export const agentPageId = (agent: Pick<BusinessAgent, 'slug'>) => `agent-${agent.slug}`

export type BusinessAgentStart = {
  /** Begins (or reopens) one-click start for an agent. `quiet` skips the dialog unless something needs the user. */
  start(agent: BusinessAgent, options?: { quiet?: boolean }): void
  /** Package id being prepared, including in the background. */
  startingId: string | undefined
  /** Package id whose last start stopped at a step. */
  failedId: string | undefined
  /** Render once, anywhere in the page: the start's page while it is open. */
  dialog: ReactNode
  /** The page of the start in progress, if any. */
  pageId: string | undefined
}

/**
 * One-click start for a business agent: one confirmation, then install → trust → enable → new
 * session, each step shown, stopping at the one that fails. The gallery and the new-session empty
 * state share this hook; the flow itself is `runBusinessAgentStart`.
 */
export function useBusinessAgentStart(options: {
  api: StartApi | undefined
  features?: readonly string[] | undefined
  /** Package state changed: installed, trusted, enabled or stopped part-way. */
  onChanged?: () => void
  openSession?: (target: StartedSession) => void
  onOpenPlugins?: (agent: BusinessAgent) => void
}): BusinessAgentStart {
  const { t, locale } = useUiText(AGENTS_NAMESPACE, agentsCatalog)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  // The start shows as a page inside Agent FDE (Agent FDE › the agent); its page is the address.
  const nav = usePushStack()
  const navRef = useRef(nav)
  navRef.current = nav
  const show = useCallback((agent: BusinessAgent) => navRef.current.open(agentPageId(agent)), [])
  const hide = useCallback((agent: BusinessAgent) => {
    if (navRef.current.stack.at(-1) === agentPageId(agent)) navRef.current.back()
  }, [])
  const visible = phase.kind !== 'idle' && nav.stack.includes(agentPageId(phase.agent))
  const abort = useRef<AbortController>()
  const latest = useRef(options)
  latest.current = options
  useEffect(() => () => abort.current?.abort(), [])

  const fail = useCallback(
    (agent: BusinessAgent, plan: StartPlan | undefined, progress: StartProgress, error: unknown) => {
      const failure: StartFailure =
        error instanceof StartError
          ? error.failure
          : { step: 'install', code: 'request', detail: error instanceof Error ? error.message : undefined }
      setPhase({
        kind: 'failed',
        agent,
        plan,
        progress: { ...progress, [failure.step]: 'failed' },
        failure,
      })
      show(agent)
      latest.current.onChanged?.()
    },
    [show],
  )

  const run = useCallback(
    (agent: BusinessAgent, plan: StartPlan, signal: AbortSignal) => {
      const api = latest.current.api
      if (!api) return
      let progress = idle
      setPhase({ kind: 'running', agent, plan, progress })
      void runBusinessAgentStart(
        api,
        plan,
        (next) => {
          progress = next
          if (!signal.aborted) setPhase({ kind: 'running', agent, plan, progress: next })
        },
        { signal, features: latest.current.features },
      ).then(
        (target) => {
          if (signal.aborted) return
          latest.current.onChanged?.()
          setPhase({ kind: 'launch-review', agent, plan, target, operationId: crypto.randomUUID() })
          show(agent)
        },
        (error: unknown) => {
          if (!signal.aborted) fail(agent, plan, progress, error)
        },
      )
    },
    [fail, show],
  )

  const begin = useCallback(
    (agent: BusinessAgent, quiet: boolean, confirmed?: { integrity: string; capabilityHash?: string }) => {
      const api = latest.current.api
      if (!api) return
      abort.current?.abort()
      const controller = new AbortController()
      abort.current = controller
      setPhase({ kind: 'planning', agent })
      if (!quiet) show(agent)
      void planBusinessAgentStart(api, agent.entry, { signal: controller.signal }).then(
        (plan) => {
          if (controller.signal.aborted) return
          const reviewed = plan.preview ?? plan.installed
          const settled = !plan.needed.install && !plan.needed.trust
          const same =
            !!confirmed &&
            reviewed?.integrity === confirmed.integrity &&
            reviewed.capabilityHash === confirmed.capabilityHash
          // Nothing new to consent to: an already trusted package, or the version just confirmed.
          if (!planBlocked(plan) && (settled || same)) return run(agent, plan, controller.signal)
          setPhase({ kind: 'confirm', agent, plan })
          show(agent)
        },
        (error: unknown) => {
          if (!controller.signal.aborted) fail(agent, undefined, idle, error)
        },
      )
    },
    [fail, run, show],
  )

  const launch = async (agent: BusinessAgent, plan: StartPlan, attempt: LaunchAttempt, recover = false) => {
    const api = latest.current.api
    if (!api) return
    setPhase((now) =>
      recover && now.kind === 'failed'
        ? { ...now, checking: true }
        : { kind: 'running', agent, plan, progress: { ...idle, session: 'running' }, launch: attempt },
    )
    const complete = (result: { sessionId: string; draft?: StartTarget['launch']['prompt'] }) => {
      setPhase({ kind: 'idle' })
      hide(agent)
      ;(latest.current.openSession ?? openStartedSession)({
        sessionId: result.sessionId,
        prompt: result.draft?.text[locale] ?? result.draft?.text.en,
      })
    }
    const receipt = async () => {
      const result = await api.readAgent(attempt.operationId)
      if (result.state === 'completed' && result.sessionId)
        complete({ ...result, sessionId: result.sessionId })
      else throw new Error(result.code ?? (result.state === 'running' ? 'START_PENDING' : 'OUTCOME_UNKNOWN'))
    }
    const stopped = (error: unknown) => {
      setPhase({
        kind: 'failed',
        agent,
        plan,
        launch: attempt,
        progress: { ...idle, session: 'failed' },
        failure: {
          step: 'session',
          code: 'request',
          detail: error instanceof Error ? error.message : undefined,
        },
      })
      show(agent)
    }
    // Recovery only reads the original receipt: failed/unknown never becomes another start.
    if (recover) {
      try {
        await receipt()
      } catch (error) {
        stopped(error)
      }
      return
    }
    try {
      complete(await api.startAgent(attempt.target.launchTicket, attempt.operationId))
    } catch {
      try {
        await receipt()
      } catch (error) {
        stopped(error)
      }
    }
  }

  const close = () => {
    if (phase.kind === 'idle') return
    const agent = phase.agent
    hide(agent)
    // A running or stopped start keeps going (or keeps its result) in the background.
    if (phase.kind === 'running' || phase.kind === 'failed') return
    abort.current?.abort()
    setPhase({ kind: 'idle' })
  }
  // Leaving the page another way (back, a breadcrumb) is the same as cancelling it.
  const shown = useRef<string>()
  useEffect(() => {
    const id = phase.kind === 'idle' ? undefined : agentPageId(phase.agent)
    if (id && nav.stack.includes(id)) shown.current = id
    else if (id && shown.current === id && (phase.kind === 'planning' || phase.kind === 'confirm')) {
      shown.current = undefined
      abort.current?.abort()
      setPhase({ kind: 'idle' })
    }
  }, [nav.stack, phase])

  const start: BusinessAgentStart['start'] = (agent, startOptions) => {
    // A second click on the same agent brings its page back instead of starting twice.
    if (phase.kind !== 'idle' && phase.agent.ref === agent.ref) return show(agent)
    if (phase.kind === 'running') return show(phase.agent)
    begin(agent, startOptions?.quiet === true)
  }

  const name = phase.kind === 'idle' ? '' : phase.agent.name
  const reviewed = phase.kind === 'confirm' ? (phase.plan.preview ?? phase.plan.installed) : undefined
  const blockers: readonly PackageBlocker[] =
    phase.kind === 'confirm'
      ? [...(phase.plan.preview?.blockers ?? []), ...(phase.plan.installed?.blockers ?? [])]
      : []
  const gets = reviewed ? startGets(reviewed, t) : []
  const promises =
    phase.kind === 'confirm' && reviewed
      ? startGuarantees((reviewed.presentation ?? phase.agent.entry.presentation)?.presets, t)
      : []
  const signed =
    reviewed && 'provenance' in reviewed && reviewed.provenance
      ? reviewed.provenance.signatureVerified
      : undefined
  const plugins = latest.current.onOpenPlugins
  const pluginsLink = plugins && phase.kind !== 'idle' && (
    <Button
      appearance="link"
      data-testid="agent-start-plugins"
      disabled={phase.kind === 'failed' && !!phase.checking}
      onClick={() => {
        const agent = phase.agent
        hide(agent)
        plugins(agent)
      }}
    >
      {t('dialog.plugins')}
    </Button>
  )

  const dialog =
    phase.kind === 'idle' ? null : (
      <PushPage
        id={agentPageId(phase.agent)}
        title={phase.agent.name}
        description={t(
          phase.kind === 'planning'
            ? 'dialog.checking'
            : phase.kind === 'confirm' || phase.kind === 'launch-review'
              ? 'dialog.confirm'
              : phase.kind === 'running'
                ? 'dialog.running'
                : 'dialog.failed',
          { name },
        )}
      >
        <div className="agent-start-page" data-testid="agent-start-dialog">
          {phase.kind === 'launch-review' && (
            <AgentLaunchReview
              plan={phase.target}
              onCancel={close}
              cancelTestId="agent-start-cancel"
              onConfirm={() => {
                void launch(phase.agent, phase.plan, { target: phase.target, operationId: phase.operationId })
              }}
            />
          )}
          {phase.kind === 'planning' && <Loadable loading hasData={false} shape="rows" />}
          {phase.kind === 'confirm' && reviewed && (
            <InstallReview
              testId="agent-start-review"
              getsTestId="agent-start-gets"
              icon="bot"
              name={phase.agent.name}
              meta={[`${reviewed.id} · ${reviewed.version}`]}
              before={
                promises.length > 0 && (
                  <section aria-labelledby="agent-start-promises">
                    <h3 id="agent-start-promises">{t('dialog.promises')}</h3>
                    <SettingsGroup data-testid="agent-start-promises">
                      {promises.map((row) => (
                        <SettingsItem
                          key={row.title}
                          icon={row.icon}
                          label={row.title}
                          description={row.detail}
                        />
                      ))}
                    </SettingsGroup>
                  </section>
                )
              }
              gets={
                gets.length ? (
                  gets.map((row) => (
                    <SettingsItem key={row.title} icon={row.icon} label={row.title} description={row.detail}>
                      {row.caution ? <Tag tone="warn">{t('gets.caution')}</Tag> : undefined}
                    </SettingsItem>
                  ))
                ) : (
                  <SettingsItem
                    icon="key-round"
                    label={t(reviewed.declaredCapabilities ? 'gets.none' : 'gets.undeclared')}
                  />
                )
              }
              verified={signed}
              source={shortSource(reviewed.source)}
              notices={
                <>
                  {blockers.length > 0 && (
                    <Banner tone="error" data-testid="agent-start-blocked">
                      {t('dialog.blocked', {
                        reasons: [...new Set(blockers.map((item) => t(`blocker.${item.code}`)))].join('、'),
                      })}
                    </Banner>
                  )}
                  {phase.agent.entry.presentation?.origin === 'example' && (
                    <Banner tone="info">{t('dialog.demo')}</Banner>
                  )}
                </>
              }
              technical={
                <p className="agent-start-technical" translate="no">
                  {[
                    reviewed.integrity,
                    reviewed.capabilityHash,
                    'license' in reviewed ? reviewed.license : phase.agent.entry.license,
                    signed === undefined ? undefined : t(signed ? 'tech.signed' : 'tech.unsigned'),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              }
              actions={
                <>
                  {pluginsLink}
                  <span className="agent-start-spacer" />
                  <Button data-testid="agent-start-cancel" onClick={close}>
                    {t('dialog.cancel')}
                  </Button>
                  <Button
                    appearance="primary"
                    data-testid="agent-start-confirm"
                    disabled={planBlocked(phase.plan)}
                    onClick={() => abort.current && run(phase.agent, phase.plan, abort.current.signal)}
                  >
                    {t(actionKey(phase.plan))}
                  </Button>
                </>
              }
            />
          )}
          {phase.kind === 'running' && (
            <div className="agnes-settings-stack agent-start-body">
              <StartSteps progress={phase.progress} t={t} />
              <p className="agent-start-help" role="status">
                {t('dialog.runningHelp')}
              </p>
            </div>
          )}
          {phase.kind === 'failed' && (
            <div className="agnes-settings-stack agent-start-body">
              <StartSteps progress={phase.progress} t={t} />
              <Banner tone="error" data-testid="agent-start-error">
                <strong>{t(`fail.${phase.failure.step}`)}</strong>
                <span>{startFailureText(phase.failure, t)}</span>
              </Banner>
              <p className="agent-start-help">{t(`fail.kept.${phase.failure.step}`)}</p>
              {phase.launch && <p>{t('launch.uncertain')}</p>}
            </div>
          )}
          {phase.kind !== 'confirm' && phase.kind !== 'launch-review' && (
            <div className="home-push-actions agent-start-actions">
              {phase.kind === 'running' ? (
                <Button appearance="ghost" data-testid="agent-start-background" onClick={close}>
                  {t('dialog.background')}
                </Button>
              ) : phase.kind === 'failed' ? (
                <>
                  {pluginsLink}
                  <span className="agent-start-spacer" />
                  <Button data-testid="agent-start-close" disabled={!!phase.checking} onClick={close}>
                    {t('dialog.close')}
                  </Button>
                  <Button
                    appearance="primary"
                    data-testid="agent-start-retry"
                    loading={!!phase.checking}
                    disabled={!!phase.checking}
                    onClick={() => {
                      if (phase.launch && phase.plan) {
                        void launch(phase.agent, phase.plan, phase.launch, true)
                        return
                      }
                      const last = phase.plan?.preview ?? phase.plan?.installed
                      begin(
                        phase.agent,
                        false,
                        last
                          ? {
                              integrity: last.integrity,
                              ...(last.capabilityHash ? { capabilityHash: last.capabilityHash } : {}),
                            }
                          : undefined,
                      )
                    }}
                  >
                    {t(phase.launch ? 'launch.check' : 'dialog.retry')}
                  </Button>
                  {phase.launch && (
                    <Button
                      data-testid="agent-start-new-intent"
                      disabled={!!phase.checking}
                      onClick={() => begin(phase.agent, false)}
                    >
                      {t('launch.another')}
                    </Button>
                  )}
                </>
              ) : (
                <Button data-testid="agent-start-cancel" onClick={close}>
                  {t('dialog.cancel')}
                </Button>
              )}
            </div>
          )}
        </div>
      </PushPage>
    )

  return {
    start,
    startingId: phase.kind === 'planning' || phase.kind === 'running' ? phase.agent.entry.id : undefined,
    failedId: phase.kind === 'failed' ? phase.agent.entry.id : undefined,
    dialog,
    pageId: phase.kind === 'idle' ? undefined : agentPageId(phase.agent),
  }
}
