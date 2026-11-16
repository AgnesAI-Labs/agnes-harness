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
import { archiveExpired, retiredTickets } from '../app/store-retention.js'
import { setAgentVariables } from '../app/subprocess.js'
import { interruptionRestarts } from '../core/assignments.js'
import { liveTicket, runningAssignment, type Ticket } from '../core/index.js'
import { HOST_PLATFORM } from '../infra/platform.js'
import { KV, type Paused } from '../kv.js'
import { type SetupCode, SetupError, type SetupProblem } from '../setup.js'
import type { SessionAdapter, SuperagentApp } from './contracts.js'
import {
  agentCommandVariables,
  type EnvironmentConfig,
  verifyEnvironment,
  writeEnvironment,
} from './environment.js'
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
  /**
   * Called when a ticket ends. An ended ticket keeps its workspace and Session, since a person's reply resumes it there;
   * this removes the registration only once retention has archived its conversation (see `retiredTickets`), as the
   * daily pass does.
   */
  ticketEnded(ticketId: string): Promise<void>
  /**
   * Checks the setup again, as "check again" in the panel and a saved GitHub Source ask: a start that waits for setup or
   * failed runs again, from the agent environment on; a running app resolves its deployment again. Returns at once.
   */
  recheck(): void
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

/**
 * The agent environment to write: the state directory, which fixes where it goes (`worker-bin` and `worker-gitconfig`
 * in it), and the agent account it is written for.
 */
export interface EnvironmentPlan {
  stateDir: string
  account: EnvironmentConfig
}

export interface LifecycleDeps {
  store: Store
  sessions: SessionAdapter
  control: SessionControl
  hooks: HookStateCell
  /** The snapshot the hooks read once the reconcile has read `sessionIds`, before it acts on any of them. */
  hookState(sessionIds: ReadonlySet<string>): HookState
  /**
   * The Superagent session ids refused while Superagent starts or cannot (see `refusingSessions`); by default those the
   * store knows (`storedSessionIds`).
   */
  registeredSessions?: () => string[]
  /**
   * What the hooks read while Superagent starts and until its reconcile has read the sessions: Superagent's sessions
   * refused, each keeping its live note. By default `refusingSessions` over `registeredSessions`.
   */
  startingState?(): HookState
  /** What the hooks read while Superagent cannot start: its sessions refused for `reason`, each keeping its live note. */
  refusingState?(reason: string): HookState
  /**
   * The agent environment to write. `signal` aborts when the runtime stops during the start.
   * @throws SetupError when the configuration is incomplete or an account check fails.
   */
  environment(signal: AbortSignal): Promise<EnvironmentPlan>
  createApp(signal: AbortSignal): SuperagentApp
  log?: { warn(message: string): void }
  writeEnvironment?: typeof writeEnvironment
  verifyEnvironment?: (
    stateDir: string,
    cfg: { login: string; cli?: string },
    signal: AbortSignal,
  ) => Promise<void>
  archive?: (store: Store, now: number) => { archived: number }
  now?: () => number
  /** The operating system, this process's by default; the agent environment is written and checked for it. */
  platform?: string
  /**
   * How long a stop may take in all, below the Host's shutdown deadline: cancelling and killing come first, then the wait
   * for an aborted start, the app's drain and anything else get what is left.
   */
  stopBudgetMs?: number
  /**
   * The pauses before each new attempt of a start that failed for a reason other than its setup, such as its daemon
   * client not yet reaching a daemon that has just restarted; the last pause repeats. A setup problem waits for a recheck.
   */
  retryDelaysMs?: readonly number[]
}

const ARCHIVE_EVERY_MS = 24 * 3600_000
/** A failed start is tried again after these pauses, then every 30 s while it keeps failing. */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000]
/** Below the 5 s shutdown deadline the manifest declares, with room for the Host's own steps. */
const STOP_BUDGET_MS = 4_000
/** The pause between passes over one Session in a stop. */
const QUIET_PAUSE_MS = 150
/** Kept back from a stop's budget for each Session's last kill sweep. */
const FINAL_SWEEP_MS = 250
/** How long a stop waits for an aborted start to notice before it goes on. */
const START_ABORT_WAIT_MS = 500

