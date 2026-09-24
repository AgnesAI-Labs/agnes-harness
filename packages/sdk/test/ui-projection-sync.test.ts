import type {
  UIHistoryPage,
  UINode,
  UIOpeningResult,
  UIProjectionUpdate,
  UITimeline,
  UITimelinePatch,
} from '@agnes/protocol'
import * as node from '@agnes/sdk'
import * as browser from '@agnes/sdk/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Emitter } from '../src/events.js'
import type { LedgerEvent } from '../src/session.js'
import {
  applyUITimelinePatch,
  applyWindowedUITimelinePatch,
  OPENING_RETRY_MS,
  UIProjectionSync,
  type UIProjectionSyncOptions,
} from '../src/ui-projection-sync.js'

afterEach(() => vi.useRealTimers())

describe('UIProjectionSync export', () => {
  it.each([
    ['node', node],
    ['browser', browser],
  ] as const)('is exported from the %s entry with its pure helpers', (_name, entry) => {
    expect(entry.UIProjectionSync).toBeTypeOf('function')
    expect(entry.applyUITimelinePatch).toBeTypeOf('function')
    expect(entry.applyWindowedUITimelinePatch).toBeTypeOf('function')
    expect(entry.REPROJECT_DEBOUNCE_MS).toBe(50)
    expect(entry.OPENING_RETRY_MS).toBe(500)
    expect(entry.MAX_DEFERRED_UI_OVERLAYS).toBe(512)
  })
})

const text = (id: string, seq: number, body = id): UINode =>
  ({ id, kind: 'assistant', seq, text: body, streaming: false }) as unknown as UINode

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function timeline(upto: number, nodes: UINode[]): UITimeline {
  return {
    sessionId: 's',
    generation: 1,
    upto,
    opState: null,
    nodes,
    turns: [
      { id: 'turn-1', status: 'completed', startSeq: 1, endSeq: upto, nodeIds: nodes.map((n) => n.id) },
    ],
  } as unknown as UITimeline
}

function patchOf(from: number, upto: number, totalNodes: number, changes: UITimelinePatch['changes']) {
  return {
    sessionId: 's',
    generation: 1,
    from,
    upto,
    totalNodes,
    opState: null,
    changes,
    turnChanges: [],
  } as UITimelinePatch
}

describe('the pure patch functions', () => {
  it('keep unchanged nodes and turns by identity and never write to their inputs', () => {
    const a = text('a', 1)
    const b = text('b', 2)
    const current = deepFreeze(timeline(2, [a, b]))
    const next = applyUITimelinePatch(
      current,
      deepFreeze(patchOf(2, 3, 2, [{ op: 'upsert', index: 1, node: text('b', 3, 'b2') }])),
    )
    expect(next.nodes[0]).toBe(a)
    expect(next.turns[0]).toBe(current.turns[0])
    const windowed = applyWindowedUITimelinePatch(
      current,
      { startIndex: 0, totalNodes: 2 },
      deepFreeze(patchOf(2, 3, 3, [{ op: 'upsert', index: 2, node: text('c', 3) }])),
    )
    expect(windowed.timeline.nodes[0]).toBe(a)
    expect(windowed.timeline.nodes[1]).toBe(b)
    expect(windowed.timeline.turns[0]).toBe(current.turns[0])
  })
})

type Update = UIProjectionUpdate

function open(upto: number, nodes: UINode[], history?: UIOpeningResult['history']): UIOpeningResult {
  return {
    timeline: timeline(upto, nodes),
    history: history ?? { hasEarlier: false, startIndex: 0, totalNodes: nodes.length },
  } as UIOpeningResult
}

