// Adapted from dsh-superagent (MIT)
/**
 * The composition root: the engine and everything it drives, over the sessions and delivery of the AGH SDK client. Every
 * part is built at once and does nothing until `start()` (see `app-run.ts`); `stop()` stops it again and leaves sessions,
 * turns and jobs to the lifecycle that owns cancelling them.
 */
import type { BundledAppGrant } from '@agnes/extension-api'
import type { TextCache } from '../app/cache.js'
import type { Effects } from '../app/effects.js'
import type { ticketEnvironment } from '../app/execution-environment.js'
import type { SessionNotices } from '../app/notices.js'
import type { Outbox } from '../app/outbox.js'
import type { Passes } from '../app/passes.js'
import type { Prompts } from '../app/prompts.js'
import type { Settings } from '../app/settings.js'
import type { Store } from '../app/store.js'
import type { Engine, Ticket } from '../core/index.js'
import { type Deployment, type Machine, machineOf, type Probe } from '../deployment.js'
import type { SetupProblem } from '../setup.js'
import type { SourceHost } from '../sources/host.js'
import type { SourceRegistry } from '../sources/registry.js'
import { appState, buildCore, unavailableOf } from './app-core.js'
import { buildEngine } from './app-engine.js'
import { type AppRun, appRun } from './app-run.js'
import { buildTools } from './app-tools.js'
import { type Redelivery, SessionDelivery } from './delivery.js'
import type { ExecutorSessions, SuperagentExecutor } from './executor.js'
import { type HookState, stoppedHookState, withinSessions } from './hook-state.js'
import { createHookState } from './hooks.js'
import type { PromptBinding } from './prompt.js'
import type { ModelCatalog } from './resources.js'
import { RoleModels } from './role-models.js'
import { type SessionClient, SessionRegistry, Sessions } from './sessions.js'
import type { Tool } from './tool.js'
import { handleTool, type ToolAnswer, type ToolCall } from './tools.js'

export interface Log {
  warn(message: string): void
}
/** What the app needs of the sessions: the frozen adapter, what the executor reads, and the registry of ids. */
export interface AppSessions extends ExecutorSessions {
  readonly registry: SessionRegistry
}
export interface AppDelivery extends Redelivery {
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
   * The synchronous state the hooks read while this app runs, over the live registry of Superagent's sessions, so a
   * worker registered later is governed too. With `reconciled`, the sessions a reconcile went through: a session the
   * store held when this app was built that is not among them stays refused, with its subagents.
   */
  hookState(reconciled?: ReadonlySet<string>): HookState
  /**
   * What the hooks read after this app stopped: its sessions, as the store holds them now, refused every tool for
   * `reason`, each with its live note. It reads the store once, so it outlives the store.
   */
  stoppedState(reason: string): HookState
  handleTool(call: ToolCall): Promise<ToolAnswer>
  /** Why Superagent's sessions cannot run now; undefined once the app is ready. */
  unavailable(): string | undefined
  /** Resolves the deployment again and, once it resolves, opens what a start in setup left closed. */
  reconfigure(): Promise<void>
  /** Why the started app waits for setup; undefined when it does not. */
  setupProblem(): SetupProblem | undefined
  /** What the panel services and other parts read and drive. */
  readonly parts: AppParts
  /**
   * Adds a part's Sources, started with the others once setup completed, and its tools of a ticket's worker; called
   * before `start()`.
   */
  extend(part: AppExtension): void
}
/** What a part adds to the app, such as the Feishu Source and its worker tool. */
export interface AppExtension {
  sources?(host: SourceHost): (() => Promise<void>)[]
  tools?(ticket: Ticket): Tool[]
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
  /** The main session's notices and their delivery. */
  readonly notices: SessionNotices
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
  /** Further tools of the worker of a ticket, such as the Feishu read tool. */
  tools?(ticket: Ticket): Tool[]
  /** Called once a ticket ended. */
  ticketEnded?(ticketId: string): void
  /**
   * Whether a startup reconcile outside the app re-dispatches interrupted Assignments (a lifecycle does); the app then
   * only watches their sessions and queues pending launches again.
   */
  reconciled?: boolean
  /**
   * What a completed setup runs, such as a save of the GitHub Source: by default the app resolves the deployment again
   * (`reconfigure`); a lifecycle that also checks the agent environment takes this over.
   */
  restart?(): void
}

