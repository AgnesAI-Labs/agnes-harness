import { createHash } from 'node:crypto'
import type { createComparisonStore } from '@agnes/host'
import type { ComparisonTreeCuts, EventEnvelope } from '@agnes/protocol'
import { ComparisonError, type Side } from '@agnes/runtime-comparison'
import { readStoredRuntime } from '../storage/runtime-identity.js'
import type { ComparisonLedgerReader } from './methods/comparison.js'

type Storage = ReturnType<typeof createComparisonStore>
type Store = ReturnType<Storage['scoped']>
const SIDES: readonly Side[] = ['left', 'right']
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const failure = (code: string) => new ComparisonError(code, 'Comparison journal capture is incomplete')

export interface ComparisonCapturePorts {
  storage: Storage
  ledger: ComparisonLedgerReader
  /** Must resolve the current loaded session generation; capture never opens a session. */
  generation(sessionId: string): object | undefined
  subscribe(sessionId: string, receive: (event: EventEnvelope) => void): () => void
  authorize(principal: string, sessionId: string): void
  maxPending?: number
}
type Capture = {
  ready: Promise<void>
  tail: Promise<void>
  error?: unknown
  off: Array<() => void>
  generations: Partial<Record<Side, object>>
  pending: number
  stopped: boolean
  stale: boolean
  captureTrees?: () => Promise<void>
}

/** One daemon owns this publisher across connection lifetimes. No read path calls ensure(). */
export class ComparisonCapture {
  private readonly captures = new Map<string, Capture>()
  private closed = false
  private shuttingDown = false
  constructor(private readonly ports: ComparisonCapturePorts) {}

  async ensure(principal: string, id: string): Promise<void> {
    if (this.closed || this.shuttingDown) throw failure('COMPARISON_CAPTURE_CLOSED')
    const store = this.ports.storage.scoped(principal)
    const record = await store.read(id)
    if (this.closed) throw failure('COMPARISON_CAPTURE_CLOSED')
    if (!record) throw failure('COMPARISON_NOT_FOUND')
    for (const side of SIDES) {
      const lane = record.lanes[side]
      if (!lane) throw failure('COMPARISON_IN_PROGRESS')
      this.ports.authorize(principal, lane.sessionId)
      if (!this.ports.generation(lane.sessionId)) throw failure('COMPARISON_SESSION_NOT_LOADED')
    }
    const key = JSON.stringify([principal, id])
    const previous = this.captures.get(key)
    if (previous) {
      await previous.ready
      if (previous.error) throw previous.error
      if (
        !previous.stale &&
        SIDES.every(
          (side) => previous.generations[side] === this.ports.generation(record.lanes[side]!.sessionId),
        )
      )
        return
      this.stop(previous)
      await previous.tail
      if (previous.error) throw previous.error
      // Another ensure may already have replaced the old generation while this one waited.
      if (this.captures.get(key) !== previous) return this.ensure(principal, id)
    }
    const capture: Capture = {
      ready: Promise.resolve(),
      tail: Promise.resolve(),
      off: [],
      generations: {},
      pending: 0,
      stopped: false,
      stale: false,
    }
    if (this.closed || this.shuttingDown) throw failure('COMPARISON_CAPTURE_CLOSED')
    this.captures.set(key, capture)
    capture.ready = this.start(capture, store, principal, id).catch((error: unknown) => {
      capture.error = error
      this.stop(capture)
      throw error
    })
    await capture.ready
  }

  /** Drains observed root events and snapshots durable delegated watermarks; never executes or
   * opens sessions. Read RPCs do not call this publication method. */
  async flush(principal: string, id: string): Promise<void> {
    const capture = this.captures.get(JSON.stringify([principal, id]))
    if (!capture) return
    await capture.ready
    await capture.captureTrees?.()
    await capture.tail
    if (capture.error) throw capture.error
    if (capture.stale) throw failure('COMPARISON_CAPTURE_GENERATION_CHANGED')
  }

  private stop(capture: Capture) {
    capture.stopped = true
    for (const off of capture.off.splice(0)) off()
  }

  /** Intake must already be closed. Registry removal during owner shutdown is not a new writer. */
  beginShutdown(): void {
    this.shuttingDown = true
  }

