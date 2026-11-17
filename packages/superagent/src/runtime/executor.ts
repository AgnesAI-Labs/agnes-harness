// Adapted from dsh-superagent (MIT)
/**
 * The engine's executor on AGH: one persistent worker session and ticket directory per ticket. Launches and input
 * deliveries run through the effect queue; worker slots bound how many workers run; each worker session's events (turn
 * start and end, the messages it took) report back to the engine. A worker's jobs, shell jobs and subagents alike, keep its
 * slot after its turn ends until they end.
 */
import { stat } from 'node:fs/promises'
import { type Effects, Later } from '../app/effects.js'
import type { Variable } from '../app/execution-environment.js'
import { ASSIGNMENT_CHARS, batchLine, capped, inputResource, triggerMessage } from '../app/messages.js'
import { resultRelay } from '../app/notices.js'
import type { Store } from '../app/store.js'
import {
  type AssessmentOutcome,
  type Assignment,
  type EngineForExecutor,
  type Executor,
  key,
  latestAssignment,
  latestReport,
  liveTicket,
  runningAssignment,
  type Ticket,
  type TicketInput,
  type Trigger,
  waitsForPerson,
} from '../core/index.js'
import type { HealthEntry } from '../infra/health.js'
import {
  batchOf,
  fromPerson,
  inputMessage,
  RETRIED,
  sourceTrigger,
  ticketExecution,
  transient,
  turnError,
} from './assignment.js'
import { messageOfCommand, type Redelivery } from './delivery.js'
import { DeliveryStalls } from './delivery-stalls.js'
import {
  PrepareFailed,
  type SessionAdapter,
  type SessionHandle,
  type SessionJob,
  type SessionRegistry,
  sessionMissing,
  workerKey,
} from './sessions.js'

const now = (): string => new Date().toISOString()
/** Maximum transient retry attempts for a launch or worker turn, and the initial backoff before resuming a turn. */
const TRANSIENT_TRIES = 3
const TRANSIENT_BACKOFF_MS = 15_000
/** How long a worker's jobs may run on after its turn ended before they are killed and the worker reported waiting. */
const BACKGROUND_LIMIT_MS = 30 * 60_000
/** How often a worker whose turn ended is looked at for running jobs. */
const QUIET_POLL_MS = 2000
/** How long a worker that goes on after a passing failure waits for a slot, or for processing to resume, between looks. */
const SLOT_WAIT_MS = 5000
/** The id of the message delivered under a request id; each delivery attempt of it has its own command id. */
export const messageIdOf = (requestId: string): string => key(requestId)

/** What the executor uses of the sessions besides the frozen adapter. */
export interface ExecutorSessions extends SessionAdapter {
  readonly registry: Pick<SessionRegistry, 'ids'>
  handle(sessionId: string): Promise<SessionHandle>
  /** Forgets a session's handle so the next use loads it again. */
  forget(sessionId: string): void
  jobs(sessionId: string, except?: ReadonlySet<string>): Promise<SessionJob[]>
  killJobs(sessionId: string, except?: ReadonlySet<string>): Promise<void>
  transcript(sessionId: string): Promise<{ type: 'user' | 'assistant'; text: string }[]>
}
export interface ExecutorHost {
  readonly engine: Pick<
    EngineForExecutor,
    | 'assignmentStarted'
    | 'inputsDelivered'
    | 'inputsRead'
    | 'turnEnded'
    | 'deliveryFailed'
    | 'report'
    | 'assignmentInterrupted'
  >
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings' | 'atomic' | 'afterCommit'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** The `worker` health entry, which reports whether handling worker events failed. */
  readonly health: HealthEntry
  /** The `models` health entry, which reports workers waiting out a passing model failure. */
  readonly models?: HealthEntry
  /** The `deliveries` health entry, which names tickets whose launch keeps waiting to confirm a delivery. */
  readonly deliveries?: HealthEntry
  readonly stateDir: string
  readonly lifetime: AbortSignal
  readonly sessions: ExecutorSessions
  readonly delivery: Redelivery
  /** Steers a report into the main session once per id. */
  relay(id: string, text: string): void
  closing(): boolean
  /** Whether processing is paused, which holds launches and input deliveries. */
  paused(): boolean
  environment(ticket: Ticket): Variable[]
  sourceLink(
    trigger: Trigger,
    signal?: AbortSignal,
  ): Promise<{ source_url?: string; source_url_read?: string }>
  repliedTo(trigger: Trigger): Trigger | undefined
}

