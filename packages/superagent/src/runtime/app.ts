// Adapted from dsh-superagent (MIT)
/**
 * The composition root: the engine and everything it drives, over the sessions and delivery of the AGH SDK client.
 * `start()` resolves the deployment, opens the main session, starts the GitHub Source and the queues, and re-dispatches
 * what a restart interrupted; `stop()` stops them again and leaves sessions, turns and jobs to the lifecycle that owns
 * cancelling them.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { BundledAppGrant } from '@agnes/extension-api'
import { MasterAssessor } from '../app/assessment.js'
import { TextCache } from '../app/cache.js'
import { Effects } from '../app/effects.js'
import { environmentOf, ticketEnvironment } from '../app/execution-environment.js'
import { candidateCard, type LinkHost, repliedTo, sourceLink } from '../app/links.js'
import { eventNotice, followupNotice, type SessionNotices } from '../app/notices.js'
import { Outbox } from '../app/outbox.js'
import { Passes } from '../app/passes.js'
import { Prompts } from '../app/prompts.js'
import { Settings, type SettingsSetup } from '../app/settings.js'
import { type SourceContextDeps, sourceContextOf } from '../app/source-context.js'
import type { Store } from '../app/store.js'
import { evalsHealth } from '../app/views/overview.js'
import { Engine, type EngineForSettings, type Ticket, type Trigger } from '../core/index.js'
import {
  type Deployment,
  type Machine,
  machineOf,
  type Probe,
  resolveDeployment,
  workerProbe,
} from '../deployment.js'
import { Commands } from '../infra/commands.js'
import { HealthBoard } from '../infra/health.js'
import { family } from '../kv.js'
import { settingsPolicy } from '../policy.js'
import { SetupError, type SetupProblem } from '../setup.js'
import { startGithub } from '../sources/github.js'
import { pullEndNotices } from '../sources/github-pull.js'
import { type SourceContext, type SourceHost, health as sourceHealth } from '../sources/host.js'
import type { ImageSink } from '../sources/kind.js'
import { SourceRegistry } from '../sources/registry.js'
import { sourceTrigger } from './assignment.js'
import { type Delivery, SessionDelivery } from './delivery.js'
import { type ExecutorSessions, messageIdOf, SuperagentExecutor } from './executor.js'
import type { HookState } from './hook-state.js'
import { createHookState } from './hooks.js'
import { aghHome, PromptBinding, SkillFiles } from './prompt.js'
import type { ModelCatalog } from './resources.js'
import { modelCatalog, RoleModels, resolveRoleModel } from './role-models.js'
import { ORCHESTRATOR_KEY, type SessionClient, SessionRegistry, Sessions } from './sessions.js'
import { handleTool, type ToolAnswer, type ToolCall, type ToolsHost } from './tools.js'

const now = (): string => new Date().toISOString()
export interface Log {
  warn(message: string): void
}
/** What the app needs of the sessions: the frozen adapter, what the executor reads, and the registry of ids. */
export interface AppSessions extends ExecutorSessions {
  readonly registry: SessionRegistry
}
export interface AppDelivery extends Delivery {
  liveNote(sessionId: string): { id: string; content: string } | undefined
}
export interface SuperagentApp {
  start(): Promise<void>
  /**
   * Stops at once what must not go on after a disable: Source polling, outbox sends and new dispatch. It leaves sessions
   * alone; `drain()` then waits for the queues and the executor.
   */
  stopSignal(reason: 'disable' | 'generation' | 'shutdown'): void
  /** Waits for the effect queue, the Sources and the executor that `stopSignal` stopped. */
  drain(): Promise<void>
  /** `stopSignal`, then `drain`. */
  stop(reason: 'disable' | 'generation' | 'shutdown'): Promise<void>
  readonly executor: SuperagentExecutor
  /** The engine, through which a startup reconcile reports interrupted Assignments. */
  readonly engine: Pick<Engine, 'assignmentInterrupted'>
  /**
   * The synchronous state the hooks read while this app runs; with `sessionIds`, only those sessions and their
   * subagents count as Superagent's, such as the ones a reconcile went through.
   */
  hookState(sessionIds?: ReadonlySet<string>): HookState
  handleTool(call: ToolCall): Promise<ToolAnswer>
  /** Why Superagent's sessions cannot run now; undefined once the app is ready. */
  unavailable(): string | undefined
  /** What the panel services and other parts read and drive. */
  readonly parts: AppParts
}
export interface AppParts {
  readonly store: Store
  readonly machine: Machine
  readonly engine: Engine
  readonly settings: Settings
  readonly prompts: Prompts
  readonly sources: SourceRegistry
  readonly passes: Passes
  readonly effects: Effects
  readonly outbox: Outbox
  readonly health: Readonly<Record<string, unknown>>
  readonly sourceLinks: TextCache
  readonly binding: PromptBinding
  deployment(): Deployment | undefined
  setupProblem(): SetupProblem | undefined
  models(): Promise<ModelCatalog>
  ticketEnvironment(ticket: Ticket): ReturnType<typeof ticketEnvironment>
  sourceHost: SourceHost
}
export interface AppDeps {
  store: Store
  grant: Pick<BundledAppGrant, 'stateDirectory' | 'client'>
  sessions: AppSessions
  delivery: AppDelivery
  log: Log
  /** Machine settings; by default the grant's state directory with the default limits. */
  machine?: Machine
  roleModels?: RoleModels
  /** How the deployment is probed; by default the agent's `gh` as worker shells run it. */
  probe?: Probe
  /** Variables Superagent's own commands run with, such as the agent's git configuration. */
  commandEnvironment?: Record<string, string>
  /** The AGH skill directory Superagent's skills are written to. */
  skillsRoot?: string
  /** Rewrites the worker command shims for a changed list of blocked commands. */
  blockCommands?(blocked: readonly string[]): Promise<void>
  /** Starts further Sources, such as Feishu; each returns its stop. */
  sources?: (host: SourceHost) => (() => Promise<void>)[]
  /** Called once a ticket ended. */
  ticketEnded?(ticketId: string): void
  /**
   * Whether a startup reconcile outside the app re-dispatches interrupted Assignments (a lifecycle does); the app then
   * only watches their sessions and queues pending launches again.
   */
  reconciled?: boolean
}

