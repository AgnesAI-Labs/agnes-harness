import type {
  SessionPreviewParams,
  UINode,
  UIOpeningResult,
  UIProjectionUpdate,
  UITimeline,
} from '@agnes/protocol'
import type { LedgerEvent } from '@agnes/sdk/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APPROVAL_SEARCH_PAGES,
  approvalOutsideWindow,
  createLiveProjection,
  findApproval,
} from '../src/live-projection.js'
import { receiptFromTurns } from '../src/view.js'

afterEach(() => vi.useRealTimers())

/**
 * A daemon stand-in that folds its own ledger the way Core does for these rows: a user node per
 * message, and one assistant node per inference, created empty by its `assistant/output` start
 * marker and finished by its assistant/message. Streamed text never enters the ledger; it reaches
 * the client only as previews. Opening and patch both answer from the head at the time of the call.
 */
function daemon(history = 0) {
  const ledger: LedgerEvent[] = []
  let receive: ((value: IteratorResult<LedgerEvent>) => void) | undefined
  const queue: LedgerEvent[] = []
  const previewListeners = new Set<(p: SessionPreviewParams) => void>()
  const deliver = () => {
    const next = queue.shift()
    if (next && receive) {
      const r = receive
      receive = undefined
      r({ done: false, value: next })
    }
  }
  const fold = (upto: number): UITimeline => {
    const nodes: UINode[] = []
    const streams = new Map<string, Extract<UINode, { kind: 'assistant' }>>()
    for (const event of ledger) {
      if (event.seq > upto) break
      const data = event.data as { effectId?: string; state?: string; text?: string }
      if (event.type === 'user/message')
        nodes.push({
          kind: 'user',
          id: event.id,
          seq: event.seq,
          content: [{ type: 'text', text: data.text ?? '' }],
        })
      if (event.type === 'assistant/output' && data.state === 'started') {
        const node: Extract<UINode, { kind: 'assistant' }> = {
          kind: 'assistant',
          id: event.id,
          seq: event.seq,
          text: '',
          streaming: true,
          effectId: data.effectId ?? '',
        }
        streams.set(data.effectId ?? '', node)
        nodes.push(node)
      }
      if (event.type === 'assistant/message') {
        const node = streams.get(data.effectId ?? '')
        if (node) {
          node.text = data.text ?? node.text
          node.streaming = false
        }
      }
    }
    return {
      sessionId: 's',
      generation: 1,
      upto,
      opState: null,
      nodes: nodes.map((node) => ({ ...node })),
      turns: [],
    }
  }
  const head = () => ledger.at(-1)?.seq ?? 0
  const projectUIOpening = vi.fn(async (_opts?: unknown): Promise<UIOpeningResult> => {
    const timeline = fold(head())
    return { timeline, history: { hasEarlier: false, startIndex: 0, totalNodes: timeline.nodes.length } }
  })
  let hold: Promise<void> | undefined
  const projectUIPatch = vi.fn(
    async (after: number, _upto?: number, _opts?: unknown): Promise<UIProjectionUpdate> => {
      const upto = head()
      await hold
      const timeline = fold(upto)
      return {
        kind: 'patch',
        patch: {
          sessionId: 's',
          generation: 1,
          from: after,
          upto,
          totalNodes: timeline.nodes.length,
          opState: null,
          changes: timeline.nodes.map((node, index) => ({ op: 'upsert', index, node })),
          turnChanges: [],
        },
      }
    },
  )
  const events = vi.fn((_opts?: unknown) => ({
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<LedgerEvent>>((resolve) => {
          receive = resolve
          deliver()
        }),
      return: async () => ({ done: true, value: undefined }) as IteratorResult<LedgerEvent>,
    }),
  }))
  const onPreview = vi.fn((fn: (p: SessionPreviewParams) => void) => {
    previewListeners.add(fn)
    return () => {
      previewListeners.delete(fn)
    }
  })
  let seq = 0
  const append = (type: string, data: unknown): LedgerEvent => {
    const event = { seq: ++seq, id: `ev-${seq}`, type, data } as unknown as LedgerEvent
    ledger.push(event)
    return event
  }
  for (let i = 0; i < history; i++) append('user/message', { text: `history ${i}` })
  return {
    session: { events, onPreview, projectUIOpening, projectUIPatch, projectUIHistory: vi.fn() },
    events,
    projectUIOpening,
    projectUIPatch,
    /** Appends and notifies, as the daemon does with a committed row. */
    async write(type: string, data: unknown) {
      queue.push(append(type, data))
      deliver()
      await Promise.resolve()
      await Promise.resolve()
    },
    /** Sends streamed text, which the ledger never sees. */
    preview(effectId: string, offset: number, delta: string, stream: 'text' | 'thinking' = 'text') {
      for (const fn of previewListeners) fn({ sessionId: 's', lane: 'main', effectId, stream, offset, delta })
    },
    holdPatches() {
      let release!: () => void
      hold = new Promise((resolve) => {
        release = resolve
      })
      return () => {
        hold = undefined
        release()
      }
    },
  }
}