export function createSuperagentApp(given: AppDeps): SuperagentApp {
  const extensions: AppExtension[] = []
  // What the parts read of the Sources and tools reaches the extensions added before the app starts.
  const deps: AppDeps = {
    ...given,
    sources: (host) => [
      ...(given.sources?.(host) ?? []),
      ...extensions.flatMap((part) => part.sources?.(host) ?? []),
    ],
    tools: (ticket) => [
      ...(given.tools?.(ticket) ?? []),
      ...extensions.flatMap((part) => part.tools?.(ticket) ?? []),
    ],
  }
  const state = appState()
  const { registry } = deps.sessions
  /** The sessions of earlier runs, which a startup reconcile goes through. */
  const inherited = new Set(registry.ids())
  let run: AppRun | undefined
  const core = buildCore(deps, state)
  const parts = buildEngine(deps, state, core, () => {
    // After the current caller has its answer, as a setup restart was.
    setTimeout(() => (deps.restart ? deps.restart() : void run?.reconfigure()), 0)
  })
  const unavailable = () => unavailableOf(state)
  const tools = buildTools(deps, state, core, parts, unavailable)
  const running = appRun(deps, state, core, parts, tools)
  run = running
  return {
    executor: parts.executor,
    engine: parts.engine,
    parts: {
      store: deps.store,
      machine: core.machine,
      engine: parts.engine,
      settings: parts.settings,
      prompts: core.prompts,
      sources: core.sources,
      passes: parts.passes,
      effects: core.effects,
      outbox: parts.outbox,
      get health() {
        return core.board.all
      },
      sourceLinks: core.sourceLinks,
      binding: tools.binding,
      notices: core.notices,
      deployment: () => state.deployment,
      setupProblem: () => state.problem,
      models: tools.models,
      ticketEnvironment: core.environmentOfTicket,
      sourceHost: parts.sourceHost,
    },
    unavailable,
    reconfigure: () => running.reconfigure(),
    setupProblem: () => state.problem,
    start: () => running.start(),
    stopSignal: (reason) => running.stopSignal(reason),
    drain: () => running.drain(),
    async stop(reason) {
      running.stopSignal(reason)
      await running.drain()
    },
    hookState: (reconciled) =>
      createHookState({
        registry,
        store: deps.store,
        unavailable,
        ...(reconciled ? { held: unreconciled(inherited, reconciled) } : {}),
        prompt: tools.binding,
        liveNote: (id) => deps.delivery.liveNote(id),
      }),
    stoppedState: (reason) =>
      stoppedHookState(new Map(registry.ids().map((id) => [id, deps.delivery.liveNote(id)])), reason),
    handleTool: (call) => handleTool(tools.toolsHost, call),
    extend: (part) => {
      extensions.push(part)
    },
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
  log?: Log
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
    ...(input.log ? { log: input.log } : {}),
  })
  roleModels.bind(sessions, registry)
  const delivery = new SessionDelivery({ sessions, store })
  return { machine, registry, sessions, delivery, roleModels }
}

/** Why a session of an earlier run that a reconcile did not go through, or a subagent of one, may not run. */
function unreconciled(inherited: ReadonlySet<string>, reconciled: ReadonlySet<string>) {
  const waiting = new Set([...inherited].filter((id) => !reconciled.has(id)))
  return (sessionId: string): string | undefined =>
    withinSessions(waiting, sessionId) === undefined
      ? undefined
      : 'Superagent has not reconciled this session since it started; it can use tools again once it has'
}