/**
 * Tracks running and starting workers against the configured limit: a ticket holds a slot while its worker's turn runs,
 * while its jobs run after that turn, and while a launch or wake starts it. A wake for a person's message may take one
 * slot beyond the limit, so a person never waits behind new launches.
 */
export class WorkerSlots {
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  constructor(
    private readonly running: () => string[],
    private readonly max: () => number,
  ) {}
  used(): number {
    return new Set([...this.running(), ...this.starting.keys()]).size
  }
  launches(): number {
    const wakes = [...this.starting].flatMap(([ticketId, by]) => (by !== 'launch' ? [ticketId] : []))
    return this.max() - new Set([...this.running(), ...wakes]).size
  }
  /** @throws Later when no slot is free. */
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.starting.has(ticketId)) return
    if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later('No worker slot is free')
    this.starting.set(ticketId, by)
  }
  free(ticketId: string): void {
    this.starting.delete(ticketId)
  }
}

type LedgerEvent = { type: string; data?: unknown }
/** A worker waiting out a passing model failure: the ticket cards' `model_retry`. */
export interface ModelRetry {
  sessionId: string
  /** AGH's error code of the last failed turn, such as `RATE_LIMIT`. */
  code: string
  attempts: number
  since: string
  lastAt: string
}

/**
 * The engine's `Executor` port: queues launches and deliveries through the effects, holds worker slots, and reports what
 * its workers' sessions do back to the engine.
 */
