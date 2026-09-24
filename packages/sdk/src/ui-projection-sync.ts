import type {
  SessionPreviewParams,
  UIHistoryCursor,
  UIHistoryPage,
  UINode,
  UIOpeningResult,
  UITimeline,
  UITimelinePatch,
  UITurn,
} from '@agnes/protocol'
import type { Client } from './client.js'
import type { Disposer } from './events.js'
import type { LedgerEvent, Session, UIOpeningOptions } from './session.js'

export const REPROJECT_DEBOUNCE_MS = 50
export const OPENING_RETRY_MS = 500
export const MAX_DEFERRED_UI_OVERLAYS = 512

export type UIProjectionWindow = {
  startIndex: number
  totalNodes: number
  hasEarlier: boolean
  reason: 'opening' | 'live' | 'history'
}

type WindowCoordinates = Pick<UIProjectionWindow, 'startIndex' | 'totalNodes'>

const applyTurnChanges = (current: readonly UITurn[], changes: UITimelinePatch['turnChanges']): UITurn[] => {
  const turns = [...current]
  if (new Set(turns.map((turn) => turn.id)).size !== turns.length)
    throw new Error('UI_PROJECTION_DUPLICATE_TURN')
  const changedIds = new Set<string>()
  for (const change of changes) {
    const id = change.op === 'remove' ? change.id : change.turn.id
    if (changedIds.has(id)) throw new Error('UI_PROJECTION_DUPLICATE_TURN_CHANGE')
    changedIds.add(id)
    if (change.op !== 'remove') continue
    const index = turns.findIndex((turn) => turn.id === id)
    if (index < 0) throw new Error('UI_PROJECTION_UNKNOWN_TURN_REMOVE')
    turns.splice(index, 1)
  }
  for (const change of changes) {
    if (change.op !== 'upsert') continue
    const previous = turns.findIndex((turn) => turn.id === change.turn.id)
    if (previous >= 0) turns.splice(previous, 1)
    if (change.index > turns.length) throw new Error('UI_PROJECTION_TURN_INDEX_OUT_OF_RANGE')
    turns.splice(change.index, 0, change.turn)
  }
  return turns
}

const applyWindowedTurnChanges = (
  current: readonly UITurn[],
  changes: UITimelinePatch['turnChanges'],
  nodes: readonly UINode[],
): UITurn[] => {
  const turns = new Map(current.map((turn) => [turn.id, turn]))
  if (turns.size !== current.length) throw new Error('UI_PROJECTION_DUPLICATE_TURN')
  const changedIds = new Set<string>()
  for (const change of changes) {
    const id = change.op === 'remove' ? change.id : change.turn.id
    if (changedIds.has(id)) throw new Error('UI_PROJECTION_DUPLICATE_TURN_CHANGE')
    changedIds.add(id)
    if (change.op === 'remove') turns.delete(id)
    else turns.set(id, change.turn)
  }
  const retainedNodeIds = new Set(nodes.map((node) => node.id))
  return [...turns.values()]
    .filter(
      (turn) =>
        turn.nodeIds.some((id) => retainedNodeIds.has(id)) ||
        turn.status === 'running' ||
        turn.status === 'waiting',
    )
    .sort((a, b) => a.startSeq - b.startSeq)
}

