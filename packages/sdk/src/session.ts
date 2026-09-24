import { PermissionGate, type PermissionHandler, type PermissionRequest } from './permission.js'

export type { PermissionOption, PermissionOutcome, PermissionRequest } from './permission.js'

import {
  type AcpStopReason,
  AGNES_ERRORS,
  type AttachFilter,
  type ContentBlock,
  type Cursor,
  type EffectiveFromResult,
  type EventEnvelope,
  getHarnessMeta,
  type HarnessMeta,
  type SessionAttachParams,
  type SessionAttachResult,
  type SessionBudgetResult,
  type SessionPreviewParams,
  type SessionProjectUIHistoryParams,
  type SessionProjectUIOpeningParams,
  type SessionProjectUIParams,
  type SessionProjectUIPatchParams,
  type SlotName,
  type ThinkingLevel,
  type TurnEndReason,
  toAcpStopReason,
  UI_HISTORY_DEFAULT_LIMIT,
  UI_OPENING_DEFAULT_MAX_NODES,
  UI_PROJECTION_DEFAULT_MAX_BYTES,
  type UIHistoryCursor,
  type UIHistoryPage,
  type UIOpeningResult,
  type UIProjectionUpdate,
  type UITimeline,
  validateEvent,
  validateMethod,
} from '@agnes/protocol'
import type { Client } from './client.js'
import { JsonRpcError, ProtocolViolation, TransportClosed } from './errors.js'
// A handle on one conversation. It owns two things the client cannot own for it:
// the running position in that session's event stream (cursor, generation), and the
// assembly of a turn's outcome out of two independent arrivals - the prompt response
// and the terminal notification that precedes it.
import { type CompactOutcome, submitCommand, submitCompactAware } from './submit.js'

export type TurnResult = {
  stopReason: AcpStopReason
  reason: TurnEndReason
  lastSeq: number
  credits?: NonNullable<HarnessMeta['credits']>
}

export type UIOpeningOptions = Pick<SessionProjectUIOpeningParams, 'surface' | 'maxNodes' | 'maxBytes'>
export type UIHistoryOptions = Pick<SessionProjectUIHistoryParams, 'limit' | 'maxBytes'>

// Used only when a turn produced no terminal notification of its own; the ACP stop
// reason is coarser than our own vocabulary, so this is a fallback, not the mapping.
const REASON_FROM_STOP: Record<AcpStopReason, TurnEndReason> = {
  end_turn: 'completed',
  max_turn_requests: 'max_steps',
  cancelled: 'aborted',
  refusal: 'budget',
  max_tokens: 'completed',
}

export type LedgerEvent = EventEnvelope & { _meta: HarnessMeta }

/** Server-to-client notification carrying one raw ledger row. */
const EVENT_METHOD = '_agnes/v1/session.event'
/** Server-to-client notification carrying streamed text that is never a ledger row. */
const PREVIEW_METHOD = '_agnes/v1/session.preview'
/** Rows written to the journal every this many events, or on the timer below. */
const CURSOR_EVERY = 50
const CURSOR_INTERVAL_MS = 2_000

// Two filters ask for the same stream, so an attach that is already in force does not
// have to be replaced. Order matters inside `types` / `lanes`: a reordered list re-attaches,
// which costs one round trip and never the wrong stream.
function sameFilter(a: AttachFilter, b: AttachFilter): boolean {
  return (
    a.acpUpdates === b.acpUpdates &&
    a.preview === b.preview &&
    sameList(a.types, b.types) &&
    sameList(a.lanes, b.lanes)
  )
}

function sameList(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function eventSeq(params: Record<string, unknown>): number | null {
  const event = params.event as { seq?: unknown } | undefined
  return typeof event?.seq === 'number' ? event.seq : null
}

export type SessionNotificationListener = (
  method: string,
  params: Record<string, unknown>,
  meta: HarnessMeta | undefined,
) => void

export function toContentBlocks(input: ContentBlock[] | string): ContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input
}

type TurnEndRecord = { reason: TurnEndReason; seq: number; credits?: TurnResult['credits'] }

