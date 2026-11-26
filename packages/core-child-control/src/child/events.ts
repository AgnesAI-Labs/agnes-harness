import type { ChildAgentEvent, ChildAgentResult, ChildControlStore } from '@agnes/extension-api'

export type ChildCursor = { afterSeq?: number; signal?: AbortSignal }
type Listener = (event: ChildAgentEvent) => unknown
type Scan = (afterSeq: number) => Promise<readonly ChildAgentEvent[]>
type Diagnostic = (issue: 'out_of_order' | 'listener_error', detail: unknown) => unknown

function sequence(event: ChildAgentEvent) {
  return event.type === 'envelope' ? event.envelope.seq : event.seq
}

function statusOf(event: ChildAgentEvent) {
  if (event.type === 'envelope') return event.envelope.state ?? event.envelope.status
  if (event.type === 'status') return event.status
  return undefined
}

function isTerminal(status: string | undefined) {
  return status === 'failed' || status === 'completed' || status === 'cancelled'
}

export function providerFrame(event: ChildAgentEvent): ChildAgentEvent {
  if (event.type !== 'envelope') return event
  const { kind, status, seq, ts, eventId } = event.envelope
  return kind === 'status' && status ? { type: 'status', status, seq, ts, eventId } : event
}

type ParsedHeartbeat = { child: string; writer: string; seq: number }
type HeartbeatState = {
  writer: string
  seq: number
  ts: number
  leaseUntil: number
  retired: Set<string>
}

function parseHeartbeatId(eventId: string): ParsedHeartbeat | undefined {
  if (!eventId.startsWith('hb:')) return undefined
  const parts = eventId.split(':')
  const rawSeq = parts.at(-1)
  if (!rawSeq || !/^\d+$/.test(rawSeq)) return undefined
  const seq = Number(rawSeq)
  if (!Number.isSafeInteger(seq)) return undefined
  if (parts.length === 2) return { child: '', writer: '', seq }
  if (parts.length === 3) return { child: '', writer: parts[1] ?? '', seq }
  if (parts.length === 4) return { child: parts[1] ?? '', writer: parts[2] ?? '', seq }
  return undefined
}

/** Monotonic per-(childKey, writer) heartbeat gate; resets baseline on writer handover without regressing. */
class HeartbeatGate {
  private readonly states = new Map<string, HeartbeatState>()
  private lastOpaqueId: string | undefined

  accept(event: Extract<ChildAgentEvent, { type: 'heartbeat' }>): boolean {
    if (!event.eventId) return true
    const parsed = parseHeartbeatId(event.eventId)
    if (!parsed) {
      if (this.lastOpaqueId === event.eventId) return false
      this.lastOpaqueId = event.eventId
      return true
    }
    const state = this.states.get(parsed.child)
    if (!state) {
      this.states.set(parsed.child, {
        writer: parsed.writer,
        seq: parsed.seq,
        ts: event.ts,
        leaseUntil: event.leaseUntil,
        retired: new Set(),
      })
      return true
    }
    if (parsed.writer === state.writer) {
      if (parsed.seq <= state.seq) return false
      state.seq = parsed.seq
      state.ts = event.ts
      state.leaseUntil = event.leaseUntil
      return true
    }
    if (state.retired.has(parsed.writer)) return false
    if (event.ts < state.ts || (event.ts === state.ts && event.leaseUntil < state.leaseUntil)) {
      state.retired.add(parsed.writer)
      return false
    }
    if (event.ts === state.ts && event.leaseUntil === state.leaseUntil && parsed.seq <= state.seq) {
      return false
    }
    state.retired.add(state.writer)
    state.writer = parsed.writer
    state.seq = parsed.seq
    state.ts = event.ts
    state.leaseUntil = event.leaseUntil
    return true
  }
}

/** One ordered child stream. A durable source supplies its own journal and assigned cursors. */
export class ChildEventBus {
  private readonly listeners = new Set<Listener>()
  private readonly closers = new Set<() => void>()
  private readonly history: ChildAgentEvent[] = []
  private readonly ids = new Set<string>()
  private readonly liveHeartbeats = new HeartbeatGate()
  private highWater = 0
  private terminal = false
  private closed = false
  droppedOutOfOrder = 0

  constructor(
    private readonly options: {
      scan?: Scan
      snapshot?: Scan
      follow?: (listener: Listener) => () => void
      onDiagnostic?: Diagnostic
    } = {},
  ) {}

  private report(issue: Parameters<Diagnostic>[0], detail: unknown) {
    try {
      void Promise.resolve(this.options.onDiagnostic?.(issue, detail)).catch(() => {})
    } catch {
      // Diagnostics are observers too.
    }
  }

  get observed() {
    return this.listeners.size > 0
  }