/** Applies a daemon patch to the last authoritative Core projection held by this client. */
export function applyUITimelinePatch(current: UITimeline, patch: UITimelinePatch): UITimeline {
  if (
    patch.sessionId !== current.sessionId ||
    patch.generation !== current.generation ||
    patch.from !== current.upto ||
    patch.upto < patch.from
  )
    throw new Error('UI_PROJECTION_CURSOR_MISMATCH')

  const nodes = [...current.nodes]
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length)
    throw new Error('UI_PROJECTION_DUPLICATE_NODE')
  const changedIds = new Set<string>()
  for (const change of patch.changes) {
    const id = change.op === 'remove' ? change.id : change.node.id
    if (changedIds.has(id)) throw new Error('UI_PROJECTION_DUPLICATE_CHANGE')
    changedIds.add(id)
    if (change.op === 'remove') {
      const index = nodes.findIndex((node) => node.id === change.id)
      if (index < 0) throw new Error('UI_PROJECTION_UNKNOWN_REMOVE')
      nodes.splice(index, 1)
    }
  }
  for (const change of patch.changes) {
    if (change.op !== 'upsert') continue
    const previous = nodes.findIndex((node) => node.id === change.node.id)
    if (previous >= 0) nodes.splice(previous, 1)
    if (change.index > nodes.length) throw new Error('UI_PROJECTION_INDEX_OUT_OF_RANGE')
    nodes.splice(change.index, 0, change.node)
  }
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length)
    throw new Error('UI_PROJECTION_DUPLICATE_NODE')

  return {
    sessionId: patch.sessionId,
    generation: patch.generation,
    upto: patch.upto,
    opState: patch.opState,
    nodes,
    turns: applyTurnChanges(current.turns, patch.turnChanges),
    ...(patch.budget === undefined ? {} : { budget: patch.budget }),
    ...(patch.usage === undefined ? {} : { usage: patch.usage }),
  }
}

/** Maps Core's full-timeline patch coordinates onto a locally retained suffix window. */
export function applyWindowedUITimelinePatch(
  current: UITimeline,
  coordinates: WindowCoordinates,
  patch: UITimelinePatch,
): {
  timeline: UITimeline
  coordinates: WindowCoordinates
  unseen: Array<{ id: string; node?: UINode; index?: number }>
} {
  if (
    patch.sessionId !== current.sessionId ||
    patch.generation !== current.generation ||
    patch.from !== current.upto ||
    patch.upto < patch.from ||
    patch.totalNodes === undefined ||
    !Number.isSafeInteger(patch.totalNodes) ||
    patch.totalNodes < 0 ||
    coordinates.startIndex < 0 ||
    coordinates.startIndex + current.nodes.length !== coordinates.totalNodes
  )
    throw new Error('UI_PROJECTION_CURSOR_MISMATCH')

  const ids = new Set(current.nodes.map((node) => node.id))
  if (ids.size !== current.nodes.length) throw new Error('UI_PROJECTION_DUPLICATE_NODE')
  const changed = new Set<string>()
  const unseen: Array<{ id: string; node?: UINode; index?: number }> = []
  for (const change of patch.changes) {
    const id = change.op === 'remove' ? change.id : change.node.id
    if (changed.has(id)) throw new Error('UI_PROJECTION_DUPLICATE_CHANGE')
    changed.add(id)
    if (!ids.has(id))
      unseen.push(change.op === 'remove' ? { id } : { id, index: change.index, node: change.node })
  }

  const replaced = new Set(
    patch.changes.filter((change) => change.op === 'upsert').map((change) => change.node.id),
  )
  const removed = new Set(patch.changes.filter((change) => change.op === 'remove').map((change) => change.id))
  const survivors = current.nodes.filter((node) => !removed.has(node.id) && !replaced.has(node.id))
  const upserts = patch.changes
    .filter(
      (change): change is Extract<(typeof patch.changes)[number], { op: 'upsert' }> => change.op === 'upsert',
    )
    .sort((a, b) => a.index - b.index)
  if (upserts.some((change) => change.index >= (patch.totalNodes as number)))
    throw new Error('UI_PROJECTION_INDEX_OUT_OF_RANGE')

  // The retained nodes are always a suffix. Solve the suffix start as a fixed point: prefix
  // inserts/removes shift startIndex, while tail inserts become part of the retained window.
  let startIndex = Math.min(coordinates.startIndex, patch.totalNodes)
  let included: typeof upserts = []
  for (let pass = 0; pass <= upserts.length + 1; pass++) {
    included = upserts.filter((change) => change.index >= startIndex)
    const next = patch.totalNodes - survivors.length - included.length
    if (next < 0) throw new Error('UI_PROJECTION_WINDOW_OVERFLOW')
    if (next === startIndex) break
    startIndex = next
    if (pass === upserts.length + 1) throw new Error('UI_PROJECTION_WINDOW_UNSTABLE')
  }

  const slots: Array<UINode | undefined> = Array.from({ length: patch.totalNodes - startIndex })
  for (const change of included) {
    const local = change.index - startIndex
    if (local < 0 || local >= slots.length || slots[local])
      throw new Error('UI_PROJECTION_INDEX_OUT_OF_RANGE')
    slots[local] = change.node
  }
  let survivor = 0
  for (let index = 0; index < slots.length; index++) {
    if (slots[index]) continue
    const node = survivors[survivor++]
    if (!node) throw new Error('UI_PROJECTION_WINDOW_GAP')
    slots[index] = node
  }
  if (survivor !== survivors.length || slots.some((node) => node === undefined))
    throw new Error('UI_PROJECTION_WINDOW_GAP')
  const nodes = slots as UINode[]
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length)
    throw new Error('UI_PROJECTION_DUPLICATE_NODE')

  return {
    timeline: {
      sessionId: patch.sessionId,
      generation: patch.generation,
      upto: patch.upto,
      opState: patch.opState,
      nodes,
      turns: applyWindowedTurnChanges(current.turns, patch.turnChanges, nodes),
      ...(patch.budget === undefined
        ? current.budget === undefined
          ? {}
          : { budget: current.budget }
        : { budget: patch.budget }),
      ...(patch.usage === undefined
        ? current.usage === undefined
          ? {}
          : { usage: current.usage }
        : { usage: patch.usage }),
    },
    coordinates: { startIndex, totalNodes: patch.totalNodes },
    unseen,
  }
}

