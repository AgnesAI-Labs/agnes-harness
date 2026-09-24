import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalEndpoint } from '@agnes/daemon/local'
import { createTestHost } from '@agnes/host/testkit'
import type {
  SessionPreviewParams,
  UIHistoryPage,
  UIOpeningResult,
  UIProjectionUpdate,
  UITimeline,
} from '@agnes/protocol'
import { createClient, type LedgerEvent } from '@agnes/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import {
  applyUITimelinePatch,
  applyWindowedUITimelinePatch,
  OPENING_RETRY_MS,
  TuiProjection,
  type TuiProjectionWindow,
} from '../../src/tui/projection.js'
import { say } from '../boot-host.js'

afterEach(() => vi.useRealTimers())

it('subscribes to actual core events and projects through daemon and SDK; stop releases its listener', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-tui-projection-'))
  const { host } = await createTestHost({ dataDir: dir, script: [say('projected answer')] })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let projection: TuiProjection | undefined
  try {
    await client.workspace.add(dir)
    const session = await client.session.new({ cwd: dir })
    const timelines: UITimeline[] = []
    const windows: TuiProjectionWindow[] = []
    const previews: SessionPreviewParams[] = []
    const errors: unknown[] = []
    const before = session.listeners.size
    projection = new TuiProjection(session, {
      timeline: (timeline, window) => {
        timelines.push(timeline)
        windows.push(window)
      },
      preview: (p) => previews.push(p),
      error: (error) => errors.push(error),
    })
    await projection.start()
    expect(timelines[0]).toMatchObject({ sessionId: session.id, generation: 1 })
    expect(windows[0]).toMatchObject({ reason: 'opening', startIndex: 0 })
    expect(endpoint.conn.attached.get(session.id)?.cursor).toEqual({
      fromSeq: timelines[0]?.upto,
      generation: timelines[0]?.generation,
    })
    await session.prompt('actual question')
    await vi.waitFor(() => expect(JSON.stringify(timelines.at(-1)?.nodes)).toContain('projected answer'))
    expect(JSON.stringify(timelines.at(-1)?.nodes)).toContain('actual question')
    expect(windows.filter((window) => window.reason === 'opening')).toHaveLength(1)
    expect(previews.map((p) => p.delta).join('')).toContain('projected answer')
    expect(errors).toEqual([])
    // One listener for ledger rows, one for streamed-text previews.
    expect(session.listeners.size).toBe(before + 2)
    await projection.stop()
    expect(session.listeners.size).toBe(before)
    expect(session.closed).toBe(false)
  } finally {
    await projection?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('opens and pages a 10k SQLite session, then completes two incremental turns without replaying history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-tui-long-projection-'))
  const { host } = await createTestHost({
    dataDir: dir,
    script: [say('historical answer'), say('first live answer'), say('second live answer')],
  })
  const opened = vi.spyOn(host, 'createSession')
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let projection: TuiProjection | undefined
  try {
    await client.workspace.add(dir)
    const session = await client.session.new({ cwd: dir })
    await session.prompt('historical question')
    const core = await opened.mock.results[0]?.value
    if (!core) throw new Error('missing real SQLite-backed HostSession')
    const actor = { id: 'seed', org: 'local', role: 'owner', deptPath: [], attrs: {} }
    await core.append(
      Array.from({ length: 10_001 }, (_, index) => ({
        type: 'user/message',
        data: { content: [{ type: 'text', text: `seed ${index + 1}` }] },
        actor,
        origin: 'principal' as const,
        trust: 'trusted' as const,
      })),
    )
    // The ordinary ACP feed also observes the seed transaction. Let the in-process transport drain
    // those unrelated updates before measuring the raw attach feed's own bounded queue.
    await vi.waitFor(() => expect(endpoint.pending().events).toBe(0), { timeout: 5_000 })

    const timelines: UITimeline[] = []
    const windows: TuiProjectionWindow[] = []
    const previews: SessionPreviewParams[] = []
    const errors: unknown[] = []
    projection = new TuiProjection(session, {
      timeline: (timeline, window) => {
        timelines.push(timeline)
        windows.push(window)
      },
      preview: (p) => previews.push(p),
      error: (error) => errors.push(error),
    })
    await projection.start()
    const opening = timelines.at(-1)
    expect(opening?.upto).toBeGreaterThan(10_000)
    expect(opening?.nodes.length).toBeLessThanOrEqual(200)
    expect(windows.at(-1)).toMatchObject({ reason: 'opening', hasEarlier: true })
    expect(windows.at(-1)?.totalNodes).toBeGreaterThan(10_000)
    expect(previews).toEqual([])
    expect(endpoint.conn.attached.get(session.id)?.cursor.fromSeq).toBe(opening?.upto)

    const attachCursor = structuredClone(endpoint.conn.attached.get(session.id)?.cursor)
    const openingStart = windows.at(-1)?.startIndex
    expect(await projection.loadEarlier()).toBe(true)
    expect(windows.at(-1)).toMatchObject({ reason: 'history', hasEarlier: true })
    expect(windows.at(-1)?.startIndex).toBeLessThan(openingStart ?? 0)
    expect(new Set(timelines.at(-1)?.nodes.map((node) => node.id)).size).toBe(timelines.at(-1)?.nodes.length)
    expect(endpoint.conn.attached.get(session.id)?.cursor).toEqual(attachCursor)

    await session.prompt('first live question')
    await vi.waitFor(
      () => {
        expect(errors).toEqual([])
        expect(
          timelines.at(-1)?.nodes.some((node) => JSON.stringify(node).includes('first live answer')),
        ).toBe(true)
      },
      { timeout: 5_000 },
    )
    expect(endpoint.conn.attached.has(session.id)).toBe(true)
    await session.prompt('second live question')
    await vi.waitFor(
      () => {
        expect(errors).toEqual([])
        expect(JSON.stringify(timelines.at(-1)?.nodes)).toContain('second live answer')
      },
      { timeout: 5_000 },
    )

    const complete = await session.projectUI(undefined, { surface: 'tui' })
    // Assistant output can become visible just before the trailing usage/cost transaction is
    // committed. The live projection intentionally coalesces those durable events for 50ms, so
    // assert convergence at the authoritative ledger watermark instead of racing that window.
    await vi.waitFor(() => expect(timelines.at(-1)?.upto).toBe(complete.upto), { timeout: 5_000 })
    const final = timelines.at(-1)
    const finalWindow = windows.at(-1)
    expect(final?.nodes).toEqual(complete.nodes.slice(finalWindow?.startIndex))
    expect(new Set(final?.nodes.map((node) => node.id)).size).toBe(final?.nodes.length)
    expect(previews.length).toBeGreaterThan(0)
    expect(errors).toEqual([])
  } finally {
    await projection?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

function controlled() {
  let receive: ((result: IteratorResult<LedgerEvent>) => void) | undefined
  const iterator: AsyncIterator<LedgerEvent> = {
    next: () =>
      new Promise((resolve) => {
        receive = resolve
      }),
    return: vi.fn(async () => {
      receive?.({ done: true, value: undefined })
      return { done: true as const, value: undefined }
    }),
  }
  const timeline: UITimeline = { sessionId: 's', generation: 1, upto: 0, opState: null, turns: [], nodes: [] }
  const projectUIOpening = vi.fn(
    async (_opts?: { surface?: 'tui' | 'web' | 'channel' }): Promise<UIOpeningResult> => ({
      timeline,
      history: { hasEarlier: false, startIndex: 0, totalNodes: 0 },
    }),
  )
  const projectUIHistory = vi.fn(async (): Promise<UIHistoryPage> => {
    throw new Error('no history')
  })
  const projectUIPatch = vi.fn(
    async (
      after: number,
      upto?: number,
      _opts?: { surface?: 'tui' | 'web' | 'channel' },
    ): Promise<UIProjectionUpdate> => ({
      kind: 'patch' as const,
      patch: {
        sessionId: 's',
        generation: 1,
        from: after,
        upto: upto ?? after,
        totalNodes: 0,
        opState: null,
        changes: [],
        turnChanges: [],
      },
    }),
  )
  const events = vi.fn(() => ({ [Symbol.asyncIterator]: () => iterator }))
  const sink = { timeline: vi.fn(), error: vi.fn() }
  const projection = new TuiProjection({ events, projectUIOpening, projectUIHistory, projectUIPatch }, sink)
  return {
    projection,
    projectUIOpening,
    projectUIHistory,
    projectUIPatch,
    events,
    sink,
    iterator,
    timeline,
    async emit(seq: number, type = 'turn/start') {
      // This controlled stream tests scheduling only; real events are verified above.
      receive?.({ done: false, value: { seq, type } as LedgerEvent })
      await Promise.resolve()
    },
  }
}

it('uses the default 50ms window and coalesces sequence cuts', async () => {
  vi.useFakeTimers()
  const c = controlled()
  await c.projection.start()
  expect(c.projectUIOpening).toHaveBeenCalledWith({ surface: 'tui' })
  await c.emit(1)
  await c.emit(2)
  await vi.advanceTimersByTimeAsync(49)
  expect(c.projectUIPatch).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(c.projectUIPatch).toHaveBeenLastCalledWith(0, undefined, { surface: 'tui' })
  expect(c.projectUIOpening).toHaveBeenCalledTimes(1)
  await c.projection.stop()
})

it('serializes slow projections and suppresses late results after stop', async () => {
  vi.useFakeTimers()
  const c = controlled()
  await c.projection.start()
  let finish!: (value: UIProjectionUpdate) => void
  c.projectUIPatch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await c.emit(1)
  await vi.advanceTimersByTimeAsync(50)
  await c.emit(2)
  await vi.advanceTimersByTimeAsync(500)
  expect(c.projectUIPatch).toHaveBeenCalledTimes(1)
  await c.projection.stop()
  finish({ kind: 'replace', timeline: { ...c.timeline, upto: 1 } })
  await vi.advanceTimersByTimeAsync(500)
  expect(c.projectUIPatch).toHaveBeenCalledTimes(1)
  expect(c.projectUIOpening).toHaveBeenCalledTimes(1)
  expect(c.sink.timeline).toHaveBeenCalledTimes(1)
  expect(c.iterator.return).toHaveBeenCalledTimes(1)
})

it('reports projection failure and recovers on the next event', async () => {
  vi.useFakeTimers()
  const c = controlled()
  c.projectUIPatch.mockRejectedValueOnce(new Error('unavailable'))
  await c.projection.start()
  await c.emit(1)
  await vi.advanceTimersByTimeAsync(50)
  expect(c.sink.error).toHaveBeenCalledTimes(1)
  await c.emit(2)
  await vi.advanceTimersByTimeAsync(50)
  expect(c.sink.timeline).toHaveBeenCalledTimes(2)
  await c.projection.stop()
  await expect(c.projection.start()).rejects.toThrow('already started or stopped')
})

it('does not attach from zero when the opening snapshot fails', async () => {
  vi.useFakeTimers()
  const c = controlled()
  c.projectUIOpening.mockRejectedValueOnce(new Error('unavailable'))
  await c.projection.start()
  expect(c.sink.error).toHaveBeenCalledTimes(1)
  expect(c.events).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(500)
  expect(c.projectUIOpening).toHaveBeenCalledTimes(2)
  expect(c.events).toHaveBeenCalledWith({ cursor: { fromSeq: 0, generation: 1 } })
  await c.projection.stop()
})

it('suppresses replayed history during catch-up: no per-event reproject', async () => {
  vi.useFakeTimers()
  const c = controlled()
  // History exists: the first projection reports the ledger is already at seq 10.
  c.projectUIOpening.mockImplementation(async () => ({
    timeline: { ...c.timeline, upto: 10 },
    history: { hasEarlier: false, startIndex: 0, totalNodes: 0 },
  }))
  await c.projection.start()
  expect(c.events).toHaveBeenCalledWith({ cursor: { fromSeq: 10, generation: 1 } })
  // Even a broken transport replay is suppressed defensively by the projection watermark.
  for (let seq = 1; seq <= 10; seq++) await c.emit(seq, 'turn/start')
  expect(c.projectUIPatch).not.toHaveBeenCalled()
  // Events past the watermark behave as before and schedule a reproject.
  await c.emit(12)
  await vi.advanceTimersByTimeAsync(50)
  expect(c.projectUIPatch).toHaveBeenLastCalledWith(10, undefined, { surface: 'tui' })
  await c.projection.stop()
})

it('projects immediately on a user message, without waiting out the debounce', async () => {
  vi.useFakeTimers()
  const c = controlled()
  await c.projection.start()
  await c.emit(1)
  await c.emit(2, 'user/message')
  expect(c.projectUIPatch).toHaveBeenLastCalledWith(0, undefined, { surface: 'tui' })
  expect(c.projectUIOpening).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(500)
  expect(c.projectUIPatch).toHaveBeenCalledTimes(1)
  await c.projection.stop()
})

it('applies remove/upsert patches and rejects a mismatched projection cursor', () => {
  const current: UITimeline = {
    sessionId: 's',
    generation: 1,
    upto: 2,
    opState: null,
    turns: [
      {
        id: 'turn:1',
        turn: 1,
        startSeq: 1,
        startedAt: '2026-09-13T00:00:00.000Z',
        status: 'running',
        nodeIds: ['u', 'a'],
        usage: {
          totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          reasoningComplete: false,
          billingComplete: false,
          calls: [],
        },
        inherited: false,
        forkable: false,
      },
    ],
    nodes: [
      { kind: 'user', id: 'u', seq: 1, content: [{ type: 'text', text: 'hi' }] },
      { kind: 'assistant', id: 'a', seq: 2, text: 'partial', streaming: true },
    ],
  }
  const firstTurn = current.turns[0]
  if (!firstTurn) throw new Error('fixture must contain one turn')
  const patch = {
    sessionId: 's',
    generation: 1,
    from: 2,
    upto: 3,
    opState: null,
    changes: [
      { op: 'remove' as const, id: 'u' },
      {
        op: 'upsert' as const,
        index: 0,
        node: { kind: 'assistant' as const, id: 'a', seq: 2, text: 'done', streaming: false },
      },
    ],
    turnChanges: [
      {
        op: 'upsert' as const,
        index: 0,
        turn: {
          ...firstTurn,
          endSeq: 3,
          endedAt: '2026-09-13T00:00:01.000Z',
          durationMs: 1_000,
          status: 'completed' as const,
          reason: 'completed' as const,
          forkable: true,
        },
      },
    ],
  }
  expect(applyUITimelinePatch(current, patch)).toMatchObject({
    upto: 3,
    turns: [{ id: 'turn:1', status: 'completed', endSeq: 3, forkable: true }],
    nodes: [{ id: 'a', text: 'done', streaming: false }],
  })
  expect(() => applyUITimelinePatch(current, { ...patch, from: 1 })).toThrow('UI_PROJECTION_CURSOR_MISMATCH')
  expect(() =>
    applyUITimelinePatch(current, {
      ...patch,
      changes: [{ op: 'remove', id: 'missing' }],
    }),
  ).toThrow('UI_PROJECTION_UNKNOWN_REMOVE')
})

const projectedUser = (id: string, seq: number, text = id) => ({
  kind: 'user' as const,
  id,
  seq,
  content: [{ type: 'text' as const, text }],
})

it('maps global patch indexes onto a retained suffix window', () => {
  const current: UITimeline = {
    sessionId: 's',
    generation: 1,
    upto: 10,
    opState: null,
    turns: [],
    nodes: [projectedUser('eight', 8), projectedUser('nine', 9)],
  }
  const result = applyWindowedUITimelinePatch(
    current,
    { startIndex: 8, totalNodes: 10 },
    {
      sessionId: 's',
      generation: 1,
      from: 10,
      upto: 11,
      totalNodes: 11,
      opState: null,
      changes: [
        { op: 'upsert', index: 2, node: projectedUser('old-two', 2, 'enriched') },
        { op: 'upsert', index: 10, node: projectedUser('ten', 11) },
      ],
      turnChanges: [],
    },
  )
  expect(result.coordinates).toEqual({ startIndex: 8, totalNodes: 11 })
  expect(result.timeline.nodes.map((node) => node.id)).toEqual(['eight', 'nine', 'ten'])
  expect(result.unseen.map(({ id, index }) => [id, index])).toEqual([
    ['old-two', 2],
    ['ten', 10],
  ])
})

it('loads fixed-cut history without moving the live attach cursor and applies a deferred stable overlay', async () => {
  vi.useFakeTimers()
  const c = controlled()
  const oldTwo = {
    kind: 'tool' as const,
    id: 'old-two',
    seq: 3,
    toolUseId: 'call-two',
    name: 'read',
    status: 'completed' as const,
    summary: 'old',
  }
  c.projectUIOpening.mockResolvedValue({
    timeline: {
      sessionId: 's',
      generation: 1,
      upto: 10,
      opState: null,
      turns: [],
      nodes: [projectedUser('eight', 8), projectedUser('nine', 9)],
    },
    history: { hasEarlier: true, cursor: 'before-8', startIndex: 8, totalNodes: 10 },
  })
  c.projectUIPatch.mockResolvedValue({
    kind: 'patch',
    patch: {
      sessionId: 's',
      generation: 1,
      from: 10,
      upto: 11,
      totalNodes: 11,
      opState: null,
      changes: [
        { op: 'upsert', index: 2, node: { ...oldTwo, summary: 'enriched after opening' } },
        { op: 'upsert', index: 10, node: projectedUser('ten', 11) },
      ],
      turnChanges: [],
    },
  })
  c.projectUIHistory.mockResolvedValue({
    sessionId: 's',
    generation: 1,
    cut: 10,
    turns: [],
    nodes: [
      projectedUser('zero', 1),
      projectedUser('one', 2),
      oldTwo,
      ...Array.from({ length: 5 }, (_, index) => projectedUser(`old-${index + 3}`, index + 4)),
    ],
    hasEarlier: false,
    startIndex: 0,
    totalNodes: 10,
  })

  await c.projection.start()
  await c.emit(11, 'user/message')
  await vi.runAllTimersAsync()
  await vi.waitFor(() => expect(c.sink.timeline).toHaveBeenCalledTimes(2))
  expect(await c.projection.loadEarlier()).toBe(true)
  const [timeline, window] = c.sink.timeline.mock.calls.at(-1) as [UITimeline, TuiProjectionWindow]
  expect(timeline.nodes).toHaveLength(11)
  expect(timeline.nodes.find((node) => node.id === 'old-two')).toMatchObject({
    summary: 'enriched after opening',
  })
  expect(window).toEqual({ startIndex: 0, totalNodes: 11, hasEarlier: false, reason: 'history' })
  expect(c.events).toHaveBeenCalledTimes(1)
  expect(c.events).toHaveBeenCalledWith({ cursor: { fromSeq: 10, generation: 1 } })
  await c.projection.stop()
})

it.each([
  ['cross-generation', { generation: 2 }],
  ['wrong-cut', { cut: 9 }],
  ['wrong-total', { totalNodes: 11 }],
  ['non-contiguous', { startIndex: 5 }],
])('silently re-opens after a %s history page', async (_name, override) => {
  const c = controlled()
  const opening: UIOpeningResult = {
    timeline: {
      sessionId: 's',
      generation: 1,
      upto: 10,
      opState: null,
      turns: [],
      nodes: [projectedUser('eight', 8), projectedUser('nine', 9)],
    },
    history: { hasEarlier: true, cursor: 'before-8', startIndex: 8, totalNodes: 10 },
  }
  c.projectUIOpening.mockResolvedValue(opening)
  c.projectUIHistory.mockResolvedValue({
    sessionId: 's',
    generation: 1,
    cut: 10,
    turns: [],
    nodes: [projectedUser('six', 6), projectedUser('seven', 7)],
    hasEarlier: true,
    cursor: 'before-6',
    startIndex: 6,
    totalNodes: 10,
    ...override,
  })
  await c.projection.start()
  expect(await c.projection.loadEarlier()).toBe(false)
  expect(c.projectUIOpening).toHaveBeenCalledTimes(2)
  expect(c.sink.error).not.toHaveBeenCalled()
  expect(c.sink.timeline.mock.calls.at(-1)?.[1]).toMatchObject({ reason: 'opening' })
  await c.projection.stop()
})

it('silently re-opens on the window resync signal and on deferred overlay overflow', async () => {
  vi.useFakeTimers()
  const c = controlled()
  c.projectUIOpening.mockResolvedValue({
    timeline: {
      sessionId: 's',
      generation: 1,
      upto: 10,
      opState: null,
      turns: [],
      nodes: [projectedUser('tail', 10)],
    },
    history: { hasEarlier: true, cursor: 'before-tail', startIndex: 999, totalNodes: 1_000 },
  })
  c.projectUIPatch.mockRejectedValueOnce(
    Object.assign(new Error('resync'), { data: { code: 'UI_PROJECTION_RESYNC_REQUIRED' } }),
  )
  await c.projection.start()
  await c.emit(11, 'user/message')
  await vi.runAllTimersAsync()
  await vi.waitFor(() => expect(c.projectUIOpening).toHaveBeenCalledTimes(2))
  expect(c.sink.error).not.toHaveBeenCalled()

  c.projectUIPatch.mockResolvedValueOnce({
    kind: 'patch',
    patch: {
      sessionId: 's',
      generation: 1,
      from: 10,
      upto: 12,
      totalNodes: 1_000,
      opState: null,
      changes: Array.from({ length: 513 }, (_, index) => ({
        op: 'upsert' as const,
        index,
        node: projectedUser(`prefix-${index}`, 1),
      })),
      turnChanges: [],
    },
  })
  await c.emit(12, 'user/message')
  await vi.runAllTimersAsync()
  await vi.waitFor(() => expect(c.projectUIOpening).toHaveBeenCalledTimes(3))
  expect(c.sink.error).not.toHaveBeenCalled()
  await c.projection.stop()
})

it('invalidates a resync baseline until a failed opening retry eventually succeeds', async () => {
  vi.useFakeTimers()
  const c = controlled()
  const opening: UIOpeningResult = {
    timeline: c.timeline,
    history: { hasEarlier: false, startIndex: 0, totalNodes: 0 },
  }
  c.projectUIOpening
    .mockResolvedValueOnce(opening)
    .mockRejectedValueOnce(new Error('opening temporarily unavailable'))
    .mockResolvedValue(opening)
  c.projectUIPatch.mockRejectedValueOnce(
    Object.assign(new Error('resync'), { data: { code: 'UI_PROJECTION_RESYNC_REQUIRED' } }),
  )

  await c.projection.start()
  await c.emit(1, 'user/message')
  await vi.waitFor(() => expect(c.projectUIOpening).toHaveBeenCalledTimes(2))
  expect(c.projectUIPatch).toHaveBeenCalledTimes(1)

  // More dirty notifications may arrive while the old frame is retained, but the invalid cursor
  // must not be used again before the bounded opening retry succeeds.
  await c.emit(2, 'user/message')
  await vi.advanceTimersByTimeAsync(OPENING_RETRY_MS - 1)
  expect(c.projectUIOpening).toHaveBeenCalledTimes(2)
  expect(c.projectUIPatch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await vi.waitFor(() => expect(c.projectUIOpening).toHaveBeenCalledTimes(3))
  await vi.waitFor(() => expect(c.sink.timeline).toHaveBeenCalledTimes(2))
  await c.emit(3, 'user/message')
  await vi.waitFor(() => expect(c.projectUIPatch).toHaveBeenCalledTimes(2))
  expect(c.sink.error).not.toHaveBeenCalled()
  await c.projection.stop()
})