function harness(options: UIProjectionSyncOptions = {}, opening: UIOpeningResult = open(0, [])) {
  let receive: ((value: IteratorResult<LedgerEvent>) => void) | undefined
  const iterator = {
    next: () =>
      new Promise<IteratorResult<LedgerEvent>>((resolve) => {
        receive = resolve
      }),
    return: vi.fn(async () => ({ done: true, value: undefined }) as IteratorResult<LedgerEvent>),
  }
  const projectUIOpening = vi.fn(
    async (_opts?: unknown): Promise<UIOpeningResult> => structuredClone(opening),
  )
  const projectUIHistory = vi.fn(async (_cursor?: unknown, _opts?: unknown): Promise<UIHistoryPage> => {
    throw new Error('no history')
  })
  const projectUIPatch = vi.fn(
    async (after: number, _upto?: number, _opts?: unknown): Promise<Update> => ({
      kind: 'patch',
      patch: patchOf(after, after, 0, []),
    }),
  )
  const events = vi.fn((_opts?: unknown) => ({ [Symbol.asyncIterator]: () => iterator }))
  const sink = { timeline: vi.fn(), error: vi.fn(), event: vi.fn() }
  const sync = new UIProjectionSync(
    { events, projectUIOpening, projectUIHistory, projectUIPatch } as never,
    sink,
    options,
  )
  return {
    sync,
    sink,
    events,
    iterator,
    projectUIOpening,
    projectUIHistory,
    projectUIPatch,
    async emit(event: Partial<LedgerEvent> & { seq: number }) {
      receive?.({ done: false, value: { type: 'turn/start', ...event } as LedgerEvent })
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

function connection(state: 'connected' | 'reconnecting' = 'connected') {
  const emitter = new Emitter<string>()
  const c = {
    connectionState: state as string,
    on: (event: string, handler: (payload: unknown) => void) => emitter.on(event, handler),
    drop() {
      c.connectionState = 'reconnecting'
      emitter.emit('connectionStateChanged', 'reconnecting')
      emitter.emit('reconnecting', { reason: 'test' })
    },
    restore() {
      c.connectionState = 'connected'
      emitter.emit('connectionStateChanged', 'connected')
      emitter.emit('reconnected', { attempts: 1 })
    },
  }
  return c as unknown as NonNullable<UIProjectionSyncOptions['connection']> & typeof c
}

describe('UIProjectionSync options', () => {
  it('passes surface, opening bounds and the history page size, and keeps the TUI defaults otherwise', async () => {
    vi.useFakeTimers()
    const h = harness(
      { surface: 'web', opening: { maxNodes: 500, maxBytes: 1_048_576 }, historyLimit: 7 },
      open(4, [text('a', 4)], { hasEarlier: true, startIndex: 3, totalNodes: 4, cursor: 'c' as never }),
    )
    await h.sync.start()
    expect(h.projectUIOpening).toHaveBeenCalledWith({ surface: 'web', maxNodes: 500, maxBytes: 1_048_576 })
    await h.emit({ seq: 5 })
    await vi.advanceTimersByTimeAsync(50)
    expect(h.projectUIPatch).toHaveBeenLastCalledWith(4, undefined, { surface: 'web' })
    void h.sync.loadEarlier()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.projectUIHistory).toHaveBeenCalledWith('c', { limit: 7 })
    await h.sync.stop()
  })

  it('in share mode hands out the same node objects that were not changed', async () => {
    vi.useFakeTimers()
    const h = harness({ isolate: 'share' }, open(2, [text('a', 1), text('b', 2)]))
    h.projectUIPatch.mockImplementationOnce(async (after) => ({
      kind: 'patch',
      patch: deepFreeze(patchOf(after, 3, 3, [{ op: 'upsert', index: 2, node: text('c', 3) }])),
    }))
    await h.sync.start()
    const first = h.sink.timeline.mock.calls[0]?.[0] as UITimeline
    await h.emit({ seq: 3 })
    await vi.advanceTimersByTimeAsync(50)
    const second = h.sink.timeline.mock.calls[1]?.[0] as UITimeline
    expect(second.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(second.nodes[0]).toBe(first.nodes[0])
    expect(second.nodes[1]).toBe(first.nodes[1])
    await h.sync.stop()
  })

  it('in the default clone mode never hands out the engine state itself', async () => {
    vi.useFakeTimers()
    const h = harness({}, open(2, [text('a', 1)]))
    await h.sync.start()
    const first = h.sink.timeline.mock.calls[0]?.[0] as UITimeline
    ;(first.nodes[0] as unknown as { text: string }).text = 'mutated by the consumer'
    await h.emit({ seq: 3 })
    await vi.advanceTimersByTimeAsync(50)
    const second = h.sink.timeline.mock.calls[1]?.[0] as UITimeline
    expect((second.nodes[0] as unknown as { text: string }).text).toBe('a')
    await h.sync.stop()
  })
})

describe('UIProjectionSync single flight', () => {
  it('runs patch, history and reopen one at a time', async () => {
    vi.useFakeTimers()
    const h = harness(
      {},
      open(4, [text('a', 4)], { hasEarlier: true, startIndex: 3, totalNodes: 4, cursor: 'c' as never }),
    )
    h.projectUIHistory.mockImplementationOnce(
      async () =>
        ({
          sessionId: 's',
          generation: 1,
          cut: 4,
          totalNodes: 4,
          startIndex: 2,
          nodes: [text('z', 2)],
          turns: [],
          hasEarlier: true,
          cursor: 'd',
        }) as unknown as UIHistoryPage,
    )
    await h.sync.start()
    let finish!: (value: Update) => void
    h.projectUIPatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await h.emit({ seq: 5 })
    await vi.advanceTimersByTimeAsync(50)
    expect(h.projectUIPatch).toHaveBeenCalledTimes(1)
    const earlier = h.sync.loadEarlier()
    const resync = h.sync.resync()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.projectUIHistory).not.toHaveBeenCalled()
    expect(h.projectUIOpening).toHaveBeenCalledTimes(1)
    finish({ kind: 'patch', patch: patchOf(4, 5, 4, []) })
    await earlier
    await resync
    expect(h.projectUIHistory).toHaveBeenCalledTimes(1)
    expect(h.projectUIOpening).toHaveBeenCalledTimes(2)
    await h.sync.stop()
  })

  it('folds any number of refreshes during a patch into at most one more', async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.sync.start()
    let finish!: (value: Update) => void
    h.projectUIPatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    h.sync.refresh()
    await vi.advanceTimersByTimeAsync(50)
    expect(h.projectUIPatch).toHaveBeenCalledTimes(1)
    // Spread out, so the debounce window alone cannot fold them.
    for (let i = 0; i < 5; i++) {
      h.sync.refresh()
      await vi.advanceTimersByTimeAsync(60)
    }
    finish({ kind: 'patch', patch: patchOf(0, 0, 0, []) })
    await vi.advanceTimersByTimeAsync(200)
    expect(h.projectUIPatch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.projectUIPatch).toHaveBeenCalledTimes(2)
    await h.sync.stop()
  })
})

describe('UIProjectionSync first opening failure', () => {
  it('rejects start() and schedules nothing in reject mode', async () => {
    vi.useFakeTimers()
    const h = harness({ openingFailure: 'reject' })
    h.projectUIOpening.mockRejectedValueOnce(new Error('UI_PROJECTION_NODE_TOO_LARGE'))
    await expect(h.sync.start()).rejects.toThrow('UI_PROJECTION_NODE_TOO_LARGE')
    await vi.advanceTimersByTimeAsync(OPENING_RETRY_MS * 3)
    expect(h.projectUIOpening).toHaveBeenCalledTimes(1)
    expect(h.events).not.toHaveBeenCalled()
    expect(h.sink.error).not.toHaveBeenCalled()
  })

  it('reports and retries in the default retry mode', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.projectUIOpening.mockRejectedValueOnce(new Error('unavailable'))
    await h.sync.start()
    expect(h.sink.error).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(OPENING_RETRY_MS)
    expect(h.projectUIOpening).toHaveBeenCalledTimes(2)
    await h.sync.stop()
  })
})