/** `promise`, or nothing once `ms` passed; it never rejects. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    promise.then(
      () => {},
      () => {},
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    }),
  ])
  clearTimeout(timer)
}
/** Deliveries carry this command-id prefix; anything else in a Session's inbox someone else queued. */
const DELIVERY_PREFIX = 'superagent:'
const WORKER_PREFIX = 'superagent:worker:'
/** Codes that mean "not configured yet" rather than "configured wrong". */
const UNCONFIGURED: ReadonlySet<SetupCode> = new Set(['repositoryUnset', 'agentCliUnset'])
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const ORCHESTRATOR_KEY = 'superagent:orchestrator'
const STARTING = 'Superagent is starting; its sessions wait until it is ready'

/**
 * The ids of the Superagent sessions the store knows: the main session (by its recorded id and its key) and each
 * ticket's worker, ended ones included, since a person's reply can resume them.
 */
export function storedSessionIds(store: Store): string[] {
  const master = store.get(KV.runtime.masterId)
  return [
    ...new Set([
      ORCHESTRATOR_KEY,
      ...(master ? [master] : []),
      ...store.tickets.list().map((ticket) => `${WORKER_PREFIX}${ticket.id}`),
    ]),
  ]
}

const isWithin = (ids: ReadonlySet<string>, id: string): boolean =>
  ids.has(id) || [...ids].some((parent) => id.startsWith(`${parent}/`))

/** A snapshot that counts `sessionIds` and their children as Superagent's and refuses every tool they call for `reason`. */
export function refusingSessions(sessionIds: ReadonlySet<string>, reason: string): HookState {
  const ids = new Set(sessionIds)
  return {
    isSuperagentSession: (id) => isWithin(ids, id),
    promptSections: () => ({ stable: [] }),
    guardTool: ({ sessionId }) => (isWithin(ids, sessionId) ? reason : undefined),
  }
}

/** A snapshot that counts `sessionIds` and their child sessions (`<parent>/<id>`) as Superagent's, and adds nothing else. */
export function sessionsOnly(sessionIds: ReadonlySet<string>): HookState {
  const ids = new Set(sessionIds)
  return {
    isSuperagentSession: (id) => isWithin(ids, id),
    promptSections: () => ({ stable: [] }),
    guardTool: () => undefined,
  }
}

/**
 * Empties a Session's inbox, cancels its turn and kills its agent jobs, and checks again: a cancel hands steers back
 * to the inbox, where the daemon may start one as a new turn, and a turn winding down may still start a job. Passes
 * repeat, a pause apart, until no turn runs, no job runs, (unless `keepPending`) nothing waits and the cancel returned,
 * or until `deadline`. Either way a last kill sweep follows, so a job the turn started while it wound down is killed
 * too. The cancel is sent whatever the state says, since a turn parked on an approval reads as not running, and it is
 * never awaited before the kill: killing the jobs, the turn's own command among them, is what lets a turn held up by
 * that command wind down. False when the session was not confirmed quiet by the deadline.
 */
async function quiet(
  sessions: SessionAdapter,
  control: SessionControl,
  sessionId: string,
  keepPending: boolean,
  deadline: number,
): Promise<boolean> {
  /** A cancel in flight: it returns only once the turn wound down, which a running command can hold up. */
  let cancelling: Promise<void> | undefined
  const returned = () => {
    cancelling = undefined
  }
  const sweep = () => control.killAgentJobs(sessionId)
  for (let pass = 0; ; pass++) {
    const state = await sessions.state(sessionId)
    const settled = !state.running && state.jobs === 0 && (keepPending || state.pending.length === 0)
    if (pass > 0 && settled && !cancelling && (await sweep()) === 0) return true
    if (pass > 0 && Date.now() >= deadline) return (await sweep()) === 0 && settled
    if (!keepPending && state.pending.length)
      await sessions.dropPending(
        sessionId,
        state.pending.map((item) => item.itemId),
      )
    cancelling ??= sessions.cancel(sessionId).then(returned, returned)
    await sweep()
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Math.min(QUIET_PAUSE_MS, deadline - Date.now()))),
    )
  }
}