export class SuperagentExecutor implements Executor {
  private readonly slots: WorkerSlots
  /** Sessions whose turn runs, from their events. */
  private readonly busy = new Set<string>()
  /** The event readers of watched worker sessions. */
  private readonly watched = new Map<string, { stop(): void }>()
  private readonly transient = new Map<string, number>()
  private readonly resuming = new Set<string>()
  /** The looks at the jobs of workers whose turn ended, by ticket, which hold their slots. */
  private readonly settling = new Map<string, AbortController>()
  /** The stops of tickets' background work that run, which a launch or a delivery of the ticket waits for. */
  private readonly stopping = new Map<string, Promise<void>>()
  /** The jobs workers left to a person when they handed off, by ticket. */
  private readonly left = new Map<string, Set<string>>()
  /** When a person's message typed into a worker's session last started a turn, by ticket. */
  private readonly personal = new Map<string, string>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** The workers that wait out a passing model failure, by session. */
  private readonly modelRetries = new Map<string, ModelRetry>()
  private readonly stalls: DeliveryStalls
  constructor(private readonly host: ExecutorHost) {
    this.stalls = new DeliveryStalls(host.deliveries)
    this.slots = new WorkerSlots(
      () =>
        host.store.tickets
          .open()
          .filter((ticket) => this.running(ticket))
          .map((ticket) => ticket.id),
      () => host.store.settings().executor.maxWorkers,
    )
    host.effects.handle('launch', (payload) => this.launchQueued(payload), {
      limit: () => (host.paused() ? 0 : this.slots.launches()),
      retry: [5000, 300_000],
    })
    host.effects.handle('delivery', (payload) => this.deliverQueued(payload.ticketId), {
      limit: () => (host.paused() ? 0 : 4),
      quiet: true,
    })
  }
  /** `{ model_retry }` while the session's worker waits out a passing model failure, else `{}`. */
  modelRetry(sessionId: string | false | undefined): { model_retry?: ModelRetry } {
    const retry = sessionId ? this.modelRetries.get(sessionId) : undefined
    return retry ? { model_retry: { ...retry } } : {}
  }
  /** Every worker that waits out a passing model failure. */
  waitingModels(): ModelRetry[] {
    return [...this.modelRetries.values()].map((retry) => ({ ...retry }))
  }
  private retried(sessionId: string, code: string | undefined, attempts: number | undefined): void {
    const at = now()
    if (attempts === undefined) this.modelRetries.delete(sessionId)
    else
      this.modelRetries.set(sessionId, {
        sessionId,
        code: code ?? 'error',
        attempts,
        since: this.modelRetries.get(sessionId)?.since ?? at,
        lastAt: at,
      })
    const retries = [...this.modelRetries.values()]
    this.host.models?.set(
      retries.length
        ? {
            state: 'error',
            detail: retries
              .slice(0, 5)
              .map(
                (item) =>
                  `${item.sessionId}: ${item.code}, retried ${item.attempts} times, waiting since ${item.since}`,
              )
              .join('; '),
            at,
          }
        : { state: 'ready', detail: 'No worker is waiting out a passing model failure', at },
    )
  }
  /** The ids of Superagent's sessions that exist: the main session and each ticket's worker. */
  sessionIds(): string[] {
    return this.host.sessions.registry.ids()
  }
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return {
      ...ticket,
      execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.stateDir),
    }
  }
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  deliver(ticket: Ticket, _assignment: Assignment): void {
    this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id })
  }
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }) {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending')
      return
    this.slots.reserve(ticketId, 'launch')
    try {
      await this.launch(ticket, assignment)
      this.transient.delete(`launch:${assignmentId}`)
    } catch (error) {
      // A stop or pause puts the launch back; a passing failure retries with backoff; a failed prepare command fails
      // the ticket, as its directory now counts as prepared.
      if (this.host.closing() || error instanceof Later) throw error
      if (!(error instanceof PrepareFailed) && this.retries(`launch:${assignmentId}`, error)) throw error
      this.launchFailed(ticketId, assignmentId, error)
    } finally {
      this.slots.free(ticketId)
    }
  }
  /** Delivers queued inputs one by one, re-reading the ticket before each so delivery stops once it ended. */
  private async deliverQueued(ticketId: string): Promise<void> {
    await this.stopped(ticketId)
    const first = this.host.store.tickets.get(ticketId)
    const target = first && liveTicket(first) ? runningAssignment(first) : undefined
    if (!first || !target || !first.undelivered.length) return
    let woken = false
    try {
      for (;;) {
        const ticket = this.host.store.tickets.get(ticketId)
        const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
        const inputId = ticket?.undelivered[0]
        if (!ticket || !assignment || inputId === undefined) return
        if (!woken && !this.running(ticket)) {
          const person = ticket.undelivered.some((id) =>
            fromPerson(ticket.inputs.find((item) => item.id === id)),
          )
          this.slots.reserve(ticketId, person ? 'person' : 'wake')
          woken = true
        }
        const input = ticket.inputs.find((item) => item.id === inputId)
        this.watch(workerKey(ticketId), ticketId)
        try {
          if (input) await this.reopening(ticket, () => this.deliverInput(ticket, assignment, input))
        } catch (error) {
          if (this.host.closing() || error instanceof Later) throw error
          const current = this.host.store.tickets.get(ticketId)
          if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
          throw error
        }
        this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
      }
    } finally {
      if (woken) this.slots.free(ticketId)
    }
  }
  /** Runs `work` on the ticket's worker session, opening the session again once when its owner deleted it. */
  private async reopening(ticket: Ticket, work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch (error) {
      const directory = ticket.execution?.directory
      if (!sessionMissing(error) || !directory) throw error
      const sessionId = workerKey(ticket.id)
      this.host.sessions.forget(sessionId)
      this.watched.get(sessionId)?.stop()
      this.watched.delete(sessionId)
      await this.host.sessions.ensureWorker(ticket, directory)
      this.watch(sessionId, ticket.id)
      await work()
    }
  }
  private async deliverInput(ticket: Ticket, assignment: Assignment, input: TicketInput): Promise<void> {
    const live = () => {
      const current = this.host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id)
        throw new Error('The ticket ended or another Assignment took it over')
      if (this.stopping.has(ticket.id)) throw new Later("The worker's background work is stopping")
    }
    live()
    const trigger =
      input.kind === 'trigger' ? await this.triggerCard(ticket, input.triggerId, input.note) : undefined
    const message = inputMessage(input, trigger)
    if (message === undefined) return
    const text =
      message.length > ASSIGNMENT_CHARS
        ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id)))
        : message
    await this.send(workerKey(ticket.id), input.id, text, 'steer', live)
  }
  /** Delivers once per request id, after `authorize` re-checks that the delivery still applies. */
  private async send(
    sessionId: string,
    requestId: string,
    text: string,
    mode: 'steer' | 'followUp',
    authorize?: () => void,
  ): Promise<void> {
    this.host.lifetime.throwIfAborted()
    authorize?.()
    await this.host.delivery.deliver(sessionId, { id: messageIdOf(requestId), content: text, mode })
  }
  private async holds(sessionId: string, requestId: string): Promise<boolean> {
    const status = await this.host.delivery.status(sessionId, messageIdOf(requestId))
    if (status === 'unknown') throw new Error(`Whether ${sessionId} holds ${requestId} cannot be read`)
    return status !== 'absent'
  }
  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen =
      parent &&
      (parent.id === ticket.origin.triggerId ||
        ticket.inputs.some((item) => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }
  /**
   * After the ending transaction commits: ends the look at its jobs, cancels its turn unless its last word was a `ready`
   * or `dropped` report with no input delivered since, and kills its jobs, including those it left to a person.
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.transient.delete(assignment.id)
    this.transient.delete(`launch:${assignment.id}`)
    const report = assignment.report
    const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy
    const sessionId = workerKey(ticket.id)
    this.host.store.afterCommit(() => {
      if (this.modelRetries.has(sessionId)) this.retried(sessionId, undefined, undefined)
      this.settling.get(ticket.id)?.abort()
      const cancel =
        ownTurn || !this.busy.has(sessionId) ? Promise.resolve() : this.host.sessions.cancel(sessionId)
      this.track(
        ticket.id,
        cancel.then(() => this.host.sessions.killJobs(sessionId)),
      )
      this.left.delete(ticket.id)
      this.personal.delete(ticket.id)
      void reason
    })
  }
  private track(ticketId: string, stop: Promise<void>): void {
    const entry: Promise<void> = Promise.all([this.stopping.get(ticketId), stop.catch(() => {})])
      .then(() => {})
      .finally(() => {
        if (this.stopping.get(ticketId) === entry) this.stopping.delete(ticketId)
      })
    this.stopping.set(ticketId, entry)
    void this.background(stop)
  }
  private async stopped(ticketId: string): Promise<void> {
    const stopping = this.stopping.get(ticketId)
    if (stopping) await until(stopping, this.host.lifetime)
  }
  activeCount(): number {
    return this.host.store.tickets.open().filter((ticket) => this.running(ticket)).length
  }
  private running(ticket: Ticket): boolean {
    if (!runningAssignment(ticket)) return false
    return this.busy.has(workerKey(ticket.id)) || this.settling.has(ticket.id)
  }
  private launchFailed(ticketId: string, assignmentId: string, error: unknown): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    this.failed(ticketId, error instanceof Error ? error.message : String(error))
  }
  private failed(ticketId: string, summary: string): void {
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary })
      const relay = resultRelay(updated, 'failed', summary)
      this.host.relay(relay.id, relay.text)
    })
  }
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const current = () => {
      if (this.host.closing()) throw new Error('Superagent is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const stored = this.host.store.tickets.get(ticket.id)
      return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    const source = sourceTrigger(this.host, ticket)
    const directory = ticket.execution?.directory ?? ''
    if (!current() || !directory) return
    const sessionId = await this.host.sessions.ensureWorker(ticket, directory)
    if (!current()) return
    this.watch(sessionId, ticket.id)
    // The background work of the Assignment this one replaces stops first, so its end does not clear this one's message.
    await this.stopped(ticket.id)
    if (!current()) return
    // A message put back for this Assignment may still wait in the session, kept by a cancel or a restart: that copy is
    // dropped, and the copy delivered next goes under a fresh command id, since the daemon answers a reused one from its
    // receipt instead of queueing it again.
    const later = ticket.assignments.length > 1
    const putBack = new Set(
      (this.host.store.tickets.get(ticket.id)?.undelivered ?? []).map((id) => messageIdOf(id)),
    )
    // A put-back message whose last submission was unconfirmed is settled before its copies drop; while that cannot be
    // read, nothing drops and the launch waits.
    if (later)
      for (const message of putBack)
        await this.host.delivery.renew(sessionId, message).catch((error: unknown) => {
          this.stalls.waited(ticket.id, message, String(error))
          throw new Later(
            `Whether ${sessionId} received a put-back message cannot be confirmed: ${String(error)}`,
          )
        })
    this.stalls.settled(ticket.id)
    const waiting = (await this.host.sessions.state(sessionId)).pending
    const stale = waiting
      .filter((item) => putBack.has(messageOfCommand(item.commandId) ?? ''))
      .map((item) => item.itemId)
    if (stale.length) await this.host.sessions.dropPending(sessionId, stale)
    // The first message holds the assignment and the source trigger; a later Assignment's says only what is new, unless
    // the session lost the first.
    const first = `assignment:${ticket.id}`
    const told = later && (await this.holds(sessionId, first))
    if (!current()) return
    const retried = ticket.assignments.at(-2)?.endedReason === 'retried' ? { note: RETRIED } : {}
    const {
      text: brief,
      chars,
      read,
    } = capped(ticket.execution?.assignment ?? '', ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const card = told || !source ? undefined : await this.triggerCard(ticket, source.id)
    if (!current()) return
    const batch = told ? [] : batchOf(this.host, ticket).map(batchLine)
    const text = told
      ? JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length, ...retried })
      : JSON.stringify({
          ticket_id: ticket.id,
          title: ticket.title,
          ...(brief ? { assignment: brief } : {}),
          ...(read ? { assignment_chars: chars, assignment_read: read } : {}),
          ...(card ? { trigger: card } : {}),
          ...(batch.length ? { batch } : {}),
          ...retried,
        })
    const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first
    await this.send(sessionId, requestId, text, 'followUp', () => {
      if (!current()) throw new Error('Launch authorization changed before worker delivery')
    })
    this.host.engine.assignmentStarted(ticket.id, assignment.id)
  }
  /** Reads a worker session's events until the executor stops: turn starts and ends and the messages it took. */
  watch(sessionId: string, ticketId: string): void {
    if (this.watched.has(sessionId) || this.host.closing()) return
    let iterator: AsyncIterator<LedgerEvent> | undefined
    let stopped = false
    const entry = {
      stop: () => {
        stopped = true
        void iterator?.return?.()
      },
    }
    this.watched.set(sessionId, entry)
    const read = async () => {
      const session = await this.host.sessions.handle(sessionId)
      if ((await this.host.sessions.state(sessionId)).running) this.busy.add(sessionId)
      iterator = (
        session.events({ types: ['turn/start', 'turn/end', 'user/message'] }) as AsyncIterable<LedgerEvent>
      )[Symbol.asyncIterator]()
      if (stopped) await iterator.return?.()
      for (;;) {
        const next = await iterator.next()
        if (next.done || stopped) return
        this.observe(sessionId, ticketId, next.value)
      }
    }
    void this.background(
      read().finally(() => {
        if (this.watched.get(sessionId) === entry) this.watched.delete(sessionId)
      }),
    )
  }
  private observe(sessionId: string, ticketId: string, event: LedgerEvent): void {
    if (this.host.closing()) return
    const data = (event.data ?? {}) as { reason?: string; error?: { code: string; message: string } } & {
      commandId?: string
      kind?: string
    }
    if (event.type === 'turn/start') {
      this.busy.add(sessionId)
      this.settling.get(ticketId)?.abort()
      return
    }
    if (event.type === 'user/message') {
      const commandId = data.commandId
      if (commandId?.startsWith('superagent:')) {
        // The inputs a message of Superagent's carries, under whichever attempt, which its worker reads once taken.
        const message = messageOfCommand(commandId)
        const read =
          this.host.store.tickets
            .get(ticketId)
            ?.inputs.filter(
              (input) => input.kind === 'trigger' && !input.readAt && messageIdOf(input.id) === message,
            )
            .map((input) => input.id) ?? []
        if (read.length) this.host.engine.inputsRead(ticketId, read)
      } else if (data.kind !== 'runtime_context') this.personal.set(ticketId, now())
      return
    }
    if (event.type !== 'turn/end') return
    this.busy.delete(sessionId)
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && runningAssignment(ticket)
    if (!ticket || !assignment || !liveTicket(ticket)) return
    if (data.reason === 'error') {
      const error = turnError(data.error)
      if (this.retries(assignment.id, error)) {
        this.retried(sessionId, error.code, this.transient.get(assignment.id))
        this.resumeAfter(ticket.id, assignment.id, error)
      } else {
        this.retried(sessionId, undefined, undefined)
        void this.background(Promise.resolve().then(() => this.failed(ticket.id, error.message)))
      }
      return
    }
    if (data.reason !== 'aborted' && data.reason !== 'interrupted')
      this.retried(sessionId, undefined, undefined)
    // A turn a cancel ended is no end of the worker's own turn.
    if (data.reason === 'aborted' || data.reason === 'interrupted') return
    void this.background(this.workerIdle(ticket, assignment, sessionId))
  }
  /** Stops reading worker events and clears retry timers; sessions, turns and jobs are left as they are. */
  async shutdown(): Promise<void> {
    for (const look of this.settling.values()) look.abort()
    for (const watch of this.watched.values()) watch.stop()
    this.watched.clear()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    await Promise.allSettled([...this.stopping.values()])
  }
  /**
   * After a restart or a re-enable: an Assignment whose worker still runs is watched again; one whose turn ended meanwhile
   * was interrupted, which the engine re-dispatches with a recovery note (unless `interrupt` is false because a reconcile
   * outside does that from the session's real state, and the session is only watched); pending launches are queued
   * again, while a failed launch waits for a person's message or a retry.
   */
  async resume(interrupt = true): Promise<void> {
    const tickets = this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const ticket of tickets) {
      const running = runningAssignment(ticket)
      const latest = latestAssignment(ticket)
      if (running) {
        const sessionId = workerKey(ticket.id)
        const state = await this.host.sessions.state(sessionId).catch(() => undefined)
        if (state?.running || !interrupt) this.watch(sessionId, ticket.id)
        else this.host.engine.assignmentInterrupted(ticket.id, running.id)
      } else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  private background(work: Promise<void>): Promise<void> {
    const { health } = this.host
    return work.then(
      () => {
        if (health.get()?.state === 'error')
          health.set({ state: 'ready', detail: 'Worker events are handled', at: now() })
      },
      (error: unknown) => {
        health.set({ state: 'error', detail: String(error), at: now() })
      },
    )
  }
  private retries(name: string, error: unknown): boolean {
    const tries = this.transient.get(name) ?? 0
    if (!transient(error) || tries >= TRANSIENT_TRIES) {
      this.transient.delete(name)
      return false
    }
    this.transient.set(name, tries + 1)
    return true
  }
  /** Resumes a worker turn after a passing provider or network failure, with exponential backoff. */
  private resumeAfter(ticketId: string, assignmentId: string, error: unknown): void {
    const tries = this.transient.get(assignmentId) ?? 1
    const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`
    this.resuming.add(assignmentId)
    const go = () => {
      if (this.host.closing()) return
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) {
        this.resuming.delete(assignmentId)
        return
      }
      if (this.host.paused()) return this.after(SLOT_WAIT_MS, go)
      const waking = !this.running(ticket)
      try {
        if (waking) this.slots.reserve(ticketId, 'wake')
      } catch (failure) {
        if (!(failure instanceof Later)) throw failure
        return this.after(SLOT_WAIT_MS, go)
      }
      const sent = this.send(workerKey(ticketId), `retry:${assignmentId}:${tries}`, text, 'followUp')
      void this.background(
        sent
          .finally(() => {
            if (waking) this.slots.free(ticketId)
            this.resuming.delete(assignmentId)
          })
          .catch((failure) => {
            this.failed(ticketId, String(failure))
          }),
      )
    }
    this.after(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1), go)
  }
  private after(ms: number, then: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      then()
    }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }
  /**
   * A worker that handed off to a person frees its slot: its subagents stop, and its shell jobs, such as a server for the
   * person, are left to the person until the Assignment ends, holding no slot.
   */
  private async handOff(ticketId: string, sessionId: string): Promise<void> {
    const jobs = await this.host.sessions.jobs(sessionId)
    const left = this.left.get(ticketId) ?? new Set<string>()
    this.left.set(ticketId, left)
    const children = new Set(jobs.filter((job) => job.kind === 'child').map((job) => job.id))
    for (const job of jobs) if (!children.has(job.id)) left.add(job.id)
    if (children.size) this.track(ticketId, this.host.sessions.killJobs(sessionId, left))
  }
  private async workerIdle(ticket: Ticket, idle: Assignment, sessionId: string): Promise<void> {
    if (this.resuming.has(idle.id) || this.busy.has(sessionId)) return
    this.transient.delete(idle.id)
    const live = () => {
      const stored = this.host.store.tickets.get(ticket.id)
      return stored && liveTicket(stored) && runningAssignment(stored)?.id === idle.id ? stored : undefined
    }
    // A worker whose last word was its result, a question for a person, or a blocked or failed report handed off to a
    // person; an input delivered after its result or question is new work.
    const handedOff = (stored: Ticket) => {
      const assignment = runningAssignment(stored)
      const report = assignment?.report
      const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
      return ((report?.state === 'ready' || !!stored.attention) && !since) || waitsForPerson(stored)
    }
    const before = live()
    if (!before || this.host.closing()) return
    const report = runningAssignment(before)?.report
    const person = this.personal.get(ticket.id)
    if (handedOff(before) && !(report && person && person > report.at)) {
      this.host.engine.turnEnded(ticket.id, idle.id)
      await this.handOff(ticket.id, sessionId)
      return
    }
    // Its turn ends once none of its jobs runs, which holds its slot meanwhile: at most for the limit, and until the
    // worker runs again or the Assignment ends.
    this.settling.get(ticket.id)?.abort()
    const look = new AbortController()
    const limit = AbortSignal.timeout(BACKGROUND_LIMIT_MS)
    this.settling.set(ticket.id, look)
    const left = this.left.get(ticket.id)
    let quiet: boolean
    try {
      quiet = await this.untilQuiet(
        sessionId,
        AbortSignal.any([this.host.lifetime, look.signal, limit]),
        left,
      )
    } finally {
      if (this.settling.get(ticket.id) === look) this.settling.delete(ticket.id)
    }
    const current = live()
    if (
      this.host.closing() ||
      look.signal.aborted ||
      (!quiet && !limit.aborted) ||
      !current ||
      this.resuming.has(idle.id)
    )
      return
    if (quiet) this.host.engine.turnEnded(ticket.id, idle.id)
    let stopped = ''
    if (!quiet) {
      const minutes = BACKGROUND_LIMIT_MS / 60_000
      const jobs = (await this.host.sessions.jobs(sessionId, left)).map((job) => job.name)
      if (jobs.length) {
        void this.background(this.host.sessions.killJobs(sessionId, left))
        this.host.delivery.notify(sessionId, {
          content: `Your background jobs ran ${minutes} minutes after your turn ended and were killed: ${jobs.join(', ')}.`,
        })
      }
      stopped = `Background jobs ran ${minutes} minutes after the worker's turn ended and were killed: ${jobs.join(', ')}.`
    }
    if (handedOff(current)) return
    const said = [await this.lastAnswer(sessionId), stopped].filter(Boolean).join('\n\n')
    this.host.store.atomic(() => {
      const previous = latestReport(current)?.summary ?? ''
      const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said || previous })
      // A quiet final after orchestrator_report is not a new status or an empty handoff.
      if (said) {
        const relay = resultRelay(updated, 'waiting', said)
        this.host.relay(relay.id, relay.text)
      } else if (!previous.trim()) {
        const relay = resultRelay(
          updated,
          'waiting',
          'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.',
        )
        this.host.relay(relay.id, relay.text)
      }
    })
  }
  /** True once none of the session's jobs but `except` runs with the session idle; false when it aborts or runs again. */
  private async untilQuiet(
    sessionId: string,
    signal: AbortSignal,
    except?: ReadonlySet<string>,
  ): Promise<boolean> {
    for (;;) {
      if (signal.aborted || this.busy.has(sessionId)) return false
      const jobs = await this.host.sessions.jobs(sessionId, except).catch(() => undefined)
      if (signal.aborted || this.busy.has(sessionId)) return false
      if (jobs && !jobs.length) return true
      if ((await until(sleep(QUIET_POLL_MS), signal)) === false) return false
    }
  }
  private async lastAnswer(sessionId: string): Promise<string> {
    const transcript = await this.host.sessions.transcript(sessionId).catch(() => [])
    return transcript.findLast((entry) => entry.type === 'assistant')?.text.trim() ?? ''
  }
}

const sleep = (ms: number) => new Promise<true>((resolve) => setTimeout(() => resolve(true), ms).unref?.())
/** `work`, or false once `signal` aborts first. */
export function until<T>(work: Promise<T>, signal?: AbortSignal): Promise<T | false> {
  if (signal?.aborted) return Promise.resolve(false)
  let stop!: () => void
  const stopped = new Promise<false>((resolve) => {
    stop = () => resolve(false)
  })
  signal?.addEventListener('abort', stop, { once: true })
  return Promise.race([work, stopped]).finally(() => signal?.removeEventListener('abort', stop))
}