  private async start(capture: Capture, store: Store, principal: string, id: string) {
    const record = await store.read(id)
    if (capture.stopped || this.closed) throw failure('COMPARISON_CAPTURE_CLOSED')
    if (!record) throw failure('COMPARISON_NOT_FOUND')
    const buffered: Array<{ side: Side; event: EventEnvelope }> = []
    let bootstrapping = true
    let baseline = { left: 0, right: 0 }
    const sameGeneration = () =>
      SIDES.every((side) => {
        const key = record.lanes[side]?.sessionId
        if (key === undefined) return false
        const current = this.ports.generation(key)
        return capture.generations[side] === current || (this.shuttingDown && current === undefined)
      })
    const fenceGeneration = () => {
      if (sameGeneration()) return true
      capture.stale = true
      this.stop(capture)
      return false
    }
    const enqueue = (side: Side, event: EventEnvelope) => {
      const sessionId = record.lanes[side]!.sessionId
      // An event captured during the head read may already be represented by the checkpoint.
      if (event.seq <= baseline[side]) return
      capture.tail = capture.tail.then(async () => {
        if (capture.error) return
        try {
          if (!fenceGeneration()) return
          this.ports.authorize(principal, sessionId)
          await store.journal.appendLane(id, {
            side,
            sessionId,
            localSeq: event.seq,
            digest: createHash('sha256').update(stable(event)).digest('hex'),
          })
        } catch (error) {
          capture.error = error
          this.stop(capture)
        } finally {
          capture.pending--
        }
      })
    }
    for (const side of SIDES) {
      const lane = record.lanes[side]
      if (!lane) throw failure('COMPARISON_IN_PROGRESS')
      this.ports.authorize(principal, lane.sessionId)
      const generation = this.ports.generation(lane.sessionId)
      if (!generation) throw failure('COMPARISON_SESSION_NOT_LOADED')
      capture.generations[side] = generation
      capture.off.push(
        this.ports.subscribe(lane.sessionId, (event) => {
          if (capture.stopped || capture.error) return
          if (!bootstrapping && !fenceGeneration()) return
          if (++capture.pending > (this.ports.maxPending ?? 8192)) {
            capture.error = failure('COMPARISON_CAPTURE_OVERFLOW')
            this.stop(capture)
            return
          }
          const row = { side, event: structuredClone(event) }
          if (bootstrapping) buffered.push(row)
          else if (event.seq <= baseline[side]) capture.pending--
          else enqueue(side, row.event)
        }),
      )
    }
    const heads = await Promise.all(
      SIDES.map(async (side) => {
        const lane = record.lanes[side]!
        const head = await this.ports.ledger.head(lane.sessionId)
        const first = await this.ports.ledger.scan(lane.sessionId, {
          fromSeq: 1,
          toSeq: 1,
          order: 'asc',
          limit: 1,
        })
        const start = first[0]
        const data = start?.data as { key?: unknown; runtime?: unknown; parent?: unknown } | undefined
        const runtime = readStoredRuntime(data?.runtime)
        if (
          !Number.isSafeInteger(head) ||
          head < 1 ||
          first.length !== 1 ||
          start?.seq !== 1 ||
          start.type !== 'session/start' ||
          data?.key !== lane.sessionId ||
          data.parent !== undefined ||
          runtime.id !== lane.runtime.id ||
          runtime.version !== lane.runtime.version ||
          capture.generations[side] !== this.ports.generation(lane.sessionId)
        )
          throw failure('COMPARISON_CAPTURE_IDENTITY')
        return head
      }),
    )
    if (capture.error) throw capture.error
    baseline = { left: heads[0]!, right: heads[1]! }
    const journalHead = await store.journal.head(id)
    if (capture.stopped || this.closed) throw failure('COMPARISON_CAPTURE_CLOSED')
    const cuts = journalHead?.cuts ?? { left: 0, right: 0 }
    if (SIDES.some((side) => baseline[side] < cuts[side])) throw failure('COMPARISON_CAPTURE_REGRESSION')
    if (SIDES.some((side) => baseline[side] > cuts[side]))
      await store.journal.checkpoint(id, {
        reason: !journalHead ? 'legacy' : cuts.left === 0 && cuts.right === 0 ? 'baseline' : 'recovery',
        cuts: baseline,
      })
    bootstrapping = false
    for (const row of buffered) {
      if (row.event.seq <= baseline[row.side]) capture.pending--
      else enqueue(row.side, row.event)
    }
    buffered.length = 0
    await capture.tail
    if (capture.error) throw capture.error
    if (capture.stale) throw failure('COMPARISON_CAPTURE_GENERATION_CHANGED')
    const captureTree = this.ports.ledger.captureTree?.bind(this.ports.ledger)
    if (captureTree) {
      let queued = false
      capture.captureTrees = async () => {
        if (queued || capture.stopped || this.closed || this.shuttingDown) return capture.tail
        queued = true
        capture.tail = capture.tail.then(async () => {
          try {
            if (capture.stopped || !fenceGeneration()) return
            const current = await store.read(id)
            if (!current || (current.retirement && current.retirement.state !== 'full')) {
              this.stop(capture)
              return
            }
            const head = await store.journal.head(id)
            if (!head) return
            const treeCuts: ComparisonTreeCuts = {}
            for (const side of SIDES) {
              const lane = current.lanes[side]
              if (!lane) throw failure('COMPARISON_CAPTURE_IDENTITY')
              this.ports.authorize(principal, lane.sessionId)
              const tree = await captureTree(lane.sessionId)
              const root = tree.members.find((member) => member.sessionId === lane.sessionId)
              if (root) {
                if (root.throughSeq < head.cuts[side]) throw failure('COMPARISON_CAPTURE_REGRESSION')
                root.throughSeq = head.cuts[side]
              }
              treeCuts[side] = tree
            }
            const previous = await store.journal.treeCutsAt(id, head.seq)
            if (stable(previous ?? {}) !== stable(treeCuts))
              await store.journal.checkpoint(id, { reason: 'recovery', cuts: head.cuts, treeCuts })
          } catch (error) {
            capture.error = error
            this.stop(capture)
          } finally {
            queued = false
          }
        })
        return capture.tail
      }
      await capture.captureTrees()
      // Internal children need not have a daemon registry entry. Observe durable watermarks
      // independently of root activity; read RPCs never scan current children or publish cuts.
      const timer = setInterval(() => {
        void capture.captureTrees?.()
      }, 500)
      timer.unref()
      capture.off.push(() => clearInterval(timer))
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const capture of this.captures.values()) this.stop(capture)
    const results = await Promise.allSettled(
      [...this.captures.values()].map(async (capture) => {
        await capture.ready
        await capture.tail
        if (capture.error) throw capture.error
      }),
    )
    this.captures.clear()
    const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Comparison journal capture failed')
  }
}