  listen(listener: Listener) {
    if (!this.closed) this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Fan out an already committed frame, or a cursorless live notification. */
  notify(event: ChildAgentEvent) {
    if (event.type === 'heartbeat' && !this.liveHeartbeats.accept(event)) return
    for (const listener of [...this.listeners]) {
      try {
        void Promise.resolve(listener(event)).catch((error) => this.report('listener_error', error))
      } catch (error) {
        this.report('listener_error', error)
      }
    }
  }

  push(event: ChildAgentEvent): boolean {
    const id = event.type === 'envelope' ? event.envelope.eventId : event.eventId
    if (this.closed || (id !== undefined && this.ids.has(id))) return false
    const explicit = sequence(event)
    if (explicit !== undefined && (!Number.isSafeInteger(explicit) || explicit <= this.highWater)) {
      this.droppedOutOfOrder++
      this.report('out_of_order', event)
      return false
    }
    const heartbeat =
      event.type === 'heartbeat' || (event.type === 'envelope' && event.envelope.kind === 'heartbeat')
    const status = statusOf(event)
    if (this.terminal && (status !== undefined || heartbeat)) return false
    if (id !== undefined) this.ids.add(id)
    if (event.type !== 'heartbeat' || explicit !== undefined) {
      this.highWater = explicit ?? this.highWater + 1
      event = event.type === 'envelope' ? event : { ...event, seq: this.highWater }
      this.history.push(event)
    }
    this.terminal ||= isTerminal(status)
    this.notify(event)
    return true
  }

  close() {
    this.closed = true
    for (const close of this.closers) close()
    this.closers.clear()
    this.listeners.clear()
  }

  subscribe({ afterSeq, signal }: ChildCursor = {}): AsyncIterable<ChildAgentEvent> {
    const bus = this
    return {
      [Symbol.asyncIterator]() {
        // return() must also release an iterator currently blocked in next().
        const cancel = new AbortController()
        const iterator = bus.read(afterSeq, signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal)
        return {
          next: () => iterator.next(),
          return: () => {
            cancel.abort()
            return iterator.return(undefined)
          },
        }
      },
    }
  }

  private async *read(afterSeq: number | undefined, signal: AbortSignal) {
    let cursor = afterSeq ?? 0
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError('invalid child event cursor')
    let pending: ChildAgentEvent[] = []
    let wake: (() => void) | undefined
    const awaken = () => wake?.()
    const listen = this.options.follow ?? this.listen.bind(this)
    const stop = listen((event) => {
      pending.push(event)
      awaken()
    })
    this.closers.add(awaken)
    signal.addEventListener('abort', awaken)
    const scan: Scan =
      this.options.scan ?? (async (after) => this.history.filter((e) => (sequence(e) ?? 0) > after))
    try {
      let batch = await (this.options.snapshot ?? scan)(cursor)
      const heartbeats = new HeartbeatGate()
      // A fresh reader can start at the retention floor. An explicit cursor promises continuity.
      const first = batch.find((event) => sequence(event) !== undefined)
      if (afterSeq === undefined && first) cursor = (sequence(first) ?? 1) - 1
      while (!signal.aborted) {
        for (const event of batch) {
          if (signal.aborted) return
          if (event.type === 'heartbeat' && !heartbeats.accept(event)) continue
          const seq = sequence(event)
          if (seq !== undefined && seq <= cursor) continue
          if (seq !== undefined && seq > cursor + 1) {
            for (const missing of await scan(cursor)) {
              if (signal.aborted) return
              const next = sequence(missing)
              if (next === undefined) continue
              if (next !== cursor + 1 || next >= seq) break
              cursor = next
              yield missing
            }
            if (cursor + 1 !== seq) throw new Error(`child event gap after ${cursor}, received ${seq}`)
          }
          if (seq !== undefined) cursor = seq
          yield event
        }
        if (!pending.length && !this.closed && !signal.aborted) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
        if (!pending.length && this.closed) return
        batch = pending
        pending = []
      }
    } finally {
      stop()
      this.closers.delete(awaken)
      signal.removeEventListener('abort', awaken)
    }
  }
}

export function createCursorEventStream(options?: ConstructorParameters<typeof ChildEventBus>[0]) {
  return new ChildEventBus(options)
}

/** Every reader gets its own cursor. The completion promise still settles exactly once. */
export function createChildEventQueue(bus = createCursorEventStream()) {
  let resolve!: (value: ChildAgentResult) => void
  let reject!: (error: unknown) => void
  const result = new Promise<ChildAgentResult>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  void result.catch(() => undefined)
  let settled = false
  return {
    push(event: ChildAgentEvent) {
      bus.push(event)
    },
    events: (cursor?: ChildCursor) => bus.subscribe(cursor),
    settle(value: ChildAgentResult) {
      if (settled) return
      settled = true
      resolve(value)
      bus.close()
    },
    fail(error: unknown) {
      if (settled) return
      settled = true
      reject(error)
      bus.close()
    },
    get settled() {
      return settled
    },
    result,
  }
}

// The approval path and the factory use the same control port. Observe the CAS at that port
// so a complete approval wait between two timer ticks is still journaled.
type Cas = ChildControlStore['casState']
type Binding = { writers: Map<string, Set<Cas>>; release(): void }
const bindings = new WeakMap<ChildControlStore, Binding>()

export function observeChildCas(store: ChildControlStore, childKey: string, writer: Cas) {
  let binding = bindings.get(store)
  if (!binding) {
    const original = store.casState
    const own = Object.getOwnPropertyDescriptor(store, 'casState')
    const writers = new Map<string, Set<Cas>>()
    const observed: Cas = (key, ...args) => {
      const attached = writers.get(key)
      const active = attached && Array.from(attached).at(-1)
      return active ? active(key, ...args) : original.call(store, key, ...args)
    }
    store.casState = observed
    binding = {
      writers,
      release() {
        if (store.casState === observed) {
          if (own) Object.defineProperty(store, 'casState', own)
          else Reflect.deleteProperty(store, 'casState')
        }
        bindings.delete(store)
      },
    }
    bindings.set(store, binding)
  }
  const active = binding
  const writers = active.writers.get(childKey) ?? new Set<Cas>()
  writers.add(writer)
  active.writers.set(childKey, writers)
  return () => {
    if (!writers.delete(writer)) return
    if (!writers.size) active.writers.delete(childKey)
    if (!active.writers.size) active.release()
  }
}