type SessionState = Awaited<ReturnType<SessionAdapter['state']>>

/**
 * The upkeep of the records: `retire` removes the workspace registrations of the tickets retention retired, which also
 * archives their Sessions, while an ended ticket that a person's reply can still resume keeps both; `upkeep` archives
 * expired records, then retires the tickets whose conversation that archived. Neither throws.
 */
function upkeepOf(deps: LifecycleDeps, now: () => number, warn: (text: string) => void) {
  const { store, control } = deps
  const archive = deps.archive ?? archiveExpired
  /** Directories whose registration this lifecycle already removed, so a daily pass does not ask again. */
  const retired = new Set<string>()
  const retire = async (tickets: readonly Ticket[]): Promise<void> => {
    const dirs = tickets.flatMap((ticket) => {
      const dir = ticket.execution?.directory
      return dir && !retired.has(dir) ? [dir] : []
    })
    if (!dirs.length) return
    try {
      await control.removeWorkspaces(dirs)
      for (const dir of dirs) retired.add(dir)
    } catch (error) {
      warn(`Superagent could not remove the workspaces of retired tickets: ${message(error)}`)
    }
  }
  const upkeep = async (): Promise<void> => {
    try {
      archive(store, now())
    } catch (error) {
      warn(`Superagent could not archive expired records: ${message(error)}`)
    }
    await retire(retiredTickets(store, now()))
  }
  return { upkeep, retire }
}

/**
 * Reconciles one Session from the state read for it before. A running turn is left alone. When the ticket's running
 * assignment would restart, the inputs queued behind the aborted turn are dropped — the restart puts back what no step
 * took and delivers it again — and the Engine re-dispatches it once with a recovery note. Otherwise the oldest queued
 * input is run: nothing resumes it after a daemon restart. A worker with nothing queued gets its waiting inputs flushed.
 */
