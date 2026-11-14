// Adapted from dsh-superagent (MIT)
/**
 * The engine and what it drives: settings, the executor of worker sessions, the main session's assessor, the outbox and
 * the passes that feed the engine new triggers.
 */
import { MasterAssessor } from '../app/assessment.js'
import { candidateCard, repliedTo } from '../app/links.js'
import { eventNotice, followupNotice } from '../app/notices.js'
import { Outbox } from '../app/outbox.js'
import { Passes } from '../app/passes.js'
import { Settings, type SettingsSetup } from '../app/settings.js'
import { type SourceContextDeps, sourceContextOf } from '../app/source-context.js'
import { evalsHealth } from '../app/views/overview.js'
import { Engine, type EngineForSettings } from '../core/index.js'
import { resolveDeployment } from '../deployment.js'
import { settingsPolicy } from '../policy.js'
import { SetupError } from '../setup.js'
import { pullEndNotices } from '../sources/github-pull.js'
import type { SourceHost } from '../sources/host.js'
import type { AppDeps } from './app.js'
import type { AppState, Core } from './app-core.js'
import { messageIdOf, SuperagentExecutor } from './executor.js'
import { resolveRoleModel } from './role-models.js'
import { ORCHESTRATOR_KEY } from './sessions.js'

/** Builds the engine's parts on `core`; `restart` applies a completed setup. */
export function buildEngine(deps: AppDeps, state: AppState, core: Core, restart: () => void) {
  const { store, sessions, delivery } = deps
  const { late, board, effects, notices, closing, paused, deployed } = core
  const { settings, sourceHost } = buildSettings(deps, state, core, restart)
  const executor = new SuperagentExecutor({
    get engine() {
      return engine
    },
    store,
    effects,
    health: board.claim('worker'),
    models: board.claim('models', {
      state: 'ready',
      detail: 'No worker is waiting out a passing model failure',
    }),
    stateDir: core.machine.stateDir,
    lifetime: core.lifetime,
    sessions,
    delivery,
    relay: (id, text) => notices.relay(id, text),
    closing,
    paused,
    environment: core.environmentOfTicket,
    sourceLink: core.link,
    repliedTo: (trigger) => repliedTo({ store, sources: core.sources }, trigger),
  })
  const assessor = new MasterAssessor({
    get engine() {
      return engine
    },
    commands: core.commands,
    get deployment() {
      return deployed()
    },
    effects,
    settings: () => store.settings(),
    paused,
    threadContext: (trigger) => core.sources.threadContext(trigger),
    deliver: async (id, text) => {
      await delivery.deliver(ORCHESTRATOR_KEY, { id: messageIdOf(id), content: text, mode: 'steer' })
    },
    candidateCard: (candidate) => candidateCard(core.links, candidate),
  })
  const outbox = new Outbox({ store, effects, sources: core.sources, commands: core.commands, paused })
  const engine: Engine = new Engine({
    repo: store,
    scope: core.sources,
    policy: () => settingsPolicy(store.settings(), core.sources),
    assessor,
    executor,
    outbox,
    prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome),
    emit: (event) => {
      // The main session hears of domain events it did not initiate itself.
      const notice = state.quiet ? undefined : eventNotice(event, (id) => store.tickets.get(id))
      if (notice) notices.notify(...notice)
      const followed =
        !state.quiet &&
        (event.type === 'trigger.received' ||
          event.type === 'ticket.resumed' ||
          event.type === 'trigger.followup')
      const followup = followed ? followupNotice(store, core.sources, event.data.triggerId) : undefined
      if (followup) notices.relay(followup.id, followup.text)
      const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
      if (ended) store.afterCommit(() => deps.ticketEnded?.(ended.id))
      if (ended && state.deployment) {
        const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
        for (const message of pullEndNotices(ended, request, state.deployment.repository))
          outbox.send(message)
      }
    },
  })
  const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
  const passes = new Passes({
    engine: {
      receive: (trigger) => engine.receive(trigger),
      evaluateDue: () => {
        engine.evaluateDue()
        evals.set(evalsHealth(store))
      },
    },
    effects,
    health: core.runtimeHealth,
    lifetime: core.lifetime,
    configured: () => state.deployment !== undefined,
    closing,
  })
  Object.assign(late, { engine, passes, outbox })
  return { settings, sourceHost, executor, assessor, outbox, engine, passes }
}
export type EngineParts = ReturnType<typeof buildEngine>

/** Settings and the context the Sources run in, which reach the engine, outbox and passes once they exist. */
function buildSettings(deps: AppDeps, state: AppState, core: Core, restart: () => void) {
  const { store } = deps
  const { late, built, machine, probe, sources } = core
  const setup: SettingsSetup = {
    configured: () => state.deployment !== undefined,
    checkAccounts: async (block, value) => {
      if (block !== 'source:github') return
      await resolveDeployment(machine, value.sources.github?.config, probe).catch((error: unknown) => {
        if (!(error instanceof SetupError) || error.place === 'github') throw error
      })
    },
    blockCommands: (blocked) => deps.blockCommands?.(blocked) ?? Promise.resolve(),
    restart,
  }
  const sourceDeps: SourceContextDeps = {
    store,
    outbox: { send: (message) => built('outbox').send(message) },
    engine: {
      bindThread: (...args) => built('engine').bindThread(...args),
      threadClosed: (...args) => built('engine').threadClosed(...args),
    },
    commands: core.commands,
    sources,
    get deployment() {
      return core.deployed()
    },
    get ready() {
      return state.started
    },
    configured: () => state.deployment !== undefined,
    get setupProblem() {
      return state.problem
    },
    get feishuProblem() {
      return undefined
    },
    receive: (trigger) => built('passes').receive(trigger),
  }
  const sourceHost: SourceHost = { sources, context: (kind) => sourceContextOf(sourceDeps, kind) }
  const policyChanged: EngineForSettings['policyChanged'] = (from, to, effectsOf) => {
    built('engine').policyChanged(from, to, effectsOf)
  }
  const settings = new Settings({
    store,
    sources,
    engine: { policyChanged },
    health: core.board,
    resolveModel: (model) => resolveRoleModel(core.client, model),
    lifetime: core.lifetime,
    sessions: core.notices,
    sourceHost,
    setup,
    requestPass: () => built('passes').request(),
  })
  late.settings = settings
  return { settings, sourceHost }
}
