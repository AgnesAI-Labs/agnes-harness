/**
 * Turning Superagent on and off. On: after `start()` has returned, write the agent environment and check it, start the
 * composed app, reconcile each of its Sessions by its real state, archive expired records (now and daily), and only then
 * let the hooks treat those Sessions as Superagent's. Off: stop polling and sending, drop what waits in the Sessions,
 * cancel their turns and kill their agent jobs, record the pause, and clear the hooks' snapshot. Sessions and the state
 * directory stay; the next start reconciles from them.
 */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Store } from '../app/store.js'
import { archiveExpired } from '../app/store-retention.js'
import { interruptionRestarts } from '../core/assignments.js'
import { liveTicket, runningAssignment, type Ticket } from '../core/index.js'
import { KV } from '../kv.js'
import { type SetupCode, SetupError, type SetupProblem } from '../setup.js'
import type { SessionAdapter, SuperagentApp } from './contracts.js'
import { type EnvironmentConfig, verifyEnvironment, writeEnvironment } from './environment.js'
import type { HookState, HookStateCell } from './hook-state.js'
import type { SdkClient } from './sdk.js'

export type StopReason = 'disable' | 'generation' | 'shutdown'
export type LifecycleStatus =
  | { state: 'stopped' | 'starting' | 'running' | 'stopping' }
  /** The configuration is incomplete (`setupRequired`) or an account or environment check failed (`setupFailed`). */
  | { state: 'setupRequired' | 'setupFailed'; problem: SetupProblem }
  | { state: 'failed'; detail: string }

export interface Lifecycle {
  /** Begins turning Superagent on and returns at once; the work runs afterwards (see `settled`). */
  start(): Promise<void>
  /** Turns Superagent off; waits for a start in progress, which then opens nothing more. Never rejects. */
  stop(reason: StopReason): Promise<void>
  /** Resolves once the work `start()` began has finished, whatever its outcome. */
  settled(): Promise<void>
  status(): LifecycleStatus
  /** Removes the workspace registration of a ticket that ended. */
  ticketEnded(ticketId: string): Promise<void>
}

/** Session operations the session adapter does not cover, done with the owner-level SDK client. */
export interface SessionControl {
  /** Runs a pending item now: after a daemon restart nothing resumes queued inputs on its own. */
  sendNow(sessionId: string, itemId: string): Promise<void>
  /** Kills the session's running agent jobs and returns how many it killed. */
  killAgentJobs(sessionId: string): Promise<number>
  /** Removes the registrations of those of `dirs` registered as workspaces; returns how many it removed. */
  removeWorkspaces(dirs: readonly string[]): Promise<number>
}

/** Where the agent environment goes and what it holds. */
export interface EnvironmentPlan {
  home: string
  shimsDir: string
  config: EnvironmentConfig
}

export interface LifecycleDeps {
  store: Store
  sessions: SessionAdapter
  control: SessionControl
  hooks: HookStateCell
  /** The snapshot the hooks read once the reconcile registered `sessionIds`. */
  hookState(sessionIds: ReadonlySet<string>): HookState
  /** The agent environment to write. @throws SetupError when the configuration is incomplete or an account check fails. */
  environment(): Promise<EnvironmentPlan>
  createApp(): SuperagentApp
  log?: { warn(message: string): void }
  writeEnvironment?: typeof writeEnvironment
  verifyEnvironment?: (home: string, shimsDir: string, cfg: { login: string }) => Promise<void>
  archive?: (store: Store, now: number) => { archived: number }
  now?: () => number
}