export type UIProjectionSyncSink = {
  timeline(value: UITimeline, window: UIProjectionWindow): void
  /**
   * Streamed text, never a ledger row. Streaming nodes in the timeline stay empty; merge previews
   * with `PreviewMerger` and lay them over every installed timeline.
   */
  preview?(p: SessionPreviewParams): void
  /** Every later ledger event, once, for consumers that react to events themselves. */
  event?(event: LedgerEvent): void
  error(error: unknown): void
}

export type UIProjectionSyncOptions = {
  surface?: NonNullable<UIOpeningOptions['surface']>
  opening?: Pick<UIOpeningOptions, 'maxNodes' | 'maxBytes'>
  historyLimit?: number
  /**
   * `clone` keeps a private copy of every installed timeline. `share` hands out the engine's own
   * objects, keeping unchanged nodes and turns by identity across patches; consumers must not write.
   */
  isolate?: 'clone' | 'share'
  /** `reject` makes a failed first opening reject start() instead of retrying in the background. */
  openingFailure?: 'retry' | 'reject'
  /** While the connection is not `connected`, nothing is requested; reconnecting reopens once. */
  connection?: Pick<Client, 'connectionState' | 'on'>
}

type OpenResult = { ok: true } | { ok: false; error?: unknown }

/** Owns one gap-free subscription. Timeline semantics still come exclusively from Core RPCs. */
export class UIProjectionSync {
  private stopped = false
  private started = false
  private iterator?: AsyncIterator<LedgerEvent>
  private timer: ReturnType<typeof setTimeout> | undefined
  private openingRetry: ReturnType<typeof setTimeout> | undefined
  private pendingUpto: number | undefined
  private forced = false
  // Patch, history and opening requests run one at a time, in order; this counts queued and running ones.
  private jobs = 0
  // Set while an opening or patch request is out; a prompt only skips the debounce when it is not.
  private projecting = false
  private tail: Promise<unknown> = Promise.resolve()
  private lastProjectAt = 0
  private appliedUpto = 0
  private lastEventSeq = 0
  private baselineValid = false
  private current: UITimeline | undefined
  private window: WindowCoordinates | undefined
  private history:
    | {
        generation: number
        cut: number
        totalNodes: number
        beforeIndex: number
        cursor?: UIHistoryCursor
      }
    | undefined
  private historyLoading: Promise<boolean> | undefined
  private historyEpoch = 0
  private readonly deferred = new Map<string, UINode | null>()
  private gated = false
  private connectionEpoch = 0
  private readonly connectionWaiters: Array<() => void> = []
  private readonly disposers: Disposer[] = []
  private previewOff: Disposer | undefined
  private starting = false
  private patchRetry: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly session: Pick<
      Session,
      'events' | 'projectUIOpening' | 'projectUIHistory' | 'projectUIPatch'
    > &
      Partial<Pick<Session, 'onPreview'>>,
    private readonly sink: UIProjectionSyncSink,
    private readonly options: UIProjectionSyncOptions = {},
  ) {}

  private get surface(): NonNullable<UIProjectionSyncOptions['surface']> {
    return this.options.surface ?? 'tui'
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) throw new Error('projection already started or stopped')
    this.started = true
    this.watchConnection()
    this.starting = true
    try {
      for (;;) {
        if (this.gated) await new Promise<void>((resolve) => this.connectionWaiters.push(resolve))
        if (this.stopped) return
        const opened = await this.exclusive(() => this.open())
        if (opened.ok) {
          this.subscribe()
          return
        }
        if (this.stopped) return
        // The connection went away while the first opening was out: wait for it and open again,
        // so start() settles only once there is a window or a real refusal.
        if (!('error' in opened)) continue
        // Attaching without an opening cut would resume from the journal/zero and recreate the full
        // history replay this class exists to avoid. Keep the shell usable after a transient
        // failure, but retry the snapshot and do not subscribe until an authoritative cut exists.
        if (this.options.openingFailure === 'reject') throw opened.error
        this.sink.error(opened.error)
        this.scheduleOpeningRetry()
        return
      }
    } finally {
      this.starting = false
    }
  }

  /** Asks for one patch; requests made while one is in flight fold into at most one more. */
  refresh(): void {
    if (this.stopped) return
    this.forced = true
    this.schedule()
  }

  private watchConnection(): void {
    const connection = this.options.connection
    if (!connection) return
    this.gated = connection.connectionState !== 'connected'
    const follow = () => {
      if (connection.connectionState === 'connected') this.ungate()
      else this.gate()
    }
    for (const event of ['connectionStateChanged', 'reconnecting', 'reconnected'] as const)
      this.disposers.push(connection.on(event, follow))
  }

  private gate(): void {
    if (this.gated || this.stopped) return
    this.gated = true
    // Results of requests made on the lost connection are dropped, and the new connection has no
    // window baseline yet: until a fresh opening registers one, a patch could only come back as an
    // unbounded replacement.
    this.connectionEpoch += 1
    this.clearTimers()
    this.invalidateBaseline()
    this.forced = true
  }

  private ungate(): void {
    if (!this.gated || this.stopped) return
    this.gated = false
    for (const resolve of this.connectionWaiters.splice(0)) resolve()
    // A start() still in progress opens by itself.
    if (this.starting) return
    void this.exclusive(() => this.reopen()).then((opened) => {
      if (opened && !this.iterator) this.subscribe()
    })
  }

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    // An idle queue runs the job right away, so a request goes out in the same tick as its trigger.
    const idle = this.jobs === 0
    this.jobs += 1
    const execute = async () => {
      try {
        return await job()
      } finally {
        this.jobs -= 1
        this.schedule()
      }
    }
    const run = idle ? execute() : this.tail.then(execute)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private subscribe(): void {
    if (this.stopped || this.iterator || !this.current || !this.baselineValid) return
    if (this.openingRetry) clearTimeout(this.openingRetry)
    this.openingRetry = undefined
    this.lastEventSeq = Math.max(this.lastEventSeq, this.current.upto)
    if (!this.previewOff && this.sink.preview && this.session.onPreview) {
      const sink = this.sink.preview.bind(this.sink)
      this.previewOff = this.session.onPreview((p) => {
        if (!this.stopped) sink(p)
      })
      this.disposers.push(this.previewOff)
    }
    this.iterator = this.session
      .events({
        ...(this.previewOff ? { preview: true } : {}),
        cursor: { fromSeq: this.current.upto, generation: this.current.generation },
      })
      [Symbol.asyncIterator]()
    void this.consume()
  }

  private scheduleOpeningRetry(): void {
    if (this.stopped || this.gated || this.baselineValid || this.openingRetry) return
    this.openingRetry = setTimeout(() => {
      this.openingRetry = undefined
      void this.exclusive(() => this.open()).then((opened) => {
        if (opened.ok) this.subscribe()
        else this.scheduleOpeningRetry()
      })
    }, OPENING_RETRY_MS)
  }

  private handle(event: LedgerEvent): void {
    if (event.seq > this.lastEventSeq) {
      this.lastEventSeq = event.seq
      this.sink.event?.(event)
    }
    if (event.seq <= this.appliedUpto) return
    this.pendingUpto = Math.max(this.pendingUpto ?? 0, event.seq)
    if (event.type === 'user/message' && !this.projecting && !this.gated) {
      this.fireNow()
      return
    }
    this.schedule()
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.openingRetry) clearTimeout(this.openingRetry)
    this.openingRetry = undefined
    if (this.patchRetry) clearTimeout(this.patchRetry)
    this.patchRetry = undefined
  }

  private fireNow(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.firePatch()
  }

  private firePatch(): void {
    this.pendingUpto = undefined
    this.forced = false
    void this.exclusive(() => this.project())
  }

  private async consume(): Promise<void> {
    try {
      while (!this.stopped) {
        const next = await this.iterator?.next()
        if (!next || next.done || this.stopped) break
        this.handle(next.value)
      }
    } catch (error) {
      if (!this.stopped) this.sink.error(error)
    }
  }

  private schedule(): void {
    if (this.stopped || this.gated || this.jobs > 0 || this.timer) return
    if (this.pendingUpto === undefined && !this.forced) return
    if (!this.baselineValid) {
      this.scheduleOpeningRetry()
      return
    }
    const remaining = REPROJECT_DEBOUNCE_MS - (Date.now() - this.lastProjectAt)
    if (remaining <= 0) {
      this.firePatch()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.firePatch()
    }, remaining)
  }

  private install(timeline: UITimeline, reason: UIProjectionWindow['reason']): void {
    this.current = this.options.isolate === 'share' ? timeline : structuredClone(timeline)
    this.appliedUpto = timeline.upto
    if (this.pendingUpto !== undefined && this.pendingUpto <= timeline.upto) this.pendingUpto = undefined
    const window = this.window
    if (!window) throw new Error('UI_PROJECTION_WINDOW_MISSING')
    this.sink.timeline(timeline, {
      ...window,
      hasEarlier: this.history?.cursor !== undefined,
      reason,
    })
  }

  private rememberDeferred(id: string, node: UINode | null): void {
    if (!this.deferred.has(id) && this.deferred.size >= MAX_DEFERRED_UI_OVERLAYS)
      throw new Error('UI_PROJECTION_DEFERRED_OVERFLOW')
    this.deferred.delete(id)
    this.deferred.set(id, node === null ? null : structuredClone(node))
  }

  private installOpening(result: UIOpeningResult): void {
    const { timeline, history } = result
    if (
      history.startIndex + timeline.nodes.length !== history.totalNodes ||
      history.hasEarlier !== history.startIndex > 0
    )
      throw new Error('UI_PROJECTION_OPENING_COORDINATES')
    this.historyEpoch += 1
    this.baselineValid = true
    this.deferred.clear()
    this.window = { startIndex: history.startIndex, totalNodes: history.totalNodes }
    this.history = {
      generation: timeline.generation,
      cut: timeline.upto,
      totalNodes: history.totalNodes,
      beforeIndex: history.startIndex,
      ...(history.hasEarlier ? { cursor: history.cursor } : {}),
    }
    this.install(timeline, 'opening')
  }

  private async open(): Promise<OpenResult> {
    const epoch = this.connectionEpoch
    this.lastProjectAt = Date.now()
    this.forced = false
    const bounds = this.options.opening ?? {}
    this.projecting = true
    try {
      const result = await this.session.projectUIOpening({
        surface: this.surface,
        ...(bounds.maxNodes === undefined ? {} : { maxNodes: bounds.maxNodes }),
        ...(bounds.maxBytes === undefined ? {} : { maxBytes: bounds.maxBytes }),
      })
      if (this.stopped || epoch !== this.connectionEpoch) return { ok: false }
      this.installOpening(result)
      return { ok: true }
    } catch (error) {
      if (this.stopped || epoch !== this.connectionEpoch) return { ok: false }
      return { ok: false, error }
    } finally {
      this.projecting = false
    }
  }

  private invalidateBaseline(): void {
    if (!this.baselineValid) return
    this.baselineValid = false
    this.historyEpoch += 1
    this.history = undefined
    this.deferred.clear()
  }

  private async reopen(): Promise<boolean> {
    this.invalidateBaseline()
    const opened = await this.open()
    if (!opened.ok) this.scheduleOpeningRetry()
    return opened.ok
  }

  private async project(): Promise<void> {
    if (!this.current || !this.window || !this.baselineValid) {
      this.scheduleOpeningRetry()
      return
    }
    const epoch = this.connectionEpoch
    this.lastProjectAt = Date.now()
    this.projecting = true
    try {
      // Event notifications are only a dirty signal. Pinning `upto` to an early notification while
      // a turn has already committed a later head asks Core for a historical cut and necessarily
      // invalidates the daemon's window baseline.
      const update = await this.session.projectUIPatch(this.current.upto, undefined, {
        surface: this.surface,
      })
      if (this.stopped || epoch !== this.connectionEpoch) return
      if (update.kind === 'replace') {
        // A windowed client never renders an unbounded replacement. Older daemons can still send
        // one, so treat it exactly like the new stable resync signal and negotiate a fresh opening.
        await this.reopen()
      } else {
        try {
          const applied = applyWindowedUITimelinePatch(this.current, this.window, update.patch)
          this.window = applied.coordinates
          for (const change of applied.unseen) {
            if (!change.node) {
              this.rememberDeferred(change.id, null)
              continue
            }
            const loaded = applied.timeline.nodes.some((node) => node.id === change.id)
            const existedAtCut = change.node.seq === undefined || change.node.seq <= (this.history?.cut ?? -1)
            // A node created after the fixed history cut cannot be overlaid onto a page from that
            // cut. If it landed in the unloaded prefix, renegotiate a bounded opening at a new cut.
            if (!loaded && !existedAtCut) throw new Error('UI_PROJECTION_NEW_PREFIX_NODE')
            if (existedAtCut) this.rememberDeferred(change.id, change.node)
          }
          this.install(applied.timeline, 'live')
        } catch {
          await this.reopen()
        }
      }
    } catch (error) {
      if (this.stopped || epoch !== this.connectionEpoch) return
      if ((error as { data?: { code?: unknown } })?.data?.code === 'UI_PROJECTION_RESYNC_REQUIRED')
        await this.reopen()
      else {
        this.sink.error(error)
        // The changes the failed request was for are still unseen; ask again after a pause.
        if (!this.patchRetry)
          this.patchRetry = setTimeout(() => {
            this.patchRetry = undefined
            this.refresh()
          }, OPENING_RETRY_MS)
      }
    } finally {
      this.projecting = false
    }
  }

  /** Loads one fixed-cut page. It never reads or mutates the live event attach cursor. */
  loadEarlier(): Promise<boolean> {
    if (this.historyLoading) return this.historyLoading
    if (this.stopped || !this.baselineValid || !this.current || !this.window || !this.history?.cursor)
      return Promise.resolve(false)
    const loading = this.exclusive(() => this.loadHistory()).finally(() => {
      if (this.historyLoading === loading) this.historyLoading = undefined
    })
    this.historyLoading = loading
    return loading
  }

  private async loadHistory(): Promise<boolean> {
    const history = this.history
    if (this.stopped || !this.baselineValid || !this.current || !this.window || !history?.cursor) return false
    const epoch = this.historyEpoch
    const expectedBefore = history.beforeIndex
    try {
      const page = await this.session.projectUIHistory(history.cursor, {
        limit: this.options.historyLimit ?? 100,
      })
      if (this.stopped || epoch !== this.historyEpoch) return false
      this.validateHistoryPage(page, history, expectedBefore)
      const current = this.current
      if (!current) return false
      const currentIds = new Set(current.nodes.map((node) => node.id))
      const pageIds = new Set<string>()
      const older: UINode[] = []
      for (const raw of page.nodes) {
        if (pageIds.has(raw.id)) throw new Error('UI_HISTORY_DUPLICATE_NODE')
        pageIds.add(raw.id)
        const hasOverlay = this.deferred.has(raw.id)
        const overlay = this.deferred.get(raw.id)
        if (currentIds.has(raw.id)) {
          if (!hasOverlay) throw new Error('UI_HISTORY_OVERLAPS_WINDOW')
          this.deferred.delete(raw.id)
          continue
        }
        this.deferred.delete(raw.id)
        if (hasOverlay && overlay === null) continue
        older.push(hasOverlay && overlay ? overlay : raw)
      }
      const nodes = [...older, ...current.nodes]
      if (new Set(nodes.map((node) => node.id)).size !== nodes.length)
        throw new Error('UI_HISTORY_DUPLICATE_NODE')
      if (new Set(page.turns.map((turn) => turn.id)).size !== page.turns.length)
        throw new Error('UI_HISTORY_DUPLICATE_TURN')
      const turns = new Map(page.turns.map((turn) => [turn.id, turn]))
      for (const turn of current.turns) turns.set(turn.id, turn)
      const nextHistory: NonNullable<UIProjectionSync['history']> = {
        generation: history.generation,
        cut: history.cut,
        totalNodes: history.totalNodes,
        beforeIndex: page.startIndex,
        ...(page.hasEarlier ? { cursor: page.cursor } : {}),
      }
      this.history = nextHistory
      const liveWindow = this.window
      if (!liveWindow) return false
      this.window = {
        startIndex: liveWindow.totalNodes - nodes.length,
        totalNodes: liveWindow.totalNodes,
      }
      if (this.window.startIndex < 0) throw new Error('UI_HISTORY_WINDOW_OVERFLOW')
      this.install(
        { ...current, nodes, turns: [...turns.values()].sort((a, b) => a.startSeq - b.startSeq) },
        'history',
      )
      return true
    } catch {
      if (!this.stopped && epoch === this.historyEpoch) await this.reopen()
      return false
    }
  }

  private validateHistoryPage(
    page: UIHistoryPage,
    history: NonNullable<UIProjectionSync['history']>,
    expectedBefore: number,
  ): void {
    if (
      !this.current ||
      page.sessionId !== this.current.sessionId ||
      page.generation !== history.generation ||
      page.generation !== this.current.generation ||
      page.cut !== history.cut ||
      page.totalNodes !== history.totalNodes ||
      page.startIndex + page.nodes.length !== expectedBefore ||
      page.startIndex >= expectedBefore ||
      page.hasEarlier !== page.startIndex > 0
    )
      throw new Error('UI_HISTORY_CURSOR_MISMATCH')
  }

  /** Re-establishes both the local baseline and daemon connection cache after a gap/reconnect. */
  async resync(): Promise<void> {
    if (this.stopped) return
    // A reconnect reopens on its own once the connection is back.
    if (this.gated) {
      this.invalidateBaseline()
      return
    }
    const opened = await this.exclusive(() => this.reopen())
    if (opened && !this.iterator) this.subscribe()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.clearTimers()
    this.historyEpoch += 1
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const resolve of this.connectionWaiters.splice(0)) resolve()
    await this.iterator?.return?.()
  }
}