// The other direction from REASON_FROM_STOP: a turn end observed after the fact (either
// from `lastTurnEnd` or from a terminalQuiescence/parked notification reached while
// waiting one out) is turned back into the ACP shape `prompt()` promises its caller.
// `error` has no ACP stop reason of its own (protocol/codec/stop-reason.ts) - the request
// that would have carried it failed instead, so anything that reaches here as `error` is
// itself the fallback of a fallback and reported as a plain end_turn rather than thrown.
function resultFromTurnEnd(end: TurnEndRecord): TurnResult {
  return {
    stopReason: end.reason === 'error' ? 'end_turn' : toAcpStopReason(end.reason),
    reason: end.reason,
    lastSeq: end.seq,
    ...(end.credits ? { credits: end.credits } : {}),
  }
}

function invalidUIProjection(detail: string): never {
  throw new ProtocolViolation(`invalid UI projection response: ${detail}`)
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function checkOpeningResult(
  sessionId: string,
  result: UIOpeningResult,
  maxNodes = UI_OPENING_DEFAULT_MAX_NODES,
  maxBytes = UI_PROJECTION_DEFAULT_MAX_BYTES,
): void {
  const { timeline, history } = result
  if (timeline.sessionId !== sessionId) invalidUIProjection('opening session mismatch')
  if (timeline.nodes.length > maxNodes) invalidUIProjection('opening node limit exceeded')
  if (encodedBytes(result) > maxBytes) invalidUIProjection('opening byte limit exceeded')
  if (history.startIndex + timeline.nodes.length !== history.totalNodes)
    invalidUIProjection('opening window coordinates mismatch')
  if (history.hasEarlier !== history.startIndex > 0) invalidUIProjection('opening continuation mismatch')
}

function checkHistoryPage(
  sessionId: string,
  page: UIHistoryPage,
  limit = UI_HISTORY_DEFAULT_LIMIT,
  maxBytes = UI_PROJECTION_DEFAULT_MAX_BYTES,
): void {
  if (page.sessionId !== sessionId) invalidUIProjection('history session mismatch')
  if (page.nodes.length > limit) invalidUIProjection('history node limit exceeded')
  if (encodedBytes(page) > maxBytes) invalidUIProjection('history byte limit exceeded')
  if (page.startIndex + page.nodes.length > page.totalNodes)
    invalidUIProjection('history page coordinates mismatch')
  if (page.hasEarlier !== page.startIndex > 0) invalidUIProjection('history continuation mismatch')
}

// The cursor convention, in one place, because three pieces of code write `fromSeq` and
// they have to agree: **`fromSeq` is the last row already applied, and the server
// resumes with the rows strictly after it.** Exclusive, so zero means "nothing applied
// yet" - the same thing `SessionAttachResult.lastSeq` means coming back the other way,
// and the only reading under which the schema's `minimum: 0` says anything. Every writer
// therefore sends `lastApplied` verbatim: no `+ 1` anywhere. Getting it wrong is silent
// either way - one spelling replays a row the consumer already took, the other drops a
// row nobody ever sees.

export class Session {
  // Position and subscription state are readable but not writable: `attach()` and
  // `events()` are how they change. A consumer that sets `attached = false` by hand gets
  // a second subscription racing the first, and one that edits `filter` gets a stream
  // that no longer matches what it says it is.
  private seq = 0
  private gen = 0
  private serverSeq = 0
  private isAttached = false
  private currentFilter: AttachFilter = { acpUpdates: false }
  private attaching: Promise<void> | null = null
  private streamRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  private streamRecoveryEpoch = 0
  private streamRecoveryAttempts = 0
  private lastTurnEnd: TurnEndRecord | null = null
  // The promptTurnId off the most recent notification carrying harness meta, regardless of
  // phase. A prompt() that loses its transport uses this to recognise the terminal
  // notification for *its own* turn once the connection comes back - never just the next
  // terminalQuiescence to come along, which could belong to a turn started after it.
  private lastPromptTurnId: string | null = null
  // One entry per prompt() parked waiting for that terminal notification, settled the
  // moment the session closes for good - a wait nothing will ever answer otherwise, once
  // reconnection itself has been given up on.
  private readonly quiescenceWaiters = new Set<(err: Error) => void>()
  // Two watermarks, deliberately separate. `lastAdmitted` is the highest row let
  // through to the iterators, and is what makes a replayed prefix cheap to ignore.
  // `lastApplied` is the highest row a consumer actually took, and is the only honest
  // thing to persist as a cursor - anything still sitting in a buffer is not read yet.
  // Both are session-wide, which is exactly right for the delivery gate and a known
  // limit of the persisted cursor: with two iterators reading at different speeds,
  // `lastApplied` tracks the leading one, so a restart resumes past rows the lagging
  // one had buffered but never took. One consumer per session is the shape we ship.
  private lastAdmitted = 0
  private lastApplied = 0
  private overflowed = false
  private cursorDirty = 0
  private cursorTimer: ReturnType<typeof setTimeout> | null = null
  private isClosed = false
  // A runtime worker may be reclaimed while this client transport stays connected. Reopening the
  // durable session is only safe with the workspace supplied by session.new/load; never infer one
  // from process.cwd() in a browser-capable SDK.
  private workspace: string | null
  private restoring: Promise<void> | null = null
  private readonly permission = new PermissionGate()
  onPermissionRequest(handler: PermissionHandler): () => void {
    return this.permission.register(handler)
  }
  answerPermission(request: PermissionRequest) {
    return this.permission.answer(request)
  }
  readonly listeners = new Set<SessionNotificationListener>()
  // One entry per live iterator, called when the connection goes away: a reader
  // parked in `next()` is waiting on a stream that will never produce again.
  private readonly enders = new Set<() => void>()

  constructor(
    readonly client: Client,
    readonly id: string,
    cwd?: string,
  ) {
    this.workspace = cwd || null
  }

  /** Called when a later explicit load supplies information an older cached handle lacked. */
  rememberWorkspace(cwd: string): void {
    if (cwd) this.workspace = cwd
  }

  get lastSeq(): number {
    return this.seq
  }

  get generation(): number {
    return this.gen
  }

  /** What the server reported as its own last row at the most recent attach. */
  get lastServerSeq(): number {
    return this.serverSeq
  }

  get attached(): boolean {
    return this.isAttached
  }

  get closed(): boolean {
    return this.isClosed
  }

  /** A copy: the filter in force is a fact about the subscription, not a handle on it. */
  get filter(): AttachFilter {
    return { ...this.currentFilter }
  }

  cursor(): Cursor {
    return { fromSeq: this.seq, generation: this.gen }
  }

  /** Entry point for everything the client routes to this session id. */
  onNotification(method: string, params: Record<string, unknown>): void {
    if (method === EVENT_METHOD) {
      const seq = eventSeq(params)
      // Deduplicated here rather than per iterator: the wire stream belongs to the
      // session, so two iterators must agree on which rows were already delivered.
      if (seq === null || seq <= this.lastAdmitted) return
      // `METHODS` lists this notification, but `call()`'s validation covers what this
      // client sends, not what it receives, so the row is checked here before anyone can
      // see it as a `LedgerEvent`. Dropped rather than thrown: this runs on the
      // connection's read loop, where throwing would take every later notification down.
      const row = validateEvent(params.event)
      if (!row.ok) {
        // Dropped, but never silently: the only other symptom is a consumer parked in
        // next() forever, which is indistinguishable from an idle daemon and which under
        // `-p` is a hang rather than an exit code.
        this.client.notice({ kind: 'invalid-event', sessionId: this.id, seq, errors: row.errors })
        return
      }
      this.streamRecoveryAttempts = 0
      this.lastAdmitted = seq
    }
    const meta = getHarnessMeta(params)
    if (meta) {
      // Latest wins, unlike the two watermarks below: this is which turn is currently in
      // flight, not a position that must never walk backwards.
      this.lastPromptTurnId = meta.promptTurnId
      // Highest wins rather than latest wins, for both positions and for the same
      // reason: a replayed prefix after a re-attach must not walk them backwards. A
      // generation that went back would be persisted as the cursor's own, and the next
      // resume would be refused as stale.
      if (meta.eventSequence > this.seq) this.seq = meta.eventSequence
      if (meta.generation > this.gen) this.gen = meta.generation
      if (meta.turnEnd)
        this.lastTurnEnd = {
          reason: meta.turnEnd.reason,
          seq: meta.eventSequence,
          ...(meta.credits ? { credits: meta.credits } : {}),
        }
    }
    for (const l of [...this.listeners]) l(method, params, meta)
  }

  // The in-flight attach is registered before the first await inside, so anything that
  // asks for one in the same tick waits for it instead of racing it: two attaches in
  // flight together settle `generation` and `filter` in whichever order they land.
  attach(opts: { cursor?: Cursor; filter?: AttachFilter } = {}): Promise<void> {
    const p = this.doAttach(opts).finally(() => {
      if (this.attaching === p) this.attaching = null
    })
    this.attaching = p
    return p
  }

  // Waits behind an attach already in flight, then attaches only if the subscription is
  // not already the one being asked for. Without the filter check an events(opts) call on
  // an already-attached session sends nothing at all, and the caller silently gets the
  // unfiltered stream it did not ask for.
  private async ensureAttached(filter: AttachFilter, initialCursor?: Cursor): Promise<void> {
    // Somebody else's failed attach is not this caller's error; the state check below
    // decides what to do about it.
    while (this.attaching) await this.attaching.catch(() => undefined)
    if (this.isClosed || this.overflowed) return
    if (this.isAttached && sameFilter(this.currentFilter, filter)) return
    await this.attach({
      filter,
      // Re-subscribing, not starting: resume from where this session already is.
      ...(this.isAttached
        ? { cursor: { fromSeq: this.lastApplied, generation: this.gen } }
        : initialCursor
          ? { cursor: initialCursor }
          : {}),
    })
  }

  private async doAttach(opts: { cursor?: Cursor; filter?: AttachFilter } = {}): Promise<void> {
    const stored = opts.cursor ?? (await this.client.journal.cursor(this.id))
    // Generation numbering starts at one, so there is no way to spell "resume from the
    // very beginning" as a cursor - a first attach sends no cursor at all.
    const cursor = stored && stored.generation >= 1 ? stored : null
    this.currentFilter = { acpUpdates: false, ...(opts.filter ?? {}) }
    const params: SessionAttachParams = {
      sessionId: this.id,
      ...(cursor ? { cursor } : {}),
      filter: this.currentFilter,
    }
    const r = await this.client.call<SessionAttachResult>('_agnes/v1/session.attach', params)
    this.gen = r.generation
    this.serverSeq = r.lastSeq
    if (cursor) {
      // Everything the cursor says was applied stays applied. Without the two watermarks
      // a resumed session persists a position behind the one it resumed from, and a
      // server that replays the boundary row hands it over a second time.
      this.seq = Math.max(this.seq, cursor.fromSeq)
      this.lastAdmitted = Math.max(this.lastAdmitted, cursor.fromSeq)
      this.lastApplied = Math.max(this.lastApplied, cursor.fromSeq)
    }
    this.isAttached = true
  }

  /** Recover only the dropped event subscription; never resend mutations or move approvals. */
  onStreamOverloaded(): void {
    if ((!this.isAttached && !this.attaching) || this.isClosed || this.overflowed || this.streamRecoveryTimer)
      return
    if (++this.streamRecoveryAttempts > 3) {
      this.isAttached = false
      this.client.notice({ kind: 'stream-recovery-failed', sessionId: this.id })
      return
    }
    const epoch = this.streamRecoveryEpoch
    this.streamRecoveryTimer = setTimeout(() => {
      this.streamRecoveryTimer = null
      void (async () => {
        while (this.attaching) await this.attaching.catch(() => undefined)
        if (epoch !== this.streamRecoveryEpoch || this.isClosed || !this.isAttached) return
        try {
          await this.attachForRecovery({ fromSeq: this.lastApplied, generation: this.gen })
        } catch {
          this.isAttached = false
          this.client.notice({ kind: 'stream-recovery-failed', sessionId: this.id })
        }
      })()
    }, 500)
  }

  private cancelStreamRecovery(): void {
    this.streamRecoveryEpoch++
    if (this.streamRecoveryTimer) clearTimeout(this.streamRecoveryTimer)
    this.streamRecoveryTimer = null
  }

  async detach(): Promise<void> {
    this.cancelStreamRecovery()
    this.overflowed = false
    while (this.attaching) await this.attaching.catch(() => undefined)
    await this.client.call('_agnes/v1/session.detach', { sessionId: this.id })
    this.isAttached = false
    await this.flushCursor()
  }

  // Called by the reconnect loop (Reconnector, in reattach.ts) for every session that was
  // still `attached` when the transport dropped - `isAttached` itself is left alone by a
  // mere drop, so it is exactly the caller's own intent, independent of whatever the
  // connection is doing. Resends this session's pending writes before touching attach at
  // all: a steer sitting in the journal from before the drop must reach the server before
  // the event stream resumes, never after.
  async recover(): Promise<void> {
    await this.client.resendPending(this.id)
    // Verbatim, per the cursor convention above - no `+ 1`.
    const cursor: Cursor = { fromSeq: this.lastApplied, generation: this.gen }
    try {
      await this.attachForRecovery(cursor)
    } catch (e) {
      if (!this.isSessionNotFound(e) || !this.workspace) throw e
      await this.restoreAfterReclaim()
    }
  }

  /** Applies the two cursor repairs shared by transport reconnect and idle-worker restoration. */
  private async attachForRecovery(cursor: Cursor): Promise<void> {
    try {
      await this.attach({ cursor, filter: this.currentFilter })
    } catch (e) {
      if (!(e instanceof JsonRpcError)) throw e
      if (e.code === AGNES_ERRORS.GENERATION_STALE) {
        // The server moved on to a new generation while this client was gone. Same
        // fromSeq, new generation, and the caller finds out which: a client persisting
        // the resumed cursor by itself would otherwise write back the generation this
        // attach was just told is stale.
        const generation = Number(e.data.generation)
        this.gen = generation
        this.client.emit('generationChanged', { sessionId: this.id, generation })
        await this.attach({ cursor: { fromSeq: cursor.fromSeq, generation }, filter: this.currentFilter })
        return
      }
      if (e.code === AGNES_ERRORS.CURSOR_OUT_OF_RANGE) {
        // The row this session was about to resume from is gone - compacted, or past
        // some retention edge - and `earliestSeq` is as far back as the server can still
        // go. `earliestSeq - 1` (not `earliestSeq`) is the fromSeq that resumes exactly
        // there, per the same exclusive convention: the server sends rows strictly after it.
        const earliestSeq = Number(e.data.earliestSeq)
        this.client.emit('gap', { sessionId: this.id, earliestSeq })
        this.lastApplied = Math.max(0, earliestSeq - 1)
        await this.attach({
          cursor: { fromSeq: this.lastApplied, generation: this.gen },
          filter: this.currentFilter,
        })
        return
      }
      throw e
    }
  }

  private isSessionNotFound(error: unknown): error is JsonRpcError {
    return error instanceof JsonRpcError && error.code === AGNES_ERRORS.SESSION_NOT_FOUND
  }

  /** One load/attach sequence per handle, even if several callers observe the reclaimed worker. */
  private restoreAfterReclaim(): Promise<void> {
    if (this.restoring) return this.restoring
    const cwd = this.workspace
    if (!cwd) return Promise.reject(new Error('session workspace unavailable'))
    const wasAttached = this.isAttached
    const restoring = (async () => {
      await this.client.restoreSession(this.id, cwd)
      if (wasAttached) {
        await this.attachForRecovery({ fromSeq: this.lastApplied, generation: this.gen })
      }
    })().finally(() => {
      if (this.restoring === restoring) this.restoring = null
    })
    this.restoring = restoring
    return restoring
  }

  budget(): Promise<SessionBudgetResult> {
    return this.client.call<SessionBudgetResult>('_agnes/v1/session.budget', { sessionId: this.id })
  }

  setPreset(preset: string): Promise<EffectiveFromResult> {
    return this.client.call<EffectiveFromResult>('_agnes/v1/session.setPreset', {
      sessionId: this.id,
      preset,
    })
  }

  setModel(sel: {
    slot: SlotName
    route: string
    model: string
    thinking?: ThinkingLevel
  }): Promise<EffectiveFromResult> {
    return this.client.call<EffectiveFromResult>('_agnes/v1/session.setModel', { sessionId: this.id, ...sel })
  }

  setYolo(enabled: boolean): Promise<EffectiveFromResult> {
    return this.client.call<EffectiveFromResult>('_agnes/v1/session.setYolo', {
      sessionId: this.id,
      enabled,
    })
  }

  projectUI(upto?: number, opts: Pick<SessionProjectUIParams, 'surface'> = {}): Promise<UITimeline> {
    return this.client.call<UITimeline>('_agnes/v1/session.projectUI', {
      sessionId: this.id,
      ...(upto !== undefined ? { upto } : {}),
      ...(opts.surface !== undefined ? { surface: opts.surface } : {}),
    })
  }

  projectUIPatch(
    after: number,
    upto?: number,
    opts: Pick<SessionProjectUIPatchParams, 'surface'> = {},
  ): Promise<UIProjectionUpdate> {
    return this.client.call<UIProjectionUpdate>('_agnes/v1/session.projectUIPatch', {
      sessionId: this.id,
      after,
      ...(upto !== undefined ? { upto } : {}),
      ...(opts.surface !== undefined ? { surface: opts.surface } : {}),
    })
  }

  /**
   * Reads a bounded tail window at one stable ledger cut. The returned opaque history cursor is
   * only for projectUIHistory(); it is deliberately unrelated to the live event attach cursor.
   */
  async projectUIOpening(opts: UIOpeningOptions = {}): Promise<UIOpeningResult> {
    const result = await this.client.call<UIOpeningResult>('_agnes/v1/session.projectUIOpening', {
      sessionId: this.id,
      ...(opts.surface !== undefined ? { surface: opts.surface } : {}),
      ...(opts.maxNodes !== undefined ? { maxNodes: opts.maxNodes } : {}),
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    })
    checkOpeningResult(this.id, result, opts.maxNodes, opts.maxBytes)
    return result
  }

  /** Reads the next older page without moving the live event/projection watermark. */
  async projectUIHistory(cursor: UIHistoryCursor, opts: UIHistoryOptions = {}): Promise<UIHistoryPage> {
    const result = await this.client.call<UIHistoryPage>('_agnes/v1/session.projectUIHistory', {
      sessionId: this.id,
      cursor,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    })
    checkHistoryPage(this.id, result, opts.limit, opts.maxBytes)
    return result
  }

  async prompt(input: ContentBlock[] | string, opts: { signal?: AbortSignal } = {}): Promise<TurnResult> {
    // Captured by identity: the outcome of *this* turn is only the record that was
    // installed while the request was in flight, never one left over from a past turn.
    const before = this.lastTurnEnd
    // Best effort: the turn's own outcome is what the caller gets either way, so a
    // cancel that cannot be sent must not become an unhandled rejection. Held for the
    // whole call, including a fallback wait on quiescence: an abort during that wait
    // still means "stop the turn", and there is still a `session/cancel` worth sending.
    const onAbort = () => {
      this.cancel().catch(() => undefined)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await this.requestPrompt(input, before)
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  private async requestPrompt(
    input: ContentBlock[] | string,
    before: TurnEndRecord | null,
    restored = false,
  ): Promise<TurnResult> {
    try {
      // No deadline: a turn is bounded by the transport's liveness, not by a stopwatch.
      const r = await this.client.call<{ stopReason: AcpStopReason }>(
        'session/prompt',
        { sessionId: this.id, prompt: toContentBlocks(input) },
        { timeoutMs: null },
      )
      const end = this.lastTurnEnd !== before ? this.lastTurnEnd : null
      return {
        stopReason: r.stopReason,
        reason: end?.reason ?? REASON_FROM_STOP[r.stopReason],
        lastSeq: end?.seq ?? this.seq,
        ...(end?.credits ? { credits: end.credits } : {}),
      }
    } catch (e) {
      // daemon rejected before enqueue/run: the durable ledger still exists, only its idle worker
      // was reclaimed. Recreate runtime state, restore the raw-event cursor, and retry this prompt
      // exactly once. No other failure is safe to replay here.
      if (!restored && this.workspace && this.isSessionNotFound(e)) {
        await this.restoreAfterReclaim()
        return this.requestPrompt(input, before, true)
      }
      // The request itself failing to the transport dropping, not to a cancel or a
      // protocol error, is the one case with anything to wait for: the daemon may already
      // have finished the turn, and the reconnect loop (reattach.ts) is what brings the
      // notification that says so. `shuttingDown` and `isClosed` both mean nobody is
      // coming back to send it, so falling through to `throw e` there is deliberate.
      if (e instanceof TransportClosed && !this.client.shuttingDown && !this.client.isClosed) {
        // The terminal notification can beat the transport's own death onto the wire -
        // resolved already by the time the request rejects. Checked before registering a
        // listener, not after: a notification that already arrived is not going to arrive
        // a second time for a fresh listener to catch.
        if (this.lastTurnEnd !== before && this.lastTurnEnd) return resultFromTurnEnd(this.lastTurnEnd)
        return this.waitForQuiescence(this.lastPromptTurnId)
      }
      throw e
    }
  }

  // Parked until the notification for *this* turn's end reaches this session, or the
  // session closes for good without ever delivering one. `turnId` pins which turn: without
  // it, a `terminalQuiescence` belonging to whatever prompt happens to run next would be
  // mistaken for this one's answer.
  private waitForQuiescence(turnId: string | null): Promise<TurnResult> {
    return new Promise((resolve, reject) => {
      const listener: SessionNotificationListener = (_method, _params, meta) => {
        if (!meta || (meta.phase !== 'terminalQuiescence' && meta.phase !== 'parked')) return
        if (turnId !== null && meta.promptTurnId !== turnId) return
        cleanup()
        resolve(
          resultFromTurnEnd({
            reason: meta.turnEnd?.reason ?? 'completed',
            seq: meta.eventSequence,
            ...(meta.credits ? { credits: meta.credits } : {}),
          }),
        )
      }
      const onClose = (err: Error) => {
        cleanup()
        reject(err)
      }
      const cleanup = () => {
        this.listeners.delete(listener)
        this.quiescenceWaiters.delete(onClose)
      }
      this.listeners.add(listener)
      this.quiescenceWaiters.add(onClose)
    })
  }

  steer(input: ContentBlock[] | string, opts: { commandId?: string } = {}): Promise<number> {
    return this.write('steer', input, opts)
  }

  followUp(input: ContentBlock[] | string, opts: { commandId?: string } = {}): Promise<number> {
    return this.write('followUp', input, opts)
  }

  compact(instructions?: string, opts: { commandId?: string } = {}): Promise<number> {
    return submitCommand(
      this.client,
      this.id,
      'compact',
      { sessionId: this.id, ...(instructions ? { instructions } : {}) },
      opts.commandId,
    )
  }

  compactDetailed(instructions?: string, opts: { commandId?: string } = {}): Promise<CompactOutcome> {
    return submitCompactAware(
      this.client,
      this.id,
      'compact',
      { sessionId: this.id, ...(instructions ? { instructions } : {}) },
      opts.commandId,
    ).then(({ compact }) => compact)
  }

  private write(
    kind: 'steer' | 'followUp',
    input: ContentBlock[] | string,
    opts: { commandId?: string },
  ): Promise<number> {
    return submitCommand(
      this.client,
      this.id,
      kind,
      { sessionId: this.id, content: toContentBlocks(input) },
      opts.commandId,
    )
  }

  // A notification, not a request: cancellation is reported through the turn's own
  // stop reason, so there is nothing to wait for here.
  async cancel(): Promise<void> {
    await this.client.notify('session/cancel', { sessionId: this.id })
  }

  // Stopping the stream is better than growing without bound: the daemon keeps the
  // ledger, so a client that cannot keep up drops the subscription and comes back for
  // the part it missed rather than holding an ever larger backlog in memory.
  private async detachForOverflow(): Promise<void> {
    if (this.overflowed) return
    this.overflowed = true
    this.isAttached = false
    await this.client.call('_agnes/v1/session.detach', { sessionId: this.id }).catch(() => undefined)
  }

  private reattachAfterDrain(): void {
    if (!this.overflowed || this.isClosed) return
    this.overflowed = false
    // The same number flushCursor persists, per the cursor convention above.
    this.attach({
      cursor: { fromSeq: this.lastApplied, generation: this.gen },
      filter: this.currentFilter,
    }).catch(() => {
      // A re-attach that failed leaves the session detached with nothing to bring it
      // back, so the flag goes up again and the next drain retries.
      this.overflowed = true
    })
  }

  private noteApplied(seq: number): void {
    if (seq > this.lastApplied) this.lastApplied = seq
    this.cursorDirty++
    if (this.cursorDirty >= CURSOR_EVERY) {
      // A cursor that could not be written is worth no more than the next attempt:
      // failing the read the consumer is in the middle of would be worse.
      this.flushCursor().catch(() => undefined)
      return
    }
    // One timer per burst, not one per event: it is armed by the first event after a
    // write and survives until it fires or a write clears it.
    this.cursorTimer ??= setTimeout(() => {
      this.cursorTimer = null
      this.flushCursor().catch(() => undefined)
    }, CURSOR_INTERVAL_MS)
  }

  flushCursor(): Promise<void> {
    if (this.cursorTimer) {
      clearTimeout(this.cursorTimer)
      this.cursorTimer = null
    }
    this.cursorDirty = 0
    // Nothing worth writing before the first attach: generations start at one, so a
    // zero here could not be sent back as a cursor anyway.
    if (this.gen < 1) return Promise.resolve()
    // `lastApplied`, not `lastAdmitted`: a row sitting in a buffer has not been read, and
    // per the cursor convention above this position is one the consumer is done with.
    return this.client.journal.setCursor(this.id, {
      fromSeq: this.lastApplied,
      generation: this.gen,
    })
  }

  // Called by the client when the connection is gone for good. The returned promise is
  // the cursor write this session owes: close() waits for it, so the position a resume
  // reads is the position the consumer actually reached.
  onClosed(): Promise<void> {
    this.cancelStreamRecovery()
    if (this.isClosed) return Promise.resolve()
    this.isClosed = true
    this.permission.close()
    this.isAttached = false
    // Snapshot and clear before firing: every entry is spent the moment it runs, and
    // walking the live set while it drains is how a parked reader gets skipped and then
    // waits forever on a stream that has already ended.
    const ends = [...this.enders]
    this.enders.clear()
    for (const end of ends) end()
    // Same reasoning for a prompt() parked in waitForQuiescence: the reconnect loop has
    // given up for good, so the notification it was waiting on is never coming.
    const waiters = [...this.quiescenceWaiters]
    this.quiescenceWaiters.clear()
    for (const reject of waiters) reject(new TransportClosed({ reason: 'closed' }))
    // Also clears the cursor timer, which would otherwise hold a process open for two
    // more seconds while following a stream that has already ended.
    return this.flushCursor().catch(() => undefined)
  }

  /**
   * Streamed model text for this session, as it arrives. It is not a ledger row: it has no seq, may
   * be lost or repeated, and is replaced by the committed answer; merge it with `PreviewMerger`.
   * Delivered only while this session is attached with `preview: true`.
   */
  onPreview(fn: (p: SessionPreviewParams) => void): () => void {
    const listener: SessionNotificationListener = (method, params) => {
      if (method !== PREVIEW_METHOD) return
      if (!validateMethod(PREVIEW_METHOD, 'params', params).ok) return
      fn(params as SessionPreviewParams)
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  events(
    opts: { types?: string[]; lanes?: string[]; preview?: boolean; cursor?: Cursor } = {},
  ): AsyncIterable<LedgerEvent> {
    const session = this
    const { cursor: initialCursor, ...requestedFilter } = opts
    const limit = this.client.bufferLimit
    const drainMark = Math.floor(limit / 2)
    return {
      [Symbol.asyncIterator]() {
        const queue: LedgerEvent[] = []
        const waiters: Array<() => void> = []
        let done = false
        const wakeAll = () => {
          for (const w of waiters.splice(0)) w()
        }
        let ended = false
        const listener: SessionNotificationListener = (method, params, meta) => {
          if (method !== EVENT_METHOD || !meta) return
          queue.push({ ...(params.event as EventEnvelope), _meta: meta })
          if (queue.length > limit) void session.detachForOverflow()
          wakeAll()
        }
        // Ends the iterator without discarding what already arrived: the rows in hand
        // are still worth reading, there will just be no more of them.
        const end = () => {
          ended = true
          session.listeners.delete(listener)
          wakeAll()
        }
        session.listeners.add(listener)
        session.enders.add(end)
        if (session.isClosed) end()
        const ensure = session.ensureAttached({ ...requestedFilter, acpUpdates: false }, initialCursor)
        // Ending one iterator only unsubscribes it: other iterators may still be
        // reading, so the session stays attached until someone detaches it outright.
        const finish = async (): Promise<IteratorResult<LedgerEvent>> => {
          done = true
          session.listeners.delete(listener)
          session.enders.delete(end)
          wakeAll()
          // Swallowed like every other cursor write: a position that could not be
          // persisted is worth no more than the next attempt, and it must not throw out
          // of the `for await` the consumer is breaking out of.
          await session.flushCursor().catch(() => undefined)
          return { value: undefined as never, done: true }
        }
        return {
          async next(): Promise<IteratorResult<LedgerEvent>> {
            await ensure
            while (!done) {
              const e = queue.shift()
              if (e) {
                session.noteApplied(e.seq)
                if (queue.length <= drainMark) session.reattachAfterDrain()
                return { value: e, done: false }
              }
              if (ended) break
              await new Promise<void>((r) => {
                waiters.push(r)
              })
            }
            return { value: undefined as never, done: true }
          },
          return: finish,
          async throw(e: unknown): Promise<IteratorResult<LedgerEvent>> {
            await finish()
            throw e
          },
        }
      },
    }
  }
}