describe('UIProjectionSync connection gate', () => {
  it('sends no patch while reconnecting and reopens exactly once when connected again', async () => {
    vi.useFakeTimers()
    const conn = connection()
    const h = harness({ connection: conn })
    await h.sync.start()
    conn.drop()
    // The SDK resends missed events before it reports `reconnected`.
    for (let seq = 1; seq <= 5; seq++) await h.emit({ seq })
    h.sync.refresh()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.projectUIPatch).not.toHaveBeenCalled()
    expect(h.projectUIOpening).toHaveBeenCalledTimes(1)
    conn.restore()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.projectUIOpening).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.projectUIOpening).toHaveBeenCalledTimes(2)
    await h.sync.stop()
  })

  it('drops a patch result that was in flight when the connection went away', async () => {
    vi.useFakeTimers()
    const conn = connection()
    const h = harness({ connection: conn })
    await h.sync.start()
    let finish!: (value: Update) => void
    h.projectUIPatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await h.emit({ seq: 1 })
    await vi.advanceTimersByTimeAsync(50)
    conn.drop()
    finish({ kind: 'replace', timeline: timeline(1, [text('unbounded', 1)]) })
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.sink.timeline).toHaveBeenCalledTimes(1)
    expect(h.projectUIOpening).toHaveBeenCalledTimes(1)
    conn.restore()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.projectUIOpening).toHaveBeenCalledTimes(2)
    await h.sync.stop()
  })

  it('does not open until the connection is up', async () => {
    vi.useFakeTimers()
    const conn = connection('reconnecting')
    const h = harness({ connection: conn })
    const started = h.sync.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(h.projectUIOpening).not.toHaveBeenCalled()
    conn.restore()
    await started
    expect(h.projectUIOpening).toHaveBeenCalledTimes(1)
    await h.sync.stop()
  })
})