/** The rolling notices of the main session: the newest of each name, newest first. */
const NOTICES = family<{ name: string; line: string }[], [session: string]>('superagent-notices:')
const MAX_NOTICES = 10

export function createSuperagentApp(deps: AppDeps): SuperagentApp {
  const { store, sessions, delivery } = deps
  const client = deps.grant.client as SessionClient
  const machine = deps.machine ?? machineOf({ stateDir: deps.grant.stateDirectory })
  const stopped = new AbortController()
  const lifetime = stopped.signal
  const board = new HealthBoard()
  const runtimeHealth = board.claim('runtime', { state: 'starting', detail: '' })
  const masterId = ORCHESTRATOR_KEY
  let phase: 'idle' | 'starting' | 'setup' | 'ready' | 'stopping' = 'idle'
  let deployment: Deployment | undefined
  let problem: SetupProblem | undefined
  let quiet = 0
  const stops: (() => Promise<void>)[] = []
  const draining: Promise<unknown>[] = []
  const deployed = (): Deployment => {
    if (!deployment)
      throw new Error(`Superagent is waiting for setup: ${problem?.detail ?? 'setup has not run'}`)
    return deployment
  }
  const closing = () => phase === 'stopping'
  const paused = () => !deployment || store.settings().paused
  const probe = deps.probe ?? workerProbe(machine.stateDir, machine.stateDir, lifetime)

  const sources: SourceRegistry = new SourceRegistry(
    () => store.settings(),
    board,
    (kind) => {
      if (kind.policy?.sync && phase === 'ready' && settings.syncable().includes(kind.kind))
        void settings.sync(kind.kind).catch(() => {})
      return () => {}
    },
  )
  const environment = () =>
    deployment ? environmentOf({ deployment, sources, settings: store.settings() }) : undefined
  const prompts = new Prompts(
    store,
    () => machine.promptMaxChars.get(),
    environment,
    () => false,
  )
  const commands = new Commands(deployed, deps.commandEnvironment ?? {}, lifetime)
  const effects = new Effects(store, board)
  const sourceLinks = new TextCache(200_000)
  const links: LinkHost = { store, links: sourceLinks, commands, sources, lifetime }
  const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
  const environmentOfTicket = (ticket: Ticket) => {
    const trigger = sourceTrigger({ store }, ticket)
    return ticketEnvironment({
      deployment: deployed(),
      sources,
      settings: store.settings(),
      ticket,
      ...(trigger ? { trigger } : {}),
    })
  }

  // Reports and candidates are steered into the main session in queue order; notices roll its live note forward.
  effects.handle(
    'relay',
    async ({ text }, requestId) => {
      await delivery.deliver(masterId, { id: messageIdOf(requestId), content: text, mode: 'steer' })
    },
    { ordered: true },
  )
  effects.handle(
    'notice',
    async ({ value, summary }, name) => {
      const entries = (store.get(NOTICES(masterId)) ?? []).filter((entry) => entry.name !== name)
      entries.unshift({ name, line: `${now()} ${summary}: ${JSON.stringify(value)}` })
      store.set(NOTICES(masterId), entries.slice(0, MAX_NOTICES))
      delivery.notify(masterId, {
        content: `Superagent notices, newest first:\n${entries
          .slice(0, MAX_NOTICES)
          .map((entry) => `- ${entry.line}`)
          .join('\n')}`,
      })
    },
    { ordered: true },
  )
  const notices: SessionNotices & { relay(id: string, text: string): void } = {
    notify: (name, value, summary) => {
      effects.enqueue('notice', name, { value, summary })
      // A saved role model applies to the role's open sessions.
      if (name === 'settings:eval' || name === 'settings:executor')
        void deps.roleModels?.sync().catch((error: unknown) => deps.log.warn(String(error)))
    },
    delivery: async (name) => {
      await effects.idle('notice')
      return effects.pending('notice', name) ? 'pending' : 'injected'
    },
    relay: (id, text) => effects.enqueue('relay', id, { text }),
  }

  const setup: SettingsSetup = {
    configured: () => deployment !== undefined,
    checkAccounts: async (block, value) => {
      if (block !== 'source:github') return
      await resolveDeployment(machine, value.sources.github?.config, probe).catch((error: unknown) => {
        if (!(error instanceof SetupError) || error.place === 'github') throw error
      })
    },
    blockCommands: (blocked) => deps.blockCommands?.(blocked) ?? Promise.resolve(),
    restart: () => {
      setTimeout(() => void reconfigure(), 0)
    },
  }
  let engine!: Engine
  let passes!: Passes
  const sourceDeps: SourceContextDeps = {
    store,
    outbox: { send: (message) => outbox.send(message) },
    engine: {
      bindThread: (...args) => engine.bindThread(...args),
      threadClosed: (...args) => engine.threadClosed(...args),
    },
    commands,
    sources,
    get deployment() {
      return deployed()
    },
    get ready() {
      return started
    },
    configured: () => deployment !== undefined,
    get setupProblem() {
      return problem
    },
    get feishuProblem() {
      return undefined
    },
    receive: (trigger) => passes.receive(trigger),
  }
  const sourceHost: SourceHost = {
    sources,
    context: (kind) => sourceContextOf(sourceDeps, kind),
  }
  const policyChanged: EngineForSettings['policyChanged'] = (from, to, effectsOf) => {
    engine.policyChanged(from, to, effectsOf)
  }
  const settings = new Settings({
    store,
    sources,
    engine: { policyChanged },
    health: board,
    resolveModel: (model) => resolveRoleModel(client, model),
    lifetime,
    sessions: notices,
    sourceHost,
    setup,
    requestPass: () => passes.request(),
  })
  const executor = new SuperagentExecutor({
    get engine() {
      return engine
    },
    store,
    effects,
    health: board.claim('worker'),
    stateDir: machine.stateDir,
    lifetime,
    sessions,
    delivery,
    relay: (id, text) => notices.relay(id, text),
    closing,
    paused,
    environment: environmentOfTicket,
    sourceLink: link,
    repliedTo: (trigger) => repliedTo({ store, sources }, trigger),
  })
  const assessor = new MasterAssessor({
    get engine() {
      return engine
    },
    commands,
    get deployment() {
      return deployed()
    },
    effects,
    settings: () => store.settings(),
    paused,
    threadContext: (trigger) => sources.threadContext(trigger),
    deliver: async (id, text) => {
      await delivery.deliver(masterId, { id: messageIdOf(id), content: text, mode: 'steer' })
    },
    candidateCard: (candidate) => candidateCard(links, candidate),
  })
  const outbox = new Outbox({ store, effects, sources, commands, paused })
  engine = new Engine({
    repo: store,
    scope: sources,
    policy: () => settingsPolicy(store.settings(), sources),
    assessor,
    executor,
    outbox,
    prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome),
    emit: (event) => {
      // The main session hears of domain events it did not initiate itself.
      const notice = quiet ? undefined : eventNotice(event, (id) => store.tickets.get(id))
      if (notice) notices.notify(...notice)
      const followed =
        !quiet &&
        (event.type === 'trigger.received' ||
          event.type === 'ticket.resumed' ||
          event.type === 'trigger.followup')
      const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
      if (followup) notices.relay(followup.id, followup.text)
      const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
      if (ended) store.afterCommit(() => deps.ticketEnded?.(ended.id))
      if (ended && deployment) {
        const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
        for (const message of pullEndNotices(ended, request, deployment.repository)) outbox.send(message)
      }
    },
  })
  const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
  passes = new Passes({
    engine: {
      receive: (trigger) => engine.receive(trigger),
      evaluateDue: () => {
        engine.evaluateDue()
        evals.set(evalsHealth(store))
      },
    },
    effects,
    health: runtimeHealth,
    lifetime,
    configured: () => deployment !== undefined,
    closing,
  })
  const skills = new SkillFiles(prompts, deps.skillsRoot ?? join(aghHome(), 'skills'))
  const binding = new PromptBinding({
    prompts,
    store,
    environment: (ticket) => (deployment ? environmentOfTicket(ticket) : undefined),
    skills,
  })
  const pages = new TextCache(4_000_000)
  const images: ImageSink = {
    check: async () => ({ maxBytes: 10 * 1024 * 1024 }),
    save: async ({ data, name }) => {
      const dir = join(machine.stateDir, 'images')
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${Date.now()}-${basename(name)}`)
      await writeFile(path, data)
      return { path, read: 'Read this file with the read tool to see the image.' }
    },
  }
  const models = () => modelCatalog(client)
  const resources = {
    store,
    pages,
    prompts,
    commands,
    masterId,
    promptVersion: (id: string) => binding.promptVersion(id),
    mayRead: (id: string, revision: number) => binding.mayRead(id, revision),
    feishuPageSize: () => 50,
    sourceLink: link,
    transcript: (id: string) => sessions.transcript(id),
    sessions: {
      status: () => ({
        ...binding.status(sessions.registry.ids()),
        notificationPending: effects.pending('notice', 'prompts'),
      }),
      modelRetry: () => ({}),
    },
    settings,
    models,
  }
  const github = (): SourceContext => sourceHost.context({ kind: 'github', health: ['github'] })
  const toolsHost: ToolsHost = {
    registry: sessions.registry,
    store,
    unavailable: () => unavailable(),
    main: {
      engine,
      store,
      prompts,
      sessions: notices,
      settings,
      assessor,
      resources,
      images,
      log: deps.log,
      requestPass: () => passes.request(),
      sendReplies: () => outbox.sent(),
      quietly: (run) => {
        quiet++
        try {
          return run()
        } finally {
          quiet--
        }
      },
    },
    executor: {
      engine,
      store,
      sessions: notices,
      resources,
      get github() {
        return github()
      },
      sendReplies: () => outbox.sent(),
    },
  }
  const unavailable = (): string | undefined =>
    phase === 'ready'
      ? undefined
      : phase === 'setup'
        ? `Superagent is waiting for setup: ${problem?.detail ?? 'setup has not run'}`
        : phase === 'stopping'
          ? 'Superagent is stopping'
          : 'Superagent is starting'

  let started: Promise<void> = Promise.resolve()
  async function configure(): Promise<boolean> {
    try {
      deployment = await resolveDeployment(machine, store.settings().sources.github?.config, probe)
      problem = undefined
      return true
    } catch (error) {
      if (!(error instanceof SetupError)) throw error
      problem = error.problem
      deployment = undefined
      return false
    }
  }
  /** Opens the main session and starts the Sources and queues of a configured deployment. */
  async function begin(): Promise<void> {
    await sessions.ensureOrchestrator()
    skills.write(prompts.current())
    for (const id of settings.syncable()) await settings.sync(id).catch(() => {})
    if (closing()) return
    stops.push(startGithub(sourceHost), ...(deps.sources?.(sourceHost) ?? []))
    await executor.resume(!deps.reconciled)
    passes.start()
    effects.start()
    phase = 'ready'
    runtimeHealth.set({ state: 'ready', detail: 'Superagent is ready', at: now() })
  }
  async function reconfigure(): Promise<void> {
    if (phase !== 'setup' && phase !== 'ready') return
    const was = deployment !== undefined
    if ((await configure()) && !was && phase === 'setup') await begin()
  }

  return {
    executor,
    engine,
    parts: {
      store,
      machine,
      engine,
      settings,
      prompts,
      sources,
      passes,
      effects,
      outbox,
      get health() {
        return board.all
      },
      sourceLinks,
      binding,
      deployment: () => deployment,
      setupProblem: () => problem,
      models,
      ticketEnvironment: environmentOfTicket,
      sourceHost,
    },
    unavailable,
    async start() {
      if (phase !== 'idle') throw new Error('Superagent was started already')
      phase = 'starting'
      started = (async () => {
        await mkdir(machine.stateDir, { recursive: true, mode: 0o700 })
        if (!(await configure())) {
          phase = 'setup'
          runtimeHealth.set({ ...sourceHealth('paused', 'setupPending'), at: now() })
          return
        }
        await begin()
      })()
      await started
    },
    stopSignal(_reason) {
      if (phase === 'stopping') return
      phase = 'stopping'
      // Each stop begins synchronously: polling ends, the effect queue (and with it the outbox) takes nothing more,
      // and the executor, which reads the phase, dispatches nothing new.
      draining.push(passes.stop(), ...stops.splice(0).map((stop) => stop()), effects.drain())
      stopped.abort()
      assessor.stop()
    },
    async drain() {
      await Promise.allSettled(draining.splice(0))
      await executor.shutdown()
    },
    async stop(reason) {
      this.stopSignal(reason)
      await this.drain()
    },
    hookState: (sessionIds) =>
      createHookState({
        registry: sessionIds ? only(sessions.registry, sessionIds) : sessions.registry,
        store,
        unavailable,
        prompt: binding,
        liveNote: (id) => delivery.liveNote(id),
      }),
    handleTool: (call) => handleTool(toolsHost, call),
  }
}

/**
 * The session parts an app runs on: the registry of Superagent's session ids, the sessions over the grant's SDK client,
 * delivery and role models.
 */
export function createRuntimeParts(input: {
  store: Store
  grant: Pick<BundledAppGrant, 'stateDirectory' | 'client'>
  machine?: Machine
  lifetime: AbortSignal
  /** Checks a prepared ticket directory; throws to fail the ticket. */
  verify?(dir: string, signal: AbortSignal): Promise<void>
  /** Text appended to a new worker session's system prompt. */
  workerPrompt?(ticket: Ticket, dir: string): string | undefined
  /** Variables the prepare command runs with. */
  environment?(ticket: Ticket): Record<string, string>
  /** Writes what the worker is told about its ticket into its directory. */
  instructions?(ticket: Ticket, dir: string): Promise<void>
}) {
  const { store } = input
  const client = input.grant.client as SessionClient
  const machine = input.machine ?? machineOf({ stateDir: input.grant.stateDirectory })
  const registry = new SessionRegistry(store)
  const roleModels = new RoleModels({ client, store })
  const sessions = new Sessions({
    client,
    registry,
    orchestratorDir: () => machine.stateDir,
    prepareCommand: () => store.settings().executor.prepare,
    environment: (ticket) => input.environment?.(ticket) ?? {},
    ...(input.verify ? { verify: input.verify } : {}),
    ...(input.workerPrompt ? { workerPrompt: input.workerPrompt } : {}),
    ...(input.instructions ? { instructions: input.instructions } : {}),
    applyModel: (role, session) => roleModels.apply(role, session),
    lifetime: input.lifetime,
  })
  roleModels.bind(sessions, registry)
  const delivery = new SessionDelivery({ sessions, store })
  return { machine, registry, sessions, delivery, roleModels }
}

/** The registry restricted to `sessionIds` and their subagents (`<parent>/<id>`). */
function only(registry: SessionRegistry, sessionIds: ReadonlySet<string>): Pick<SessionRegistry, 'owner'> {
  const listed = (id: string): boolean => {
    for (let current = id; ; ) {
      if (sessionIds.has(current)) return true
      const parent = current.lastIndexOf('/')
      if (parent <= 0) return false
      current = current.slice(0, parent)
    }
  }
  return { owner: (id) => (listed(id) ? registry.owner(id) : undefined) }
}