const ARCHIVE_EVERY_MS = 24 * 3600_000
/** Deliveries carry this command-id prefix; anything else in a Session's inbox someone else queued. */
const DELIVERY_PREFIX = 'superagent:'
const WORKER_PREFIX = 'superagent:worker:'
/** Codes that mean "not configured yet" rather than "configured wrong". */
const UNCONFIGURED: ReadonlySet<SetupCode> = new Set(['repositoryUnset', 'agentCliUnset'])
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A snapshot that counts `sessionIds` and their child sessions (`<parent>/<id>`) as Superagent's, and adds nothing else. */
export function sessionsOnly(sessionIds: ReadonlySet<string>): HookState {
  const ids = new Set(sessionIds)
  return {
    isSuperagentSession: (id) => ids.has(id) || [...ids].some((parent) => id.startsWith(`${parent}/`)),
    promptSections: () => ({ stable: [] }),
    guardTool: () => undefined,
  }
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const { store, sessions, control, hooks } = deps
  const now = deps.now ?? Date.now
  const archive = deps.archive ?? archiveExpired
  const warn = (text: string) => deps.log?.warn(text)
  let status: LifecycleStatus = { state: 'stopped' }
  let work: Promise<void> | undefined
  let app: SuperagentApp | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let stopping = false

  const ticketOf = (sessionId: string): Ticket | undefined =>
    sessionId.startsWith(WORKER_PREFIX) ? store.tickets.get(sessionId.slice(WORKER_PREFIX.length)) : undefined

  /** Archives expired records and drops the workspace registrations of ended tickets; never throws. */
  const upkeep = async (): Promise<void> => {
    try {
      archive(store, now())
    } catch (error) {
      warn(`Superagent could not archive expired records: ${message(error)}`)
    }
    const dirs = store.tickets
      .list()
      .filter((ticket) => !liveTicket(ticket) && ticket.execution?.directory)
      .map((ticket) => ticket.execution!.directory)
    if (dirs.length)
      await control.removeWorkspaces(dirs).catch((error: unknown) => {
        warn(`Superagent could not remove the workspaces of ended tickets: ${message(error)}`)
      })
  }

  /**
   * Reconciles one Session by its real state. A running turn is left alone. When the ticket's running assignment would
   * restart, the inputs queued behind the aborted turn are dropped — the restart puts back what no step took and delivers
   * it again — and the Engine re-dispatches it once with a recovery note. Otherwise the oldest queued input is run: nothing
   * resumes it after a daemon restart. A worker with nothing queued gets its waiting inputs flushed.
   */
  const reconcile = async (running: SuperagentApp, sessionId: string): Promise<void> => {
    const state = await sessions.state(sessionId)
    if (state.running) return
    const ticket = ticketOf(sessionId)
    const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
    if (ticket && assignment && interruptionRestarts(assignment)) {
      const superseded = state.pending
        .filter((item) => item.commandId?.startsWith(DELIVERY_PREFIX))
        .map((item) => item.itemId)
      if (superseded.length) await sessions.dropPending(sessionId, superseded)
      running.engine.assignmentInterrupted(ticket.id, assignment.id)
    } else if (state.pending.length) {
      await control.sendNow(sessionId, state.pending[0]!.itemId)
    } else if (ticket && assignment) {
      running.engine.assignmentInterrupted(ticket.id, assignment.id)
    }
  }

  const open = async (): Promise<void> => {
    // Nothing of the start runs before `start()` has returned and its caller has gone on.
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      const plan = await deps.environment()
      if (stopping) return
      await (deps.writeEnvironment ?? writeEnvironment)(plan.home, plan.shimsDir, plan.config)
      if (stopping) return
      await (deps.verifyEnvironment ?? verifyEnvironment)(plan.home, plan.shimsDir, {
        login: plan.config.login,
      })
      if (stopping) return
      const started = deps.createApp()
      app = started
      await started.start()
      if (stopping) return
      const ids = started.executor.sessionIds()
      for (const id of ids) {
        if (stopping) return
        try {
          await reconcile(started, id)
        } catch (error) {
          warn(`Superagent could not reconcile session ${id}: ${message(error)}`)
        }
      }
      store.delete(KV.runtime.paused)
      await upkeep()
      if (stopping) return
      timer = setInterval(() => void upkeep(), ARCHIVE_EVERY_MS)
      timer.unref?.()
      hooks.set(deps.hookState(new Set(ids)))
      status = { state: 'running' }
    } catch (error) {
      if (error instanceof SetupError)
        status = {
          state: UNCONFIGURED.has(error.code) ? 'setupRequired' : 'setupFailed',
          problem: error.problem,
        }
      else status = { state: 'failed', detail: message(error) }
    }
  }

  /** Empties a Session's inbox, cancels its turn and kills its agent jobs; on `keepPending` its inbox stays. */
  const quiet = async (sessionId: string, keepPending: boolean): Promise<void> => {
    const drop = async (pending: { itemId: string }[]) => {
      if (!keepPending && pending.length)
        await sessions.dropPending(
          sessionId,
          pending.map((item) => item.itemId),
        )
    }
    const state = await sessions.state(sessionId)
    await drop(state.pending)
    if (state.running) await sessions.cancel(sessionId)
    await control.killAgentJobs(sessionId)
    // A cancel hands steers back to the inbox, which must not run either.
    if (!keepPending) await drop((await sessions.state(sessionId)).pending)
  }

  return {
    async start() {
      if (work) return
      stopping = false
      status = { state: 'starting' }
      work = open()
    },
    async stop(reason) {
      stopping = true
      await work
      work = undefined
      if (timer) clearInterval(timer)
      timer = undefined
      const running = app
      app = undefined
      if (!running) {
        hooks.clear()
        status = { state: 'stopped' }
        return
      }
      status = { state: 'stopping' }
      const ids = running.executor.sessionIds()
      await running.stop(reason).catch((error: unknown) => {
        warn(`Superagent could not stop polling and sending: ${message(error)}`)
      })
      for (const id of ids)
        await quiet(id, reason === 'shutdown').catch((error: unknown) => {
          warn(`Superagent could not stop session ${id}: ${message(error)}`)
        })
      const paused = store.tickets.open().flatMap((ticket) => {
        const assignment = runningAssignment(ticket)
        return assignment ? [{ ticketId: ticket.id, assignmentId: assignment.id }] : []
      })
      try {
        store.set(KV.runtime.paused, { at: new Date(now()).toISOString(), reason, assignments: paused })
      } catch (error) {
        warn(`Superagent could not record the pause: ${message(error)}`)
      }
      hooks.clear()
      status = { state: 'stopped' }
    },
    async settled() {
      await work
    },
    status: () => status,
    async ticketEnded(ticketId) {
      const ticket = store.tickets.get(ticketId)
      const dir = ticket && !liveTicket(ticket) ? ticket.execution?.directory : undefined
      if (dir) await control.removeWorkspaces([dir])
    },
  }
}

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** The session operations, done with the owner-level SDK client the bundled-app grant carries. */
export function sdkSessionControl(client: SdkClient): SessionControl {
  return {
    async sendNow(sessionId, itemId) {
      const session = await client.session.open(sessionId)
      // A fixed command id: a retried resume of the same item runs it once.
      await session.sendNow(itemId, { commandId: `${DELIVERY_PREFIX}resume:${itemId}`.slice(0, 128) })
    },
    async killAgentJobs(sessionId) {
      const session = await client.session.open(sessionId)
      const { jobs } = await session.jobsRead()
      const running = jobs.filter((job) => job.owner === 'agent' && job.status === 'running')
      for (const job of running) await session.jobsControl({ operation: 'kill', jobId: job.id })
      return running.length
    },
    async removeWorkspaces(dirs) {
      const wanted = new Set(dirs.map(real))
      const { items } = await client.workspace.list()
      let removed = 0
      for (const item of items) {
        if (!item.workspaceId || !wanted.has(real(item.path))) continue
        const result = await client.call<{ removed: boolean }>('_agnes/v1/workspace.remove', {
          workspaceId: item.workspaceId,
          ...(item.revision ? { expectedRevision: item.revision } : {}),
        })
        if (result.removed) removed++
      }
      return removed
    },
  }
}