describe('UIProjectionSync event bypass', () => {
  it('passes each later event to the sink once', async () => {
    vi.useFakeTimers()
    const h = harness({}, open(3, []))
    await h.sync.start()
    await h.emit({ seq: 2 })
    await h.emit({ seq: 4, type: 'turn/end' })
    await h.emit({ seq: 4, type: 'turn/end' })
    expect(h.sink.event.mock.calls.map(([event]) => (event as LedgerEvent).seq)).toEqual([4])
    await h.sync.stop()
  })
})

describe('UIProjectionSync review fixes', () => {
  it('keeps start() pending across a drop during the first opening in reject mode', async () => {
    vi.useFakeTimers()
    const conn = connection()
    const h = harness({ connection: conn, openingFailure: 'reject' }, open(2, [text('a', 1)]))
    let answer!: (value: UIOpeningResult) => void
    h.projectUIOpening.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    let settled = false
    const started = h.sync.start().then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    conn.drop()
    answer(open(1, []))
    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toBe(false)
    expect(h.sink.timeline).not.toHaveBeenCalled()
    conn.restore()
    await started
    expect(h.projectUIOpening).toHaveBeenCalledTimes(2)
    expect(h.sink.timeline).toHaveBeenCalledTimes(1)
    expect(h.events).toHaveBeenCalledTimes(1)
    await h.sync.stop()
  })

  it('retries a patch that failed with an ordinary error', async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.sync.start()
    h.projectUIPatch.mockRejectedValueOnce(new Error('unavailable'))
    await h.emit({ seq: 1 })
    await vi.advanceTimersByTimeAsync(50)
    expect(h.sink.error).toHaveBeenCalledTimes(1)
    expect(h.projectUIPatch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(OPENING_RETRY_MS)
    expect(h.projectUIPatch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(OPENING_RETRY_MS * 3)
    expect(h.projectUIPatch).toHaveBeenCalledTimes(2)
    await h.sync.stop()
  })
})

describe('UIProjectionSync previews', () => {
  it('asks for previews on the attach and forwards them until stopped', async () => {
    const iterator = {
      next: () => new Promise<IteratorResult<LedgerEvent>>(() => undefined),
      return: vi.fn(async () => ({ done: true, value: undefined }) as IteratorResult<LedgerEvent>),
    }
    const events = vi.fn((_opts?: unknown) => ({ [Symbol.asyncIterator]: () => iterator }))
    let deliver: ((p: unknown) => void) | undefined
    const off = vi.fn()
    const onPreview = vi.fn((fn: (p: unknown) => void) => {
      deliver = fn
      return off
    })
    const preview = vi.fn()
    const sync = new UIProjectionSync(
      {
        events,
        onPreview,
        projectUIOpening: async () => open(3, []),
        projectUIHistory: async () => {
          throw new Error('no history')
        },
        projectUIPatch: async () => {
          throw new Error('no patch')
        },
      } as never,
      { timeline: vi.fn(), preview, error: vi.fn() },
    )
    await sync.start()
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ preview: true }))
    const p = { sessionId: 's', lane: 'main', effectId: 'e1', stream: 'text', offset: 0, delta: 'hi' }
    deliver?.(p)
    expect(preview).toHaveBeenCalledWith(p)
    await sync.stop()
    expect(off).toHaveBeenCalled()
    deliver?.(p)
    expect(preview).toHaveBeenCalledTimes(1)
  })
})