const connected = { connectionState: 'connected', on: () => () => undefined } as never
const started = (effectId: string) => ({
  state: 'started',
  effectId,
  chars: { text: 0, thinking: 0 },
  estimatedTokens: 0,
})

function sink() {
  const timelines: UITimeline[] = []
  let shown: UITimeline | undefined
  let streamed = 0
  return {
    timelines,
    shown: () => shown,
    streamed: () => streamed,
    text: (id: string) => {
      const node = shown?.nodes.find((candidate) => candidate.id === id)
      return node?.kind === 'assistant' ? node.text : undefined
    },
    sink: {
      timeline(value: UITimeline) {
        timelines.push(value)
        shown = value
      },
      stream(value: UITimeline) {
        streamed++
        shown = value
      },
      event: vi.fn(),
      error: vi.fn(),
    },
  }
}

describe('Web live projection', () => {
  it('opens once with a bounded window and attaches from the opening cut, never replaying history', async () => {
    vi.useFakeTimers()
    const d = daemon(40)
    const s = sink()
    const live = createLiveProjection(d.session as never, connected, s.sink)
    await live.start()
    expect(d.projectUIOpening).toHaveBeenCalledTimes(1)
    expect(d.projectUIOpening).toHaveBeenCalledWith({ surface: 'web', maxNodes: 500, maxBytes: 1_048_576 })
    expect(d.events).toHaveBeenCalledWith({ preview: true, cursor: { fromSeq: 40, generation: 1 } })
    expect(d.projectUIPatch).not.toHaveBeenCalled()
    await live.stop()
  })

  it('folds a burst of 20 persistent events into at most two patches', async () => {
    vi.useFakeTimers()
    const d = daemon()
    const s = sink()
    const live = createLiveProjection(d.session as never, connected, s.sink)
    await live.start()
    for (let i = 0; i < 20; i++) await d.write('turn/start', {})
    await vi.advanceTimersByTimeAsync(200)
    expect(d.projectUIPatch.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(d.projectUIPatch.mock.calls.length).toBeLessThanOrEqual(2)
    expect(s.sink.event).toHaveBeenCalledTimes(20)
    await live.stop()
  })

  it('patches once for the stream start and shows exactly the text 200 previews carry', async () => {
    vi.useFakeTimers()
    const d = daemon()
    const s = sink()
    const live = createLiveProjection(d.session as never, connected, s.sink)
    await live.start()
    await d.write('assistant/output', started('e1'))
    await vi.advanceTimersByTimeAsync(60)
    expect(d.projectUIPatch).toHaveBeenCalledTimes(1)
    let expected = ''
    for (let i = 0; i < 200; i++) {
      const delta = `part ${i}. `
      d.preview('e1', expected.length, delta)
      expected += delta
    }
    await vi.advanceTimersByTimeAsync(200)
    expect(d.projectUIPatch).toHaveBeenCalledTimes(1)
    expect(s.text('ev-1')).toBe(expected)
    await d.write('assistant/message', { effectId: 'e1', text: expected })
    await vi.advanceTimersByTimeAsync(200)
    expect(d.projectUIPatch).toHaveBeenCalledTimes(2)
    expect(s.text('ev-1')).toBe(expected)
    await live.stop()
  })

  it('keeps two inferences apart, however their previews interleave', async () => {
    vi.useFakeTimers()
    const d = daemon()
    const s = sink()
    const live = createLiveProjection(d.session as never, connected, s.sink)
    await live.start()
    await d.write('assistant/output', started('e1'))
    await d.write('assistant/output', started('e2'))
    await vi.advanceTimersByTimeAsync(60)
    d.preview('e1', 0, 'one ')
    d.preview('e2', 0, 'two ')
    d.preview('e1', 4, 'more')
    expect(s.text('ev-1')).toBe('one more')
    expect(s.text('ev-2')).toBe('two ')
    await live.stop()
  })

  it('keeps previews that arrive before their node, and shows them once the node lands', async () => {
    vi.useFakeTimers()
    const d = daemon()
    const s = sink()
    const live = createLiveProjection(d.session as never, connected, s.sink)
    await live.start()
    const release = d.holdPatches()
    await d.write('assistant/output', started('e1'))
    await vi.advanceTimersByTimeAsync(60)
    d.preview('e1', 0, 'early ')
    d.preview('e1', 6, 'text')
    expect(s.streamed()).toBe(0)
    release()
    await vi.advanceTimersByTimeAsync(60)
    expect(s.text('ev-1')).toBe('early text')
    await live.stop()
  })

  it('lays the streamed text back over every install, which leaves streaming nodes empty', async () => {
    vi.useFakeTimers()
    const d = daemon()
    const s = sink()
    const live = createLiveProjection(d.session as never, connected, s.sink)
    await live.start()
    await d.write('assistant/output', started('e1'))
    await vi.advanceTimersByTimeAsync(60)
    d.preview('e1', 0, 'so far')
    await d.write('turn/start', {})
    await vi.advanceTimersByTimeAsync(60)
    expect(d.projectUIPatch).toHaveBeenCalledTimes(2)
    expect(s.text('ev-1')).toBe('so far')
    await live.resync()
    expect(s.text('ev-1')).toBe('so far')
    await live.stop()
  })

  it('ignores previews for an inference whose answer has landed', async () => {
    vi.useFakeTimers()
    const d = daemon()
    const s = sink()
    const live = createLiveProjection(d.session as never, connected, s.sink)
    await live.start()
    await d.write('assistant/output', started('e1'))
    await vi.advanceTimersByTimeAsync(60)
    d.preview('e1', 0, 'draft')
    await d.write('assistant/message', { effectId: 'e1', text: 'final' })
    await vi.advanceTimersByTimeAsync(60)
    expect(s.text('ev-1')).toBe('final')
    d.preview('e1', 5, ' late')
    expect(s.text('ev-1')).toBe('final')
    await live.stop()
  })

  it('rejects start() when the first opening fails', async () => {
    const d = daemon()
    d.projectUIOpening.mockRejectedValueOnce(
      Object.assign(new Error('too large'), { data: { code: 'UI_PROJECTION_NODE_TOO_LARGE' } }),
    )
    const live = createLiveProjection(d.session as never, connected, sink().sink)
    await expect(live.start()).rejects.toThrow('too large')
  })
})

describe('receipt seeding', () => {
  it('stands the last loaded turn in for the history that is no longer replayed', () => {
    expect(receiptFromTurns([])).toBeUndefined()
    expect(
      receiptFromTurns([
        { startSeq: 1, endSeq: 5, reason: 'error' },
        { startSeq: 6, endSeq: 9, reason: 'completed' },
      ] as never),
    ).toEqual({ startSeq: 6, endSeq: 9, reason: 'completed' })
    expect(receiptFromTurns([{ startSeq: 6 }] as never)).toEqual({ startSeq: 6, endSeq: 0 })
  })
})

describe('a pending approval before the loaded window', () => {
  const parked = (withNode: boolean): UITimeline =>
    ({
      sessionId: 's',
      generation: 1,
      upto: 9,
      opState: {
        turn: 1,
        step: 1,
        phase: 'tools',
        parked: { ticket: 't', expiresAt: '2026-09-25T00:00:00Z' },
      },
      nodes: withNode
        ? [{ kind: 'approval', id: 'ap', seq: 3, state: 'pending', ticket: 't', summary: 's', options: [] }]
        : [],
      turns: [],
    }) as unknown as UITimeline

  it('is recognised only when the session is parked and no pending approval node is loaded', () => {
    expect(approvalOutsideWindow(parked(false))).toBe(true)
    expect(approvalOutsideWindow(parked(true))).toBe(false)
    expect(approvalOutsideWindow({ ...parked(false), opState: null })).toBe(false)
  })

  it('loads up to the page limit, then reports it not found', async () => {
    let pages = 0
    const live = {
      hasEarlier: () => true,
      loadEarlier: vi.fn(async () => {
        pages++
        return true
      }),
    }
    expect(await findApproval(live, () => parked(false), APPROVAL_SEARCH_PAGES)).toBe(false)
    expect(pages).toBe(APPROVAL_SEARCH_PAGES)
  })

  it('stops as soon as the approval is loaded, or when nothing earlier is left', async () => {
    let loaded = false
    const live = {
      hasEarlier: () => true,
      loadEarlier: vi.fn(async () => {
        loaded = true
        return true
      }),
    }
    expect(await findApproval(live, () => parked(loaded))).toBe(true)
    expect(live.loadEarlier).toHaveBeenCalledTimes(1)
    const empty = { hasEarlier: () => false, loadEarlier: vi.fn(async () => true) }
    expect(await findApproval(empty, () => parked(false))).toBe(false)
    expect(empty.loadEarlier).not.toHaveBeenCalled()
  })
})