async function reconcileSession(
  { store, sessions, control }: LifecycleDeps,
  running: SuperagentApp,
  sessionId: string,
  state: SessionState,
): Promise<void> {
  if (state.running) return
  const ticket = sessionId.startsWith(WORKER_PREFIX)
    ? store.tickets.get(sessionId.slice(WORKER_PREFIX.length))
    : undefined
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

/**
 * Stops every session in parallel, within `budgetMs` (see `quiet`), and returns those it did not confirm quiet: every
 * session counts as not stopped until its stop confirmed it quiet.
 */
async function quietAll(
  { sessions, control }: LifecycleDeps,
  ids: readonly string[],
  reason: StopReason,
  budgetMs: number,
  warn: (text: string) => void,
): Promise<string[]> {
  const unstopped = new Set(ids)
  const deadline = Date.now() + Math.max(0, budgetMs - FINAL_SWEEP_MS)
  await within(
    Promise.allSettled(
      ids.map((id) =>
        quiet(sessions, control, id, reason === 'shutdown', deadline).then(
          (done) => {
            if (done) unstopped.delete(id)
            else warn(`Superagent session ${id} is still running after the stop's ${budgetMs} ms`)
          },
          (error: unknown) => {
            warn(`Superagent could not stop session ${id}: ${message(error)}`)
          },
        ),
      ),
    ),
    budgetMs,
  )
  return [...unstopped]
}

/** Records the running assignments of open tickets as paused by this stop, and how the stop went; never throws. */
function recordPause(
  store: Store,
  reason: StopReason,
  at: number,
  stop: NonNullable<Paused['stop']>,
  warn: (text: string) => void,
): void {
  try {
    const assignments = store.tickets.open().flatMap((ticket) => {
      const assignment = runningAssignment(ticket)
      return assignment ? [{ ticketId: ticket.id, assignmentId: assignment.id }] : []
    })
    store.set(KV.runtime.paused, { at: new Date(at).toISOString(), reason, assignments, stop })
  } catch (error) {
    warn(`Superagent could not record the pause: ${message(error)}`)
  }
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const { store, sessions, control, hooks } = deps
  const now = deps.now ?? Date.now
  const warn = (text: string) => deps.log?.warn(text)
  let status: LifecycleStatus = { state: 'stopped' }
  let work: Promise<void> | undefined
  let app: SuperagentApp | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let stopping = false
  let aborter: AbortController | undefined
  /** The next attempt of a failed start, and how many attempts in a row have failed. */
  let retry: ReturnType<typeof setTimeout> | undefined
  let failures = 0

  const { upkeep, retire } = upkeepOf(deps, now, warn)
  const reconcile = (running: SuperagentApp, sessionId: string, state: SessionState) =>
    reconcileSession(deps, running, sessionId, state)

  /** Refuses the tools of every Superagent session the store knows, for `reason`; the owner's sessions are untouched. */
  const refuse = (reason: string): void => {
    if (deps.refusingState) {
      try {
        hooks.set(deps.refusingState(reason))
        return
      } catch (error) {
        warn(`Superagent could not read its sessions: ${message(error)}`)
      }
    }
    let ids: string[]
    try {
      ids = (deps.registeredSessions ?? (() => storedSessionIds(store)))()
    } catch (error) {
      warn(`Superagent could not list its sessions: ${message(error)}`)
      ids = [ORCHESTRATOR_KEY]
    }
    hooks.set(refusingSessions(new Set(ids), reason))
  }

  /** Refuses Superagent's sessions while it starts, until the reconcile has read them. */
  const holdWhileStarting = (): void => {
    if (deps.startingState) hooks.set(deps.startingState())
    else refuse(STARTING)
  }
  /** Reports a started app that waits for setup; its sessions stay refused and nothing is reconciled until it is set up. */
  const waitForSetup = (problem: SetupProblem): void => {
    const unconfigured = UNCONFIGURED.has(problem.code)
    status = { state: unconfigured ? 'setupRequired' : 'setupFailed', problem }
    refuse(`${unconfigured ? 'Superagent is not set up' : 'Superagent cannot start'}: ${problem.detail}`)
  }
  /** The app this lifecycle started; a recheck reconfigures it instead of starting it again. */
  let begun: SuperagentApp | undefined

  const open = async (signal: AbortSignal): Promise<void> => {
    // Nothing of the start runs before `start()` has returned and its caller has gone on.
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      if (stopping) return
      const platform = deps.platform ?? HOST_PLATFORM
      const plan = await deps.environment(signal)
      if (stopping) return
      await (deps.writeEnvironment ?? writeEnvironment)(plan.stateDir, plan.account, platform)
      if (stopping) return
      const verify =
        deps.verifyEnvironment ??
        ((dir: string, cfg: { login: string; cli?: string }, s: AbortSignal) =>
          verifyEnvironment(dir, cfg, process.env, s, platform))
      await verify(
        plan.stateDir,
        { login: plan.account.login, ...(plan.account.cli ? { cli: plan.account.cli } : {}) },
        signal,
      )
      if (stopping) return
      // The runtime's own git, gh and prepare commands act as the agent too.
      setAgentVariables(agentCommandVariables(plan.stateDir, process.env.PATH ?? '', platform))
      // `stopping` is checked right before, and nothing awaits in between: a stop either sees this app or none.
      const started = deps.createApp(signal)
      app = started
      if (begun === started) await started.reconfigure?.()
      else {
        begun = started
        await started.start()
      }
      if (stopping) return
      // A start can end in setup without failing, such as when another session holds the main session's key.
      const problem = started.setupProblem?.()
      if (problem) return waitForSetup(problem)
      const ids = started.executor.sessionIds()
      // Read every Session first, while they are still refused; then guard them before anything runs in one.
      const states = new Map<string, SessionState>()
      for (const id of ids) {
        if (stopping) return
        try {
          states.set(id, await sessions.state(id))
        } catch (error) {
          warn(`Superagent could not read session ${id}: ${message(error)}`)
        }
      }
      if (stopping) return
      hooks.set(deps.hookState(new Set(ids)))
      for (const [id, state] of states) {
        if (stopping) return
        try {
          await reconcile(started, id, state)
        } catch (error) {
          warn(`Superagent could not reconcile session ${id}: ${message(error)}`)
        }
      }
      store.delete(KV.runtime.paused)
      await upkeep()
      if (stopping) return
      timer = setInterval(() => void upkeep(), ARCHIVE_EVERY_MS)
      timer.unref?.()
      status = { state: 'running' }
      failures = 0
    } catch (error) {
      if (stopping) return
      if (error instanceof SetupError) {
        const unconfigured = UNCONFIGURED.has(error.code)
        status = { state: unconfigured ? 'setupRequired' : 'setupFailed', problem: error.problem }
        refuse(`${unconfigured ? 'Superagent is not set up' : 'Superagent cannot start'}: ${error.message}`)
      } else {
        status = { state: 'failed', detail: message(error) }
        refuse(`Superagent cannot start: ${message(error)}`)
        retryLater()
      }
    }
  }
  /**
   * Tries a start that failed for a reason other than its setup again after the next pause, as a recheck does: right
   * after a daemon restart its client may not reach the daemon yet, and nothing else would start Superagent again.
   */
  function retryLater(): void {
    const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS
    const delay = delays[Math.min(failures, delays.length - 1)] ?? 30_000
    failures++
    clearTimeout(retry)
    retry = setTimeout(() => {
      retry = undefined
      recheck()
    }, delay)
    retry.unref?.()
  }
  function recheck(): void {
    if (!work || stopping || !aborter) return
    if (status.state === 'running') {
      void app?.reconfigure?.().catch((error: unknown) => {
        warn(`Superagent could not check its setup again: ${message(error)}`)
      })
      return
    }
    if (status.state !== 'setupRequired' && status.state !== 'setupFailed' && status.state !== 'failed')
      return
    // This attempt replaces a pending one.
    clearTimeout(retry)
    retry = undefined
    status = { state: 'starting' }
    holdWhileStarting()
    work = open(aborter.signal)
  }

  return {
    async start() {
      if (work) return
      stopping = false
      failures = 0
      status = { state: 'starting' }
      holdWhileStarting()
      aborter = new AbortController()
      work = open(aborter.signal)
    },
    recheck,
    /**
     * Within `stopBudgetMs`: abort a start in progress, stop polling and sending at once, then cancel, kill and empty
     * every Session in parallel — the part that keeps a worker from acting after a disable — and only then wait for an
     * aborted start and for the app's drain with whatever budget is left.
     */
    async stop(reason) {
      const began = Date.now()
      const left = () => Math.max(0, (deps.stopBudgetMs ?? STOP_BUDGET_MS) - (Date.now() - began))
      stopping = true
      aborter?.abort()
      if (timer) clearInterval(timer)
      timer = undefined
      clearTimeout(retry)
      retry = undefined
      setAgentVariables(undefined)
      // A start past `createApp` already holds the app; an earlier one opens nothing more once it sees `stopping`.
      const starting = work
      work = undefined
      if (starting && !app) await within(starting, Math.min(START_ABORT_WAIT_MS, left()))
      const running = app
      app = undefined
      if (!running) {
        hooks.clear()
        status = { state: 'stopped' }
        return
      }
      status = { state: 'stopping' }
      let ids: string[] = []
      try {
        running.stopSignal(reason)
      } catch (error) {
        warn(`Superagent could not stop polling and sending: ${message(error)}`)
      }
      try {
        ids = running.executor.sessionIds()
      } catch (error) {
        warn(`Superagent could not list its sessions: ${message(error)}`)
      }
      const unstopped = await quietAll(deps, ids, reason, left(), warn)
      recordPause(store, reason, now(), { ms: Date.now() - began, sessions: ids.length, unstopped }, warn)
      hooks.clear()
      await within(
        Promise.resolve().then(() => running.drain()),
        left(),
      )
      if (starting) await within(starting, left())
      status = { state: 'stopped' }
    },
    async settled() {
      await work
    },
    status: () => status,
    async ticketEnded(ticketId) {
      await retire(retiredTickets(store, now()).filter((ticket) => ticket.id === ticketId))
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
