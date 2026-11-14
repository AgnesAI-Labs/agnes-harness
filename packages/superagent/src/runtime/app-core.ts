// Adapted from dsh-superagent (MIT)
/**
 * The state one app's parts share, and the parts every other part builds on: the machine, health, Sources, prompts,
 * commands, the effect queue with the main session's relays and notices, and the links of triggers to their sources.
 */
import { TextCache } from '../app/cache.js'
import { Effects, Later } from '../app/effects.js'
import { environmentOf, ticketEnvironment } from '../app/execution-environment.js'
import { type LinkHost, sourceLink } from '../app/links.js'
import { relaySubject, type SessionNotices } from '../app/notices.js'
import type { Outbox } from '../app/outbox.js'
import type { Passes } from '../app/passes.js'
import { Prompts } from '../app/prompts.js'
import type { Settings } from '../app/settings.js'
import type { Store } from '../app/store.js'
import type { Engine, Ticket, Trigger } from '../core/index.js'
import { type Deployment, machineOf, workerProbe } from '../deployment.js'
import { Commands } from '../infra/commands.js'
import { HealthBoard } from '../infra/health.js'
import { family } from '../kv.js'
import type { SetupProblem } from '../setup.js'
import { SourceRegistry } from '../sources/registry.js'
import type { AppDelivery, AppDeps, Log } from './app.js'
import { sourceTrigger } from './assignment.js'
import { messageIdOf } from './executor.js'
import type { RoleModels } from './role-models.js'
import { ORCHESTRATOR_KEY, type SessionClient } from './sessions.js'

export const now = (): string => new Date().toISOString()

/** Where an app is: built, starting, waiting for setup, running, or stopping (for good). */
export type Phase = 'idle' | 'starting' | 'setup' | 'ready' | 'stopping'
/** What the parts of one app share while it runs. */
export interface AppState {
  phase: Phase
  deployment: Deployment | undefined
  problem: SetupProblem | undefined
  /** How many tool calls run whose domain events the main session knows of already. */
  quiet: number
  /** The start that runs, which a stop waits for. */
  started: Promise<void>
}
export function appState(): AppState {
  return {
    phase: 'idle',
    deployment: undefined,
    problem: undefined,
    quiet: 0,
    started: Promise.resolve(),
  }
}
/** Why Superagent's sessions cannot run now; undefined once the app is ready. */
export function unavailableOf(state: AppState): string | undefined {
  if (state.phase === 'ready') return undefined
  if (state.phase === 'setup')
    return `Superagent is waiting for setup: ${state.problem?.detail ?? 'setup has not run'}`
  return state.phase === 'stopping' ? 'Superagent is stopping' : 'Superagent is starting'
}

/** The parts built before the engine, which the later ones reach through `late`. */
export function buildCore(deps: AppDeps, state: AppState) {
  const { store } = deps
  const client = deps.grant.client as SessionClient
  const machine = deps.machine ?? machineOf({ stateDir: deps.grant.stateDirectory })
  const stopped = new AbortController()
  const lifetime = stopped.signal
  const board = new HealthBoard()
  const runtimeHealth = board.claim('runtime', { state: 'starting', detail: '' })
  const deployed = (): Deployment => {
    if (!state.deployment)
      throw new Error(`Superagent is waiting for setup: ${state.problem?.detail ?? 'setup has not run'}`)
    return state.deployment
  }
  const closing = () => state.phase === 'stopping'
  const paused = () => !state.deployment || store.settings().paused
  const probe = deps.probe ?? workerProbe(machine.stateDir, machine.stateDir, lifetime)
  /** The parts built later, which earlier ones call once the app runs. */
  const late: { settings?: Settings; engine?: Engine; passes?: Passes; outbox?: Outbox } = {}
  const built = <K extends keyof typeof late>(name: K): NonNullable<(typeof late)[K]> => {
    const part = late[name]
    if (!part) throw new Error(`The ${name} of Superagent is not built yet`)
    return part as NonNullable<(typeof late)[K]>
  }
  const sources: SourceRegistry = new SourceRegistry(
    () => store.settings(),
    board,
    (kind) => {
      const { settings } = late
      if (kind.policy?.sync && state.phase === 'ready' && settings?.syncable().includes(kind.kind))
        void settings.sync(kind.kind).catch(() => {})
      return () => {}
    },
  )
  const environment = () =>
    state.deployment
      ? environmentOf({ deployment: state.deployment, sources, settings: store.settings() })
      : undefined
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
  const notices = sessionNotices({
    store,
    effects,
    delivery: deps.delivery,
    log: deps.log,
    ...(deps.roleModels ? { roleModels: deps.roleModels } : {}),
  })
  return {
    client,
    machine,
    stopped,
    lifetime,
    board,
    runtimeHealth,
    deployed,
    closing,
    paused,
    probe,
    late,
    built,
    sources,
    prompts,
    commands,
    effects,
    sourceLinks,
    links,
    link,
    environmentOfTicket,
    notices,
  }
}
export type Core = ReturnType<typeof buildCore>

/** The rolling notices of the main session: the newest of each name, newest first. */
const NOTICES = family<{ name: string; line: string }[], [session: string]>('superagent-notices:')
const MAX_NOTICES = 10

/**
 * The main session's relays and notices: reports and candidates are steered into it in queue order, and notices roll its
 * live note forward without waking it. Exported for tests.
 */
export function sessionNotices(deps: {
  store: Store
  effects: Effects
  delivery: AppDelivery
  roleModels?: RoleModels
  log: Log
}): SessionNotices & { relay(id: string, text: string): void } {
  const { store, effects, delivery } = deps
  const masterId = ORCHESTRATOR_KEY
  effects.handle(
    'relay',
    async ({ text }, requestId) => {
      try {
        await delivery.deliver(masterId, { id: messageIdOf(requestId), content: text, mode: 'steer' })
      } catch (error) {
        if (error instanceof Later) throw error
        // Relays are ordered: one that keeps failing holds back every later one. Its error, which the `relay` health
        // entry shows after repeated failures, names what waits.
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`${relaySubject(requestId, text)} waits to reach the main session: ${reason}`, {
          cause: error,
        })
      }
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
  return {
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
}
