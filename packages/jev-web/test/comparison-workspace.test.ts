/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import type {
  ComparisonCreateParams,
  ComparisonJournalEntry,
  ComparisonJournalParams,
  ComparisonLane,
  ComparisonListItem,
  ComparisonListParams,
  ComparisonListResult,
  ComparisonMetricsResult,
  ComparisonPriceDetailsResult,
  ComparisonSnapshot,
  ComparisonSubmitParams,
  EventEnvelope,
  RuntimeDescriptor,
  SessionPreviewParams,
  UITimeline,
} from '@agnes/protocol'
import { type Client, JsonRpcError, PreviewMerger } from '@agnes/sdk/browser'
import { buildTraceRows } from '@agnes/web-units'
import { afterEach, expect, it, vi } from 'vitest'
import { createComparisonChildHistory } from '../src/comparison-child-history.js'
import { createComparisonCutLedger } from '../src/comparison-cut-ledger.js'
import { type ComparisonJournalState, createComparisonJournal } from '../src/comparison-journal.js'
import { createComparisonLedger } from '../src/comparison-ledger.js'
import { createComparisonMetrics } from '../src/comparison-metrics.js'
import { createComparisonPriceDetails } from '../src/comparison-price-details.js'
import { comparisonReplayCuts, createComparisonReplay } from '../src/comparison-replay.js'
import { createComparisonWorkspace as mountComparisonWorkspace } from '../src/comparison-workspace.js'

function createComparisonWorkspace(
  client: Parameters<typeof mountComparisonWorkspace>[0],
  defaults: Parameters<typeof mountComparisonWorkspace>[1],
  navigation: Partial<Parameters<typeof mountComparisonWorkspace>[2]> = {},
) {
  return mountComparisonWorkspace(client, defaults, { host: document.body, ...navigation })
}

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Missing expected capture evidence')
  return value
}

const legacyJournal = async ({ id }: ComparisonJournalParams) => ({
  id,
  entries: [],
  afterSeq: 0,
  throughSeq: 0,
  nextAfterSeq: 0,
  complete: true,
})

const controllers = vi.hoisted(() => new Map<string, { disposed: boolean }>())
const openedSessions = vi.hoisted(() => new Set<string>())
type TestPermissionHandler = (
  request: import('@agnes/sdk/browser').PermissionRequest,
  context: { signal: AbortSignal },
) => Promise<import('@agnes/sdk/browser').PermissionOutcome>
const permissions = vi.hoisted(() => new Map<string, TestPermissionHandler>())
const disposeFailures = vi.hoisted(() => new Set<string>())
const openGates = vi.hoisted(() => new Map<string, Promise<void>>())
const timelines = vi.hoisted(() => new Map<string, UITimeline>())
const sinks = vi.hoisted(
  () =>
    new Map<
      string,
      {
        timeline(value: UITimeline): void
        stream?(value: UITimeline): void
        event?(value: EventEnvelope): void
      }
    >(),
)
vi.mock('@agnes/web-session-ui/session-pane', () => ({
  SessionPaneController: class {
    disposed = false
    constructor(
      _client: unknown,
      readonly id: string,
    ) {
      controllers.set(id, this)
    }
    async open(permission: TestPermissionHandler) {
      if (this.disposed) throw new Error('Disposed pane')
      await openGates.get(this.id)
      openedSessions.add(this.id)
      permissions.set(this.id, permission)
      return {}
    }
    project(sink: { timeline(value: UITimeline): void }) {
      sinks.set(this.id, sink)
      return {
        start: async () => {
          const value = timelines.get(this.id)
          if (value) sink.timeline(value)
        },
        stop: async () => {},
        refresh() {},
        hasEarlier: () => false,
        loadEarlier: async () => false,
      }
    }
    async dispose() {
      this.disposed = true
      if (disposeFailures.delete(this.id)) throw new Error('Detach transport lost')
    }
  },
}))
afterEach(async () => {
  document.querySelector('dialog')?.dispatchEvent(new Event('close'))
  await Promise.resolve()
  document.body.replaceChildren()
  sessionStorage.clear()
  controllers.clear()
  openGates.clear()
  openedSessions.clear()
  permissions.clear()
  disposeFailures.clear()
  timelines.clear()
  sinks.clear()
})

it('renders archived child history from a stored cut and retires late reads when the cursor changes', async () => {
  const capture = JSON.parse(
    readFileSync('packages/core/test/fixtures/comparison-real-journal.json', 'utf8'),
  ) as {
    reports: { lane: ComparisonLane; events: EventEnvelope[] }[]
  }
  const views = JSON.parse(
    readFileSync('packages/jev-web/test/fixtures/comparison-real-journal-views.json', 'utf8'),
  ) as {
    projections: { right: Record<string, Omit<UITimeline, 'generation'>> }
  }
  const child = required(Object.values(views.projections.right).at(-1))
  const childEvents = required(capture.reports.find((report) => report.lane.side === 'right')).events.filter(
    (event) => event.seq <= child.upto,
  )
  const parent = structuredClone(child)
  required(parent.turns[0]?.trace).childSessionKey = child.sessionId
  const host = document.createElement('section')
  document.body.append(host)
  let hold = false
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const projectUI = vi.fn(async () => {
    if (hold) await gate
    return {
      id: 'archived',
      side: 'right',
      atSeq: 20,
      sessionId: child.sessionId,
      throughSeq: child.upto,
      timeline: child,
    }
  })
  const events = vi.fn(async (input: { afterSeq: number }) => ({
    id: 'archived',
    side: 'right',
    atSeq: 20,
    sessionId: child.sessionId,
    throughSeq: child.upto,
    afterSeq: input.afterSeq,
    events: childEvents.filter((event) => event.seq > input.afterSeq),
    nextAfterSeq: child.upto,
    complete: true,
  }))
  const controller = createComparisonChildHistory(
    host,
    { comparison: { projectUI, events } } as unknown as Client,
    {
      id: 'archived',
      side: 'right',
    },
  )
  try {
    controller.render(parent, 20, true)
    required(host.querySelector('button')).click()
    const dialog = required(document.querySelector<HTMLDialogElement>('.comparison-child-history'))
    await vi.waitFor(() => expect(dialog.textContent).toContain(`已归档 · ${child.upto} 条记录`))
    expect(projectUI).toHaveBeenLastCalledWith({
      id: 'archived',
      side: 'right',
      atSeq: 20,
      memberSessionId: child.sessionId,
      surface: 'web',
    })
    expect(dialog.querySelector('.transcript')?.childElementCount).toBeGreaterThan(0)
    expect(openedSessions.size).toBe(0)
    hold = true
    required(host.querySelector('button')).click()
    await vi.waitFor(() => expect(projectUI).toHaveBeenCalledTimes(2))
    controller.render(parent, 19, true)
    finish()
    await Promise.resolve()
    expect(dialog.open).toBe(false)
    expect(events).toHaveBeenCalledTimes(1)
    controller.render(parent, 19, false)
    expect(host.querySelector('button')).toBeNull()
  } finally {
    controller.dispose()
  }
})

it('renders real transient thinking only over its committed live prefix and reuses conversation cards', async () => {
  const capture = JSON.parse(
    readFileSync('packages/core/test/fixtures/comparison-real-cancel.json', 'utf8'),
  ) as {
    pair: ComparisonSnapshot
    preview: SessionPreviewParams
    reports: {
      lane: ComparisonLane
      events: EventEnvelope[]
      replayProjections: { upto: number; timeline: Omit<UITimeline, 'generation'> }[]
    }[]
  }
  const byId = new Map(capture.reports.map((report) => [report.lane.sessionId, report]))
  const project = (id: string, cut: number): UITimeline => {
    const projection = byId.get(id)!.replayProjections.find((item) => item.upto === cut)!
    return { ...projection.timeline, generation: 1 }
  }
  let head = 17
  for (const report of capture.reports)
    timelines.set(report.lane.sessionId, project(report.lane.sessionId, head))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let holdHistory = false
  const call = vi.fn(
    async (method: string, params: { sessionId: string; upto?: number; afterSeq?: number }) => {
      if (method === '_agnes/v1/diagnostics.events') {
        const lastSeq = Math.min(head, byId.get(params.sessionId)!.events.at(-1)!.seq)
        return {
          events: byId
            .get(params.sessionId)!
            .events.filter((event) => event.seq > (params.afterSeq ?? 0) && event.seq <= lastSeq),
          lastSeq,
          nextAfterSeq: null,
        }
      }
      expect(method).toBe('_agnes/v1/session.projectUI')
      if (holdHistory && params.upto === 6) await gate
      return project(params.sessionId, params.upto!)
    },
  )
  const questionPending = vi.fn(async (sessionId: string) => ({
    sessionId,
    interactions: [
      {
        sessionId,
        interactionId: `question-${sessionId}`,
        writerRunId: 'writer',
        generation: 1,
        toolUseId: 'tool',
        turn: 1,
        callSeq: 16,
        requestedSeq: 17,
        request: { questions: [{ id: 'q', question: `当前 ${sessionId} 的问题` }] },
        policy: { allowSkip: false },
      },
    ],
  }))
  const client = {
    questions: { pending: questionPending, answer: vi.fn(), cancel: vi.fn() },
    call,
    comparison: {
      // Preview is observed before the capture's final cancellation settles.
      get: async () => ({
        ...capture.pair,
        phase: 'running',
        rounds: capture.pair.rounds.map((round) => ({ ...round, settledSides: [], terminalCauses: [] })),
      }),
      journal: legacyJournal,
    },
  } as unknown as Client
  sessionStorage.setItem('agnes-web-comparison', JSON.stringify({ id: capture.pair.id }))
  const workspace = createComparisonWorkspace(client, () => ({ runtimes: [descriptor], workspaces: [] }))
  await workspace.open()
  const sections = () =>
    [...document.querySelectorAll<HTMLElement>('.comparison-lane')].sort((a, b) =>
      (a.dataset.side ?? '').localeCompare(b.dataset.side ?? ''),
    )
  const cuts = () => sections().map((section) => Number(section.dataset.cut))
  const thinking = () => sections()[0]!.querySelector('.thinking-content')?.textContent?.trim()
  await vi.waitFor(() => expect(cuts()).toEqual([17, 17]))
  const stopBoth = required(
    [...document.querySelectorAll('button')].find((item) => item.textContent === '停止两侧'),
  )
  expect(stopBoth.disabled).toBe(false)
  await vi.waitFor(() => {
    for (const [index, lane] of capture.pair.lanes.entries()) {
      const host = required(
        sections()[index]?.querySelector<HTMLElement>(':scope > [data-agnes-region="questions"]'),
      )
      // An owner-only question is ahead of this captured ledger and must not leak into its cut.
      expect(host.hidden).toBe(true)
      expect(host.textContent).not.toContain(`当前 ${lane.sessionId} 的问题`)
      expect(questionPending).toHaveBeenCalledWith(lane.sessionId)
    }
  })
  expect(thinking()).toBeUndefined()
  const merger = new PreviewMerger()
  expect(merger.add(capture.preview)).toBe(true)
  const preview = merger.apply(project(capture.preview.sessionId, 17))
  const stream = (value: UITimeline) => sinks.get(capture.preview.sessionId)!.stream!(value)
  const trace = sections()[0]!.querySelector('.comparison-lane-body > details')!.innerHTML
  const nativeTrace = required(sections()[0]?.querySelector('.comparison-trace-panel')).innerHTML
  const graph = document.querySelector('.comparison-graph-column .jev-decision-graph')!.innerHTML
  stream({ ...preview, generation: 2 })
  expect(thinking()).toBeUndefined()
  stream({ ...preview, upto: 18 })
  expect(thinking()).toBeUndefined()
  stream({ ...preview, sessionId: capture.pair.lanes[1]!.sessionId })
  expect(thinking()).toBeUndefined()
  stream({
    ...preview,
    nodes: preview.nodes.map((node) =>
      node.kind === 'assistant' ? { ...node, effectId: 'stale-effect' } : node,
    ),
  })
  expect(thinking()).toBeUndefined()
  stream(preview)
  expect(thinking()).toBe('The')
  expect(sections()[0]!.querySelector<HTMLDetailsElement>('details.thinking')?.open).toBe(true)
  expect(sections()[0]!.querySelector('[data-node-kind="assistant"]')?.getAttribute('data-streaming')).toBe(
    'true',
  )
  expect(sections()[0]!.querySelector('.comparison-lane-body > details')!.innerHTML).toBe(trace)
  expect(sections()[0]!.querySelector('.comparison-trace-panel')?.innerHTML).toBe(nativeTrace)
  expect(document.querySelector('.comparison-graph-column .jev-decision-graph')!.innerHTML).toBe(graph)
  expect(
    document.querySelectorAll(
      '.comparison-transcript [data-node-kind="context"], .comparison-transcript [data-node-kind="context-sections"]',
    ),
  ).toHaveLength(0)
  expect(document.querySelectorAll('.comparison-transcript [aria-label="从此处创建分支"]')).toHaveLength(0)
  const slider = document.querySelector<HTMLInputElement>('[aria-label="双侧共享回放位置"]')!
  holdHistory = true
  slider.value = '6'
  slider.dispatchEvent(new Event('input'))
  expect(stopBoth.disabled).toBe(true)
  for (const section of sections())
    expect(required(section.querySelector<HTMLElement>('[data-agnes-region="questions"]')).hidden).toBe(true)
  expect(thinking()).toBeUndefined() // Remove the transient overlay before historical RPCs complete.
  expect(cuts()).toEqual([17, 17])
  stream(preview)
  expect(thinking()).toBeUndefined()
  const live = [...document.querySelectorAll<HTMLButtonElement>('.comparison-replay button')].find(
    (item) => item.textContent === '实时',
  )!
  live.click()
  await vi.waitFor(() => expect(thinking()).toBe('The'))
  expect(stopBoth.disabled).toBe(false)
  release()
  await Promise.resolve()
  await Promise.resolve()
  expect(cuts()).toEqual([17, 17])
  expect(thinking()).toBe('The') // A late old history ticket cannot replace the current live prefix.
  holdHistory = false
  slider.value = '17'
  slider.dispatchEvent(new Event('input'))
  await vi.waitFor(() =>
    expect(document.querySelector('.comparison-replay-status')?.textContent).toContain('同步步进 17'),
  )
  expect(thinking()).toBeUndefined()
  live.click()
  await vi.waitFor(() => expect(thinking()).toBe('The'))
  head = 35
  for (const report of capture.reports)
    sinks.get(report.lane.sessionId)!.timeline(project(report.lane.sessionId, report.events.at(-1)!.seq))
  await vi.waitFor(() => expect(cuts()).toEqual([24, 35]))
  expect(thinking()).toBe('The user asks me not to call any tools, and to')
  stream(preview)
  expect(thinking()).toBe('The user asks me not to call any tools, and to')
  expect(sections()[0]!.querySelector('[data-node-kind="assistant"]')?.getAttribute('data-streaming')).toBe(
    'false',
  )
  expect(
    sections()[0]!.querySelector('[data-node-kind="cost"] [aria-label="查看本次调用用量明细"]'),
  ).toBeTruthy()
  expect(sections()[0]!.querySelector('[data-node-kind="cost"] dl')?.textContent).toContain('12')
  expect(sections()[0]!.querySelector('.turn-process')).toBeTruthy()
  expect(sections()[1]!.querySelector('.runtime-process-card')?.textContent).toContain('决策模型')
  expect(sections()[1]!.querySelector('.thinking-content')).toBeTruthy()
})

it.each([false, true])(
  'applies one shared cut to real comparison views and refuses incomplete evidence (missing=%s)',
  async (missing) => {
    const capture = JSON.parse(
      readFileSync('packages/core/test/fixtures/comparison-real-cancel.json', 'utf8'),
    ) as {
      pair: ComparisonSnapshot
      reports: {
        lane: ComparisonLane
        events: EventEnvelope[]
        replayProjections: { upto: number; timeline: Omit<UITimeline, 'generation'> }[]
      }[]
    }
    const byId = new Map(capture.reports.map((report) => [report.lane.sessionId, report]))
    const full = (id: string) => {
      const report = byId.get(id)!
      return { ...report.replayProjections.at(-1)!.timeline, generation: 1 }
    }
    for (const report of capture.reports) timelines.set(report.lane.sessionId, full(report.lane.sessionId))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let hold = true
    const call = vi.fn(
      async (method: string, params: { sessionId: string; upto?: number; afterSeq?: number }) => {
        const report = byId.get(params.sessionId)!
        if (method === '_agnes/v1/diagnostics.events') {
          const rows = report.events
            .filter(
              (event) =>
                event.seq > (params.afterSeq ?? 0) &&
                !(missing && report.lane.side === 'right' && event.seq === 10),
            )
            .slice(0, 6)
          const lastSeq = report.events.at(-1)!.seq
          return {
            events: rows,
            lastSeq,
            nextAfterSeq: rows.at(-1)?.seq === lastSeq ? null : (rows.at(-1)?.seq ?? null),
          }
        }
        expect(method).toBe('_agnes/v1/session.projectUI')
        if (report.lane.side === 'right' && params.upto === 20 && hold) await gate
        const projection = report.replayProjections.find((item) => item.upto === params.upto)
        if (!projection) throw new Error(`Unexpected test prefix ${params.upto}`)
        return { ...projection.timeline, generation: 1 }
      },
    )
    const client = {
      call,
      comparison: { get: async () => capture.pair, journal: legacyJournal },
    } as unknown as Client
    sessionStorage.setItem('agnes-web-comparison', JSON.stringify({ id: capture.pair.id }))
    const workspace = createComparisonWorkspace(client, () => ({ runtimes: [descriptor], workspaces: [] }))
    await workspace.open()
    if (missing) {
      await vi.waitFor(() =>
        expect(
          document.querySelector('.comparison-lane[data-side="right"] .comparison-coverage')?.textContent,
        ).toContain('账本分页序号不连续'),
      )
      expect(document.querySelector('.comparison-replay-status')?.textContent).toContain('尚未读全')
      await vi.waitFor(() =>
        expect(document.querySelector('.comparison-lane[data-side="right"]')?.getAttribute('data-cut')).toBe(
          '6',
        ),
      )
      expect(
        document.querySelectorAll('.comparison-lane[data-side="right"] .comparison-transcript article'),
      ).toHaveLength(1)
      release()
      return
    }
    const sections = () =>
      [...document.querySelectorAll<HTMLElement>('.comparison-lane')].sort((a, b) =>
        (a.dataset.side ?? '').localeCompare(b.dataset.side ?? ''),
      )
    const assertCuts = (left: number, right: number) => {
      expect(sections().map((section) => Number(section.dataset.cut))).toEqual([left, right])
      for (const [index, cut] of [left, right].entries()) {
        expect(
          sections()[index]!.querySelector('.comparison-lane-body > details > summary')?.textContent,
        ).toContain(`#0–${cut}`)
        const rows = sections()[index]!.querySelectorAll('.comparison-lane-body > details > ol > li')
        expect(rows.length).toBe(cut)
        if (cut > 0) expect(rows[rows.length - 1]!.querySelector('pre')?.textContent).toBeTruthy()
      }
    }
    await vi.waitFor(() => assertCuts(24, 24))
    expect(document.querySelector('.comparison-replay-status')?.textContent).toContain('尚未读全')
    const more = [...sections()[1]!.querySelectorAll('button')].find(
      (item) => item.textContent === '继续读取账本与更早对话',
    )!
    expect(more.disabled).toBe(false)
    more.click()
    await vi.waitFor(() => assertCuts(24, 35))
    for (const stop of document.querySelectorAll<HTMLButtonElement>('.comparison-lane > header button'))
      if (stop.textContent === '停止此侧') expect(stop.disabled).toBe(true)
    expect(document.querySelector('.comparison-rounds')?.textContent).toContain('左侧 已接收 #4 · 已取消')
    expect(document.querySelector('.comparison-rounds')?.textContent).toContain('右侧 已接收 #4 · 已完成')
    const slider = document.querySelector<HTMLInputElement>('[aria-label="双侧共享回放位置"]')!
    const seek = (value: number) => {
      slider.value = String(value)
      slider.dispatchEvent(new Event('input'))
    }
    seek(6)
    await vi.waitFor(() => assertCuts(6, 6))
    expect(document.querySelectorAll('.comparison-transcript article')).toHaveLength(2)
    expect(document.querySelector('.comparison-graph-column [data-stage="answer"]')?.textContent).toContain(
      '未观测请求',
    )
    expect(document.querySelector<HTMLTextAreaElement>('.comparison-composer textarea')?.disabled).toBe(true)
    sinks.get(capture.pair.lanes[1]!.sessionId)?.stream?.(full(capture.pair.lanes[1]!.sessionId))
    expect(document.querySelectorAll('.comparison-transcript article')).toHaveLength(2)
    seek(20)
    await vi.waitFor(() =>
      expect(
        call.mock.calls.some(([, p]) => p.sessionId === capture.pair.lanes[1]!.sessionId && p.upto === 20),
      ).toBe(true),
    )
    assertCuts(6, 6)
    expect(document.querySelector('.comparison-replay-status')?.textContent).toContain('正在同步两侧')
    seek(24)
    await vi.waitFor(() => assertCuts(24, 24))
    hold = false
    release()
    await Promise.resolve()
    await Promise.resolve()
    assertCuts(24, 24)
    seek(0)
    await vi.waitFor(() => assertCuts(0, 0))
    expect(document.querySelectorAll('.comparison-transcript article')).toHaveLength(0)
    const ranks = new Map(
      capture.reports.map((report) => [
        report.lane.side,
        { events: report.events, complete: true, loading: false },
      ]),
    )
    expect(comparisonReplayCuts(35, ranks)).toEqual({ left: 24, right: 35 })
    expect(comparisonReplayCuts(0, ranks)).toEqual({ left: 0, right: 0 })
    for (const invalid of [-1, 0.5, Number.NaN])
      expect(() => comparisonReplayCuts(invalid, ranks)).toThrow(RangeError)
    expect(document.querySelectorAll('.comparison-lane .jev-graph-replay:not([hidden])')).toHaveLength(0)
    const live = [...document.querySelectorAll<HTMLButtonElement>('.comparison-replay button')].find(
      (item) => item.textContent === '实时',
    )!
    live.click()
    await vi.waitFor(() => assertCuts(24, 35))
    expect(document.querySelector<HTMLTextAreaElement>('.comparison-composer textarea')?.disabled).toBe(false)
    vi.useFakeTimers()
    try {
      const restart = [...document.querySelectorAll<HTMLButtonElement>('.comparison-replay button')].find(
        (item) => item.textContent === '从头回放',
      )!
      restart.click()
      await Promise.resolve()
      await Promise.resolve()
      expect(document.querySelector('.comparison-replay [aria-pressed="true"]')?.textContent).toBe('暂停')
      document.querySelector('dialog')!.dispatchEvent(new Event('close'))
      await vi.advanceTimersByTimeAsync(0)
      const stoppedStatus = document.querySelector('.comparison-replay-status')?.textContent
      await vi.advanceTimersByTimeAsync(1000)
      expect(document.querySelector('.comparison-replay-status')?.textContent).toBe(stoppedStatus)
      expect(document.querySelector('.comparison-replay [aria-pressed="true"]')).toBeNull()
      const timerBaseline = vi.getTimerCount()
      const playbackHost = document.createElement('section')
      const playback = createComparisonReplay(
        playbackHost,
        async () => true,
        (error) => {
          throw error
        },
      )
      playback.updateJournal({ mode: 'per-lane-only', entries: [], throughSeq: 0, loading: false })
      for (const [side, lane] of ranks) playback.update(side, lane)
      const rate = playbackHost.querySelector<HTMLSelectElement>('select')!
      const fromStart = [...playbackHost.querySelectorAll('button')].find(
        (item) => item.textContent === '从头回放',
      )!
      for (const factor of [1, 2, 4, 8]) {
        rate.value = String(factor)
        rate.dispatchEvent(new Event('change'))
        fromStart.click()
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(350 / factor)
        expect(playbackHost.querySelector('[role="status"]')?.textContent).toContain(
          '同步步进 1 · 左 #1 / 右 #1',
        )
      }
      playback.reset()
      expect(vi.getTimerCount()).toBe(timerBaseline)
    } finally {
      release()
      vi.useRealTimers()
    }
  },
)
it('catches a legacy lane tail arriving during a fixed-prefix read without another event', async () => {
  let finish!: (value: { events: EventEnvelope[]; lastSeq: number; nextAfterSeq: null }) => void
  const event = (seq: number) => ({ seq }) as EventEnvelope
  const call = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValueOnce({ events: [event(2)], lastSeq: 2, nextAfterSeq: null })
  const update = vi.fn()
  const ledger = createComparisonLedger({ call } as unknown as Pick<Client, 'call'>, 'legacy', update)
  ledger.head(1)
  ledger.head(2)
  finish({ events: [event(1)], lastSeq: 1, nextAfterSeq: null })
  await vi.waitFor(() =>
    expect(update.mock.lastCall?.[0]).toMatchObject({
      complete: true,
      loading: false,
      events: [{ seq: 1 }, { seq: 2 }],
    }),
  )
  // A stale empty page cannot spin forever while waiting for a newer advertised head.
  call.mockResolvedValue({ events: [], lastSeq: 2, nextAfterSeq: null })
  ledger.head(3)
  await vi.waitFor(() => expect(update.mock.lastCall?.[0]).toMatchObject({ complete: false, loading: false }))
  expect(call).toHaveBeenCalledTimes(3)
  ledger.dispose()
})

it('retries a failed fixed cut only on a later refresh, without duplicating active or complete reads', async () => {
  let finish!: (value: unknown) => void
  const events = vi
    .fn()
    .mockRejectedValueOnce(new Error('INTERNAL_ERROR'))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
  const update = vi.fn()
  const ledger = createComparisonCutLedger(
    { comparison: { events } } as unknown as Client,
    { id: 'pair', side: 'left', sessionId: 'lane' },
    update,
  )
  ledger.cut(2, 1)
  await vi.waitFor(() => expect(update.mock.lastCall?.[1]).toContain('INTERNAL_ERROR'))
  expect(events).toHaveBeenCalledTimes(1)
  ledger.cut(2, 1)
  ledger.cut(2, 1)
  expect(events).toHaveBeenCalledTimes(2)
  expect(update.mock.lastCall?.[0]).toMatchObject({ loading: true, complete: false })
  finish({
    id: 'pair',
    side: 'left',
    atSeq: 2,
    sessionId: 'lane',
    throughSeq: 1,
    afterSeq: 0,
    events: [{ seq: 1 }],
    nextAfterSeq: 1,
    complete: true,
  })
  await vi.waitFor(() =>
    expect(update.mock.lastCall?.[0]).toMatchObject({ loading: false, complete: true, events: [{ seq: 1 }] }),
  )
  ledger.cut(2, 1)
  expect(events).toHaveBeenCalledTimes(2)
  ledger.dispose()
})

it('projects approvals and every recorded question at the committed shared cut with history read-only', async () => {
  const pair = { ...base, phase: 'running' as const }
  const question = (sessionId: string): import('@agnes/protocol').QuestionInteraction => ({
    sessionId,
    interactionId: `question-${sessionId}`,
    writerRunId: 'writer',
    generation: 1,
    toolUseId: 'ask',
    turn: 1,
    callSeq: 1,
    requestedSeq: 3,
    request: {
      questions: [
        { id: 'a', question: '选择环境', options: [{ label: '测试环境' }] },
        { id: 'b', question: '确认说明', detail: '只影响此工作区' },
      ],
    },
    policy: { allowSkip: false },
  })
  const approvalNode = (sessionId: string): UITimeline['nodes'][number] => ({
    kind: 'approval',
    id: 'approval',
    seq: 2,
    state: 'pending',
    summary: `审批 ${sessionId}`,
    risk: 'destructive',
    options: ['allow_once', 'reject_once'],
    ticket: `ticket-${sessionId}`,
  })
  const timeline = (sessionId: string, upto: number): UITimeline => ({
    sessionId,
    upto,
    generation: 1,
    opState: null,
    turns: [],
    nodes: upto >= 2 && upto < 4 ? [approvalNode(sessionId)] : [],
  })
  const records = (sessionId: string): EventEnvelope[] =>
    [
      { type: 'session/start', data: {} },
      {
        type: 'approval/asked',
        data: {
          requestId: 'approval',
          summary: `审批 ${sessionId}`,
          risk: 'destructive',
          options: ['allowed-once', 'rejected'],
          pending: { ticket: `ticket-${sessionId}` },
        },
      },
      { type: 'question/requested', data: question(sessionId) },
      { type: 'approval/decided', data: { requestId: 'approval', verdict: 'rejected' } },
      {
        type: 'question/settled',
        data: {
          interactionId: `question-${sessionId}`,
          requestedSeq: 3,
          callSeq: 1,
          toolUseId: 'ask',
          status: 'cancelled',
        },
      },
    ].map(
      (entry, index) =>
        ({
          ...entry,
          seq: index + 1,
          id: `${sessionId}-${index}`,
          ts: '2026-10-03T00:00:00Z',
          v: 1,
          lane: 'main',
          origin: 'system',
          trust: 'trusted',
          actor: { id: 'test', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        }) as EventEnvelope,
    )
  const cuts = (atSeq: number) => ({ left: Math.ceil(atSeq / 2), right: Math.floor(atSeq / 2) })
  const entries: ComparisonJournalEntry[] = Array.from({ length: 10 }, (_, index) => {
    const seq = index + 1
    const lane = pair.lanes[index % 2]!
    return {
      seq,
      cuts: cuts(seq),
      fact: {
        kind: 'lane',
        side: lane.side,
        sessionId: lane.sessionId,
        localSeq: Math.ceil(seq / 2),
        digest: 'a'.repeat(64),
      },
    }
  })
  let head = 2
  let liveHead = 3
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let blocked = true
  const decide = vi.fn(async () => {})
  const answer = vi.fn()
  const cancel = vi.fn()
  const client = {
    approval: { decide },
    questions: {
      pending: vi.fn(async (sessionId: string) => ({
        sessionId,
        interactions: liveHead < 5 ? [question(sessionId)] : [],
      })),
      answer,
      cancel,
    },
    comparison: {
      get: async () => pair,
      journal: async ({ id, afterSeq = 0 }: ComparisonJournalParams) => ({
        id,
        afterSeq,
        throughSeq: head,
        entries: entries.filter((entry) => entry.seq > afterSeq && entry.seq <= head),
        nextAfterSeq: head,
        complete: true,
      }),
      events: async ({
        id,
        side,
        atSeq,
        afterSeq,
      }: {
        id: string
        side: 'left' | 'right'
        atSeq: number
        afterSeq: number
      }) => {
        const sessionId = pair.lanes.find((lane) => lane.side === side)!.sessionId
        const throughSeq = cuts(atSeq)[side]
        return {
          id,
          side,
          atSeq,
          afterSeq,
          sessionId,
          throughSeq,
          events: records(sessionId).filter((event) => event.seq > afterSeq && event.seq <= throughSeq),
          nextAfterSeq: throughSeq,
          complete: true,
        }
      },
      projectUI: async ({ id, side, atSeq }: { id: string; side: 'left' | 'right'; atSeq: number }) => {
        const sessionId = pair.lanes.find((lane) => lane.side === side)!.sessionId
        return {
          id,
          side,
          atSeq,
          sessionId,
          throughSeq: cuts(atSeq)[side],
          timeline: timeline(sessionId, cuts(atSeq)[side]),
        }
      },
      metrics: async ({ id, atSeq }: { id: string; atSeq: number }) => {
        if (blocked && atSeq === 6) await gate
        return { id, atSeq, cuts: cuts(atSeq), lanes: [] }
      },
    },
  } as unknown as Client
  for (const lane of pair.lanes) timelines.set(lane.sessionId, timeline(lane.sessionId, liveHead))
  sessionStorage.setItem('agnes-web-comparison', JSON.stringify({ id: pair.id }))
  const workspace = createComparisonWorkspace(client, () => ({ runtimes: [descriptor], workspaces: [] }))
  await workspace.open()
  const sections = () =>
    [...document.querySelectorAll<HTMLElement>('.comparison-lane')].sort((a, b) =>
      (a.dataset.side ?? '').localeCompare(b.dataset.side ?? ''),
    )
  const at = (seq: number) =>
    expect(sections().map((section) => section.dataset.cut)).toEqual([
      String(cuts(seq).left),
      String(cuts(seq).right),
    ])
  await vi.waitFor(() => at(2))
  const permissionResult = permissions.get(pair.lanes[0]!.sessionId)!(
    {
      sessionId: pair.lanes[0]!.sessionId,
      toolCall: { toolCallId: 'approval', title: '实时审批' },
      options: [{ optionId: 'allow_once', kind: 'allow_once', name: '仅允许这次' }],
    },
    { signal: new AbortController().signal },
  )
  // Synchronous permission callbacks precede approval/asked in the ledger.
  await vi.waitFor(() =>
    expect(document.querySelector('[data-approval-key]')?.textContent).toContain('实时审批'),
  )
  expect(document.querySelector('[data-agnes-region="questions"]')?.textContent).not.toContain('选择环境')
  head = 6
  for (const lane of pair.lanes) sinks.get(lane.sessionId)!.timeline(timeline(lane.sessionId, liveHead))
  await vi.waitFor(() =>
    expect(document.querySelector('.comparison-results')?.getAttribute('data-pending-seq')).toBe('6'),
  )
  at(2)
  expect(document.querySelector('[data-approval-key]')?.textContent).toContain('实时审批')
  expect(document.querySelector('[data-agnes-region="questions"]')?.textContent).not.toContain('选择环境')
  blocked = false
  release()
  await vi.waitFor(() => at(6))
  await vi.waitFor(() =>
    expect(
      required(
        document.querySelector<HTMLButtonElement>(
          '.comparison-lane[data-side="left"] [data-approval-action="allow_once"]',
        ),
      ).disabled,
    ).toBe(false),
  )
  const slider = required(document.querySelector<HTMLInputElement>('[aria-label="双侧共享回放位置"]'))
  const seek = (seq: number) => {
    slider.value = String(seq)
    slider.dispatchEvent(new Event('input'))
  }
  seek(6)
  await vi.waitFor(() => {
    for (const section of sections()) {
      expect(
        required(section.querySelector<HTMLButtonElement>('[data-approval-action="allow_once"]')).disabled,
      ).toBe(true)
      const questions = required(section.querySelector<HTMLElement>('[data-agnes-region="questions"]'))
      expect(questions.hidden).toBe(false)
      expect(questions.textContent).toContain('选择环境')
      expect(questions.textContent).toContain('确认说明')
      expect(questions.textContent).toContain('只影响此工作区')
      expect(questions.querySelector('textarea')).toBeNull()
    }
  })
  required(
    document.querySelector<HTMLButtonElement>(
      '.comparison-lane[data-side="left"] [data-approval-action="allow_once"]',
    ),
  ).click()
  expect(decide).not.toHaveBeenCalled()
  expect(answer).not.toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
  seek(4)
  await vi.waitFor(() => at(4))
  expect(required(document.querySelector<HTMLElement>('[data-agnes-region="questions"]')).hidden).toBe(true)
  required(
    [...document.querySelectorAll<HTMLButtonElement>('.comparison-replay button')].find(
      (button) => button.textContent === '实时',
    ),
  ).click()
  await vi.waitFor(() => at(6))
  await vi.waitFor(() =>
    expect(
      required(
        document.querySelector<HTMLButtonElement>(
          '.comparison-lane[data-side="left"] [data-approval-action="allow_once"]',
        ),
      ).disabled,
    ).toBe(false),
  )
  required(
    document.querySelector<HTMLButtonElement>(
      '.comparison-lane[data-side="left"] [data-approval-action="allow_once"]',
    ),
  ).click()
  await expect(permissionResult).resolves.toEqual({ optionId: 'allow_once' })
  required(sections()[1]!.querySelector<HTMLButtonElement>('[data-approval-action="allow_once"]')).click()
  await vi.waitFor(() =>
    expect(decide).toHaveBeenCalledWith(`ticket-${pair.lanes[1]!.sessionId}`, 'allowed-once', {
      kind: 'local',
    }),
  )
  head = 10
  liveHead = 5
  for (const lane of pair.lanes) sinks.get(lane.sessionId)!.timeline(timeline(lane.sessionId, liveHead))
  await vi.waitFor(() => at(10))
  await vi.waitFor(() => expect(document.querySelector('[data-approval-key]')).toBeNull())
  expect(required(document.querySelector<HTMLElement>('[data-agnes-region="questions"]')).hidden).toBe(true)
})

const owner = { id: 'native', version: '1' }
const descriptor: RuntimeDescriptor = {
  ...owner,
  label: 'Native',
  available: true,
  apiVersion: 1,
  capabilities: { prompt: true, cancel: true, resume: true, compact: true, fork: true },
}
const base: ComparisonSnapshot = {
  id: 'comparison-1',
  revision: 1,
  phase: 'ready',
  baselineId: 'baseline',
  baselineDigest: 'a'.repeat(64),
  policyHash: 'b'.repeat(64),
  rounds: [],
  metrics: { state: 'unknown' },
  lanes: [
    {
      side: 'left',
      sessionId: 'left-session',
      runtime: owner,
      workspaceLabel: 'left workspace',
      phase: 'idle',
      lastSeq: 1,
    },
    {
      side: 'right',
      sessionId: 'right-session',
      runtime: { id: 'jevloop', version: '1' },
      workspaceLabel: 'right workspace',
      phase: 'idle',
      lastSeq: 1,
    },
  ],
}

it.each(['view', 'workspace'] as const)(
  'handles live %s approvals without durable records and rejects retired requests',
  async (permissionMode) => {
    const pair = { ...structuredClone(base), permissionMode }
    let connectionListener = () => {}
    const client = {
      connectionState: 'connected',
      on: (event: string, listener: () => void) => {
        if (event !== 'connectionStateChanged') return () => {}
        connectionListener = listener
        return () => {
          connectionListener = () => {}
        }
      },
      call: emptyHistoryProjection,
      comparison: {
        get: async () => pair,
        journal: legacyJournal,
        list: async () => ({ items: [], nextCursor: null }),
      },
    }
    sessionStorage.setItem('agnes-web-comparison', JSON.stringify({ id: pair.id }))
    const workspace = createComparisonWorkspace(client as unknown as Client, () => ({
      runtimes: [descriptor],
      workspaces: [],
    }))
    await workspace.open()
    const permission = required(permissions.get('left-session'))
    const request = {
      sessionId: 'left-session',
      toolCall: {
        toolCallId: 'sync-only',
        title: '审批尚未写入账本',
        rawInput: { command: 'pwd', cwd: '/isolated-left' },
      },
      options: [
        { optionId: 'allow_once', kind: 'allow_once' as const, name: 'allow_once' },
        { optionId: 'allow_always', kind: 'allow_always' as const, name: 'allow_always' },
        { optionId: 'reject_once', kind: 'reject_once' as const, name: 'reject_once' },
        { optionId: 'reject_always', kind: 'reject_always' as const, name: 'reject_always' },
      ],
    }
    const first = permission(request, { signal: new AbortController().signal })
    if (permissionMode === 'view') {
      await expect(first).resolves.toEqual({ verdict: 'rejected' })
      expect(document.querySelector('[data-approval-key]')).toBeNull()
      return
    }
    const action = () =>
      required(document.querySelector<HTMLButtonElement>('[data-approval-action="allow_once"]'))
    await vi.waitFor(() => expect(action().disabled).toBe(false))
    expect(document.querySelector('[data-approval-key] pre')?.textContent).toBe(
      JSON.stringify(request.toolCall.rawInput, null, 2),
    )
    expect(
      [...document.querySelectorAll('[data-approval-action]')].map((button) => button.textContent),
    ).toEqual(['仅允许这次', '本会话允许', '拒绝', '始终拒绝'])
    expect(document.querySelector('.comparison-permission button')?.hasAttribute('disabled')).toBe(true)
    action().click()
    await expect(first).resolves.toEqual({ optionId: 'allow_once' })
    const cancellation = new AbortController()
    const second = permission(request, { signal: cancellation.signal })
    await vi.waitFor(() => expect(action().disabled).toBe(false))
    const disconnectedAction = action()
    client.connectionState = 'disconnected'
    connectionListener()
    await expect(second).resolves.toEqual({ verdict: 'rejected' })
    client.connectionState = 'connected'
    connectionListener()
    disconnectedAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[data-approval-key]')).toBeNull())
    expect(cancellation.signal.aborted).toBe(false)
    // Two shape-identical callbacks are distinct requests, even in one React batch.
    const replaced = permission(request, { signal: new AbortController().signal })
    await vi.waitFor(() => expect(action().disabled).toBe(false))
    const replacedAction = action()
    const replacement = permission(request, { signal: new AbortController().signal })
    await expect(replaced).resolves.toEqual({ verdict: 'rejected' })
    await vi.waitFor(() => expect(action()).not.toBe(replacedAction))
    action().click()
    await expect(replacement).resolves.toEqual({ optionId: 'allow_once' })
    await expect(
      permission({ ...request, deadlineMs: Date.now() - 1 }, { signal: new AbortController().signal }),
    ).resolves.toEqual({ verdict: 'rejected' })
    await expect(
      permission({ ...request, sessionId: 'right-session' }, { signal: new AbortController().signal }),
    ).resolves.toEqual({ verdict: 'rejected' })
    const sink = required(sinks.get('left-session'))
    sink.timeline({ sessionId: 'left-session', generation: 1, upto: 1, opState: null, nodes: [], turns: [] })
    const oldGeneration = permission(request, { signal: new AbortController().signal })
    sink.timeline({ sessionId: 'left-session', generation: 2, upto: 1, opState: null, nodes: [], turns: [] })
    await expect(oldGeneration).resolves.toEqual({ verdict: 'rejected' })
    const closed = permission(request, { signal: new AbortController().signal })
    workspace.close()
    await expect(closed).resolves.toEqual({ verdict: 'rejected' })
  },
)

function savedSummary(pair: ComparisonSnapshot): ComparisonListItem {
  return {
    id: pair.id,
    revision: pair.revision,
    phase: pair.phase,
    createdAt: null,
    updatedAt: null,
    roundCount: pair.rounds.length,
    inspectable: pair.lanes.length === 2,
    lanes: pair.lanes.map(({ side, runtime }) => ({ side, runtime })),
  }
}

it.each(['lost-reply', 'closed-view'] as const)(
  'starts a new-session dual draft directly and retains its creation identity after %s',
  async (failure) => {
    sessionStorage.setItem('agnes-web-comparison', JSON.stringify({ id: 'older-comparison' }))
    const create = vi.fn(async (_request: ComparisonCreateParams) => structuredClone(base))
    create.mockImplementationOnce(async () => {
      if (failure === 'lost-reply') throw new Error('create reply lost')
      required(document.querySelector('dialog')).close()
      return structuredClone(base)
    })
    const get = vi.fn(async () => structuredClone(base))
    if (failure === 'lost-reply')
      get.mockRejectedValueOnce(
        new JsonRpcError({
          code: -32011,
          message: 'not yet created',
          data: { code: 'COMPARISON_NOT_FOUND' },
        }),
      )
    const submit = vi.fn(async (request: { inputId: string }) => ({
      inputId: request.inputId,
      acceptances: base.lanes.map((lane) => ({
        side: lane.side,
        sessionId: lane.sessionId,
        status: 'accepted',
        seq: 2,
      })),
      settledSides: [],
    }))
    const client = {
      call: emptyHistoryProjection,
      comparison: {
        create,
        get,
        submit,
        journal: legacyJournal,
        list: async () => ({ items: [], nextCursor: null }),
      },
      session: { new: vi.fn(), prompt: vi.fn() },
    } as unknown as Client
    const options = () => ({
      runtimes: [descriptor, { ...descriptor, id: 'jevloop', label: 'JevLoop' }],
      workspaces: [{ path: '/project' }] as never,
      cwd: '/project',
      model: { route: 'local', model: 'deepseek-v4-flash' },
      permissionMode: 'full' as const,
    })
    const workspace = createComparisonWorkspace(client, options)
    await expect(workspace.startDraft(base.id, 'same initial task')).rejects.toThrow(
      failure === 'lost-reply' ? 'create reply lost' : '对比视图已关闭',
    )
    expect(submit).not.toHaveBeenCalled()
    const entry = JSON.parse(sessionStorage.getItem('agnes-web-comparison') ?? 'null')
    expect(entry.creation.firstInput.text).toBe('same initial task')
    expect(entry.creation.firstInput.permissionMode).toBe('full')
    if (failure === 'lost-reply') {
      create.mockRejectedValueOnce(new Error('another creation reply lost'))
      await expect(workspace.startDraft('another-explicit-draft', 'a different task')).rejects.toThrow(
        'another creation reply lost',
      )
      expect(JSON.parse(sessionStorage.getItem(`agnes-web-comparison:${base.id}`) ?? 'null')).toEqual(entry)
    }
    const creationsBeforeRestore = create.mock.calls.length
    document.querySelector('dialog')?.remove()
    const reopened = createComparisonWorkspace(client, () => ({
      ...options(),
      cwd: '/changed-workspace',
      permissionMode: 'view',
    }))
    await reopened.open(base.id)
    expect(create).toHaveBeenCalledTimes(creationsBeforeRestore)
    expect(submit).not.toHaveBeenCalled()
    await reopened.submitDraft(base.id, 'same initial task')
    expect(create).toHaveBeenCalledTimes(creationsBeforeRestore + (failure === 'lost-reply' ? 1 : 0))
    if (failure === 'lost-reply') expect(create.mock.calls.at(-1)).toEqual(create.mock.calls[0])
    expect(create).toHaveBeenLastCalledWith({
      requestId: base.id,
      cwd: '/project',
      isolation: 'snapshot',
      left: { runtime: 'native' },
      right: { runtime: 'jevloop' },
      model: { route: 'local', model: 'deepseek-v4-flash' },
      permissionMode: 'full',
    })
    expect(get).not.toHaveBeenCalledWith('older-comparison')
    expect(submit).toHaveBeenCalledWith({
      id: base.id,
      inputId: entry.creation.firstInput.inputId,
      content: [{ type: 'text', text: 'same initial task' }],
      permissionMode: 'full',
    })
    expect(client.session.new).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLDialogElement>('dialog')?.open).toBe(true)
    expect(document.querySelectorAll('.comparison-lane')).toHaveLength(2)
    const panes = required(document.querySelector('.comparison-panes'))
    expect([...panes.children].map((node) => node.className)).toEqual([
      'comparison-graph-column',
      'comparison-lane',
      'comparison-lane',
    ])
    expect(
      [...panes.querySelectorAll<HTMLElement>('.comparison-lane')].map((node) => node.dataset.runtime),
    ).toEqual(['jevloop', 'native'])
    expect(panes.querySelector('.comparison-lane .jev-decision-graph')).toBeNull()
    const graph = required(panes.querySelector('.comparison-graph-column .jev-decision-graph'))
    const selected = [...document.querySelectorAll<HTMLButtonElement>('.comparison-views button')]
    expect(selected[0]?.getAttribute('aria-pressed')).toBe('true')
    const owners = [...controllers.values()]
    const submitted = submit.mock.calls.length
    required(selected[1]).click()
    expect(
      [...panes.querySelectorAll<HTMLElement>('.comparison-trace-panel')].every((node) => !node.hidden),
    ).toBe(true)
    expect(panes.querySelector('.comparison-graph-column .jev-decision-graph')).toBe(graph)
    required(selected[0]).click()
    expect(
      [...panes.querySelectorAll<HTMLElement>('.comparison-trace-panel')].every((node) => node.hidden),
    ).toBe(true)
    expect([...controllers.values()]).toEqual(owners)
    expect(submit.mock.calls).toHaveLength(submitted)
    expect(document.querySelector<HTMLFormElement>('.comparison-setup')?.hidden).toBe(true)
  },
)

it.each(['native', 'jevloop'])(
  'keeps same-runtime %s history inspectable in the main workspace',
  async (runtime) => {
    const main = document.createElement('main')
    main.id = 'main-content'
    document.body.append(main)
    const pair = structuredClone(base)
    for (const lane of pair.lanes) lane.runtime.id = runtime
    const client = {
      call: emptyHistoryProjection,
      comparison: { get: async () => pair, journal: legacyJournal },
    } as unknown as Client
    const workspace = createComparisonWorkspace(client, () => ({ runtimes: [descriptor], workspaces: [] }), {
      host: main,
    })
    await workspace.open(pair.id)
    expect(main.querySelector('.comparison-workspace[open]')).not.toBeNull()
    const graph = required(main.querySelector<HTMLElement>('.comparison-graph-column'))
    expect(graph.hidden).toBe(runtime === 'native')
    if (runtime === 'jevloop') {
      const choice = required(graph.querySelector('select'))
      expect(choice.hidden).toBe(false)
      expect(choice.options).toHaveLength(2)
      const visible = () =>
        [...graph.querySelectorAll<HTMLElement>(':scope > section')]
          .filter((node) => !node.hidden)
          .map((node) => node.dataset.side)
      expect(visible()).toEqual(['left'])
      choice.value = 'right'
      choice.dispatchEvent(new Event('change'))
      expect(visible()).toEqual(['right'])
    }
    const mobile = [...main.querySelectorAll<HTMLButtonElement>('.comparison-mobile-lanes button')]
    required(mobile.find((node) => node.dataset.side === 'left')).click()
    expect(
      main.querySelector('.comparison-lane[data-side="left"]')?.getAttribute('data-mobile-selected'),
    ).toBe('true')
    expect(
      main.querySelector('.comparison-lane[data-side="right"]')?.getAttribute('data-mobile-selected'),
    ).toBe('false')
    workspace.close()
  },
)

it('does not recreate or submit when a pending creation restore is closed before its query returns', async () => {
  const creation = {
    params: {
      requestId: base.id,
      cwd: '/project',
      left: { runtime: 'native' },
      right: { runtime: 'jevloop' },
      isolation: 'snapshot',
    },
    firstInput: { inputId: 'original-input', text: 'original task' },
  }
  sessionStorage.setItem('agnes-web-comparison', JSON.stringify({ id: base.id, creation }))
  let finish!: (value: ComparisonSnapshot) => void
  const get = vi.fn(
    () =>
      new Promise<ComparisonSnapshot>((resolve) => {
        finish = resolve
      }),
  )
  const create = vi.fn()
  const submit = vi.fn()
  const client = {
    comparison: { get, create, submit, list: async () => ({ items: [], nextCursor: null }) },
  } as unknown as Client
  const workspace = createComparisonWorkspace(client, () => ({ runtimes: [descriptor], workspaces: [] }))
  const operation = workspace.submitDraft(base.id, 'original task')
  const result = expect(operation).rejects.toThrow('对比视图已关闭或切换')
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
  required(document.querySelector('dialog')).close()
  finish(structuredClone(base))
  await result
  expect(create).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
  expect(document.querySelector<HTMLDialogElement>('dialog')?.open).toBe(false)
  expect(JSON.parse(sessionStorage.getItem('agnes-web-comparison') ?? '{}').creation).toEqual(creation)
})

const emptyHistoryProjection = async (method: string, params: { sessionId: string; upto?: number }) =>
  method === '_agnes/v1/session.projectUI'
    ? {
        sessionId: params.sessionId,
        generation: 1,
        upto: params.upto ?? 0,
        opState: null,
        nodes: [],
        turns: [],
      }
    : { events: [], lastSeq: 0, nextAfterSeq: null }

it.each(['acknowledged', 'unknown', 'fenced'] as const)(
  'stops both lanes in one request, preserving pending input when cancellation is %s',
  async (outcome) => {
    const { pair } = JSON.parse(
      readFileSync('packages/core/test/fixtures/comparison-real-cancel.json', 'utf8'),
    ) as { pair: ComparisonSnapshot }
    // Derive a pre-settlement snapshot from the real cancel fixture; an ack alone is not terminal.
    const active: ComparisonSnapshot = {
      ...pair,
      phase: 'running',
      rounds: pair.rounds.map((round) => ({ ...round, settledSides: [], terminalCauses: [] })),
    }
    const pending = { inputId: 'uncertain-next-input', text: 'keep this input unchanged' }
    sessionStorage.setItem('agnes-web-comparison', JSON.stringify({ id: pair.id, pending }))
    let finish!: (value: ComparisonSnapshot) => void
    let reject!: (reason: Error) => void
    const cancel = vi.fn(
      () =>
        new Promise<ComparisonSnapshot>((resolve, fail) => {
          finish = resolve
          reject = fail
        }),
    )
    const reconcile = vi.fn(async () =>
      outcome === 'fenced'
        ? {
            ...pair,
            inputCancellations: [
              {
                inputId: pending.inputId,
                states: [
                  { side: 'left' as const, status: 'acknowledged' as const },
                  { side: 'right' as const, status: 'acknowledged' as const },
                ],
              },
            ],
          }
        : pair,
    )
    const client = {
      call: emptyHistoryProjection,
      comparison: { get: async () => active, cancel, reconcile, journal: legacyJournal },
    } as unknown as Client
    const workspace = createComparisonWorkspace(client, () => ({ runtimes: [descriptor], workspaces: [] }))
    await workspace.open()
    const findButton = (label: string) =>
      required([...document.querySelectorAll('button')].find((item) => item.textContent === label))
    const stop = findButton('停止两侧')
    const input = required(document.querySelector<HTMLTextAreaElement>('.comparison-composer textarea'))
    const requests = active.lanes.map((lane) => ({
      sessionId: lane.sessionId,
      toolCall: { toolCallId: `cancel-${lane.side}`, title: '取消前的审批' },
      options: [{ optionId: 'allow_once', kind: 'allow_once' as const, name: 'allow_once' }],
    }))
    const approvals = requests.map((request) =>
      required(permissions.get(request.sessionId))(request, { signal: new AbortController().signal }),
    )
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-approval-action="allow_once"]')).toHaveLength(2),
    )
    const oldActions = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-approval-action="allow_once"]'),
    ]
    expect(stop.disabled).toBe(false)
    stop.click()
    stop.click()
    expect(cancel.mock.calls).toEqual([[{ id: pair.id, inputId: pending.inputId }]])
    expect(stop.disabled).toBe(true)
    expect(findButton('新建对比').disabled).toBe(true)
    expect(findButton('停止此侧').disabled).toBe(true)
    if (outcome === 'fenced')
      finish({
        ...active,
        inputCancellations: [{ inputId: pending.inputId, states: [{ side: 'left', status: 'unknown' }] }],
      })
    else if (outcome === 'acknowledged') finish(active)
    else reject(new Error('lost cancel response'))
    await vi.waitFor(() => expect(stop.disabled).toBe(false))
    await expect(Promise.all(approvals)).resolves.toEqual([{ verdict: 'rejected' }, { verdict: 'rejected' }])
    for (const action of oldActions) action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[data-approval-key]')).toBeNull())
    for (const request of requests)
      await expect(
        required(permissions.get(request.sessionId))(request, { signal: new AbortController().signal }),
      ).resolves.toEqual({ verdict: 'rejected' })
    expect(input.value).toBe(pending.text)
    expect(input.disabled).toBe(true)
    expect(JSON.parse(sessionStorage.getItem('agnes-web-comparison') ?? '{}').pending).toEqual(pending)
    expect(document.querySelector('.comparison-rounds')?.textContent).toContain('执行中')
    expect(document.querySelector('dialog > [role=status]')?.textContent).toContain(
      outcome === 'unknown' ? '停止请求结果待确认' : '结束状态以持久记录为准',
    )
    if (outcome === 'fenced') {
      expect(findButton('重试原请求').disabled).toBe(true)
      expect(document.querySelector('.comparison-input-cancellation')?.textContent).toContain(
        '左侧取消结果待确认',
      )
      expect(document.querySelector('.comparison-input-cancellation')?.textContent).toContain(
        '右侧尚未请求取消',
      )
    }
    findButton('核对持久状态').click()
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith(pair.id))
    await vi.waitFor(() =>
      expect(document.querySelector('.comparison-rounds')?.textContent).toContain('已取消'),
    )
    expect(stop.disabled).toBe(true)
    expect(document.querySelector('.comparison-rounds')?.textContent).toContain('已完成')
    if (outcome === 'fenced') {
      expect(JSON.parse(sessionStorage.getItem('agnes-web-comparison') ?? '{}').pending).toBeUndefined()
      expect(input.value).toBe(pending.text)
    }
  },
)

it.each(['acknowledged', 'unknown'] as const)(
  'keeps cancelled lane approvals retired after an %s reply while its peer remains live',
  async (outcome) => {
    let pair: ComparisonSnapshot = {
      ...structuredClone(base),
      phase: 'running',
      rounds: [
        {
          inputId: 'cancel-round',
          acceptances: base.lanes.map((lane) => ({
            side: lane.side,
            sessionId: lane.sessionId,
            status: 'accepted',
            seq: 1,
          })),
          settledSides: [],
          terminalCauses: [],
        },
      ],
    }
    const timeline = (sessionId: string): UITimeline => ({
      sessionId,
      generation: 1,
      upto: 1,
      opState: null,
      turns: [],
      nodes: [
        {
          kind: 'approval',
          id: 'durable',
          seq: 1,
          state: 'pending',
          summary: '仍未收到取消账本',
          risk: 'destructive',
          options: ['allow_once', 'reject_once'],
          ticket: `ticket-${sessionId}`,
        },
      ],
    })
    for (const lane of pair.lanes) timelines.set(lane.sessionId, timeline(lane.sessionId))
    const decide = vi.fn(async () => {})
    let finishCancel!: () => void
    const cancel = vi.fn(
      () =>
        new Promise<ComparisonSnapshot>((resolve, reject) => {
          finishCancel = () =>
            outcome === 'unknown' ? reject(new Error('cancel reply lost')) : resolve(pair)
        }),
    )
    const client = {
      approval: { decide },
      comparison: { get: async () => pair, cancel, journal: legacyJournal },
      call: async (method: string, params: { sessionId: string; afterSeq?: number }) =>
        method === '_agnes/v1/session.projectUI'
          ? timeline(params.sessionId)
          : {
              events: params.afterSeq
                ? []
                : [
                    {
                      seq: 1,
                      id: `approval-${params.sessionId}`,
                      ts: '2026-10-04T00:00:00Z',
                      type: 'approval/asked',
                      v: 1,
                      lane: 'main',
                      origin: 'system',
                      trust: 'trusted',
                      actor: { id: 'test', org: 'local', role: 'owner', deptPath: [], attrs: {} },
                      data: {
                        requestId: 'durable',
                        summary: 'pending',
                        risk: 'destructive',
                        options: ['allowed-once', 'rejected'],
                        pending: { ticket: `ticket-${params.sessionId}` },
                      },
                    },
                  ],
              lastSeq: 1,
              nextAfterSeq: null,
            },
    } as unknown as Client
    sessionStorage.setItem('agnes-web-comparison', JSON.stringify({ id: pair.id }))
    const workspace = createComparisonWorkspace(client, () => ({ runtimes: [descriptor], workspaces: [] }))
    await workspace.open()
    const action = (side: string) =>
      required(
        document.querySelector<HTMLButtonElement>(
          `.comparison-lane[data-side="${side}"] [data-approval-action="allow_once"]`,
        ),
      )
    await vi.waitFor(() => expect(action('left').disabled).toBe(false))
    const durableAction = action('left')
    const request = (sessionId: string) => ({
      sessionId,
      toolCall: { toolCallId: 'live', title: 'live pending' },
      options: [{ optionId: 'allow_once', kind: 'allow_once' as const, name: 'allow_once' }],
    })
    const left = required(permissions.get('left-session'))(request('left-session'), {
      signal: new AbortController().signal,
    })
    const right = required(permissions.get('right-session'))(request('right-session'), {
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => expect(document.querySelectorAll('[data-approval-key="live"]')).toHaveLength(2))
    const liveAction = action('left')
    const stop = required(
      [...document.querySelectorAll<HTMLButtonElement>('.comparison-lane[data-side="left"] button')].find(
        (node) => node.textContent === '停止此侧',
      ),
    )
    stop.click()
    await expect(left).resolves.toEqual({ verdict: 'rejected' })
    await vi.waitFor(() => expect(action('right').disabled).toBe(false))
    action('right').click()
    await expect(right).resolves.toEqual({ optionId: 'allow_once' })
    finishCancel()
    await vi.waitFor(() => expect(stop.disabled).toBe(false))
    expect(cancel).toHaveBeenCalledWith({ id: pair.id, side: 'left' })
    await vi.waitFor(() => expect(action('left').disabled).toBe(true))
    durableAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    liveAction.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    action('left').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(decide).not.toHaveBeenCalled()
    await expect(
      required(permissions.get('left-session'))(request('left-session'), {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ verdict: 'rejected' })
    pair = { ...pair, revision: 2, rounds: [{ ...required(pair.rounds[0]), inputId: 'new-round' }] }
    required(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent === '刷新状态',
      ),
    ).click()
    await vi.waitFor(() =>
      expect(document.querySelector('.comparison-rounds')?.textContent).toContain('new-roun'),
    )
    expect(action('left').disabled).toBe(true) // The old durable ticket cannot revive in the new round.
    const fresh = required(permissions.get('left-session'))(request('left-session'), {
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => expect(action('left').disabled).toBe(false))
    action('left').click()
    await expect(fresh).resolves.toEqual({ optionId: 'allow_once' })
    expect(decide).not.toHaveBeenCalled()
    const terminalSignal = new AbortController()
    const terminal = required(permissions.get('left-session'))(request('left-session'), {
      signal: terminalSignal.signal,
    })
    pair = {
      ...pair,
      revision: 3,
      phase: 'completed',
      rounds: [{ ...required(pair.rounds[0]), settledSides: ['left', 'right'] }],
    }
    required(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent === '刷新状态',
      ),
    ).click()
    await expect(terminal).resolves.toEqual({ verdict: 'rejected' })
    expect(terminalSignal.signal.aborted).toBe(false)
    await vi.waitFor(() =>
      expect(
        required(document.querySelector<HTMLButtonElement>('.comparison-permission button')).disabled,
      ).toBe(false),
    )
  },
)

it.each(['all', 'left'] as const)(
  'retires a late %s cancellation after close and reopening a workspace',
  async (side) => {
    const { pair } = JSON.parse(
      readFileSync('packages/core/test/fixtures/comparison-real-cancel.json', 'utf8'),
    ) as { pair: ComparisonSnapshot }
    const active: ComparisonSnapshot = {
      ...pair,
      phase: 'running',
      rounds: pair.rounds.map((round) => ({ ...round, settledSides: [], terminalCauses: [] })),
    }
    // Same-id reopen proves the selection generation matters independently of the id check.
    const other = { ...base, id: side === 'all' ? pair.id : 'other-pair', baselineId: 'other-baseline' }
    let reopened = false
    let finish!: (value: ComparisonSnapshot) => void
    const cancel = vi.fn(
      () =>
        new Promise<ComparisonSnapshot>((resolve) => {
          finish = resolve
        }),
    )
    const client = {
      call: emptyHistoryProjection,
      comparison: {
        get: async () => (reopened ? other : active),
        cancel,
        journal: legacyJournal,
      },
    } as unknown as Client
    sessionStorage.setItem('agnes-web-comparison', JSON.stringify({ id: pair.id }))
    const workspace = createComparisonWorkspace(client, () => ({ runtimes: [descriptor], workspaces: [] }))
    await workspace.open()
    required(
      [...document.querySelectorAll('button')].find(
        (item) =>
          item.textContent === (side === 'all' ? '停止两侧' : '停止此侧') &&
          (side === 'all' || item.closest<HTMLElement>('.comparison-lane')?.dataset.side === side),
      ),
    ).click()
    expect(cancel).toHaveBeenCalledWith({ id: pair.id, ...(side === 'left' ? { side } : {}) })
    expect(
      required([...document.querySelectorAll('button')].find((item) => item.textContent === '新建对比'))
        .disabled,
    ).toBe(true)
    required(document.querySelector('dialog')).close()
    await vi.waitFor(() => expect([...controllers.values()].every((pane) => pane.disposed)).toBe(true))
    reopened = true
    sessionStorage.setItem('agnes-web-comparison', JSON.stringify({ id: other.id }))
    await workspace.open()
    const input = required(document.querySelector<HTMLTextAreaElement>('.comparison-composer textarea'))
    input.value = 'new pair draft'
    input.dispatchEvent(new Event('input'))
    finish(pair)
    await Promise.resolve()
    await Promise.resolve()
    expect(document.querySelector('.comparison-facts')?.textContent).toContain('other-baseline')
    expect(JSON.parse(sessionStorage.getItem('agnes-web-comparison') ?? '{}').id).toBe(other.id)
    expect(input.value).toBe('new pair draft')
    expect(document.querySelector('dialog > [role=status]')?.textContent).not.toContain('已请求停止')
  },
)

it('keeps uncertain submissions correlated, queries instead of resending, and cancels only the requested lane', async () => {
  timelines.set('right-session', {
    sessionId: 'right-session',
    generation: 1,
    upto: 0,
    opState: null,
    turns: [],
    nodes: [
      {
        kind: 'runtime',
        id: 'runtime:1',
        seq: 1,
        lastSeq: 3,
        runtime: { id: 'jevloop', version: '1' },
        category: 'model',
        status: 'completed',
        title: '决策模型',
        summary: '采用路径：INSPECT → read',
        requestId: 'request-1',
        purpose: 'decision',
        model: 'synthetic',
        detail: '完整决策证据',
      },
    ],
  })
  const style = document.createElement('style')
  style.textContent =
    readFileSync('packages/web/public/style.css', 'utf8') +
    readFileSync('packages/jev-web/styles/comparison.css', 'utf8')
  document.body.append(style)
  let current = structuredClone(base)
  const create = vi.fn(async (input: ComparisonCreateParams) => {
    current = { ...current, id: input.requestId }
    return current
  })
  const get = vi.fn(async () => current)
  const reconcile = vi.fn(async () => current)
  const submit = vi.fn(async (_request: ComparisonSubmitParams) => {
    throw new Error('transport disconnected')
  })
  const cancel = vi.fn(async () => current)
  const prompt = vi.fn()
  let finishOpen!: () => void
  openGates.set(
    'right-session',
    new Promise<void>((resolve) => {
      finishOpen = resolve
    }),
  )
  const call = vi.fn(async (method: string, params: { sessionId: string; upto?: number }) =>
    method === '_agnes/v1/session.projectUI'
      ? (timelines.get(params.sessionId) ?? {
          sessionId: params.sessionId,
          generation: 1,
          upto: params.upto ?? 0,
          opState: null,
          turns: [],
          nodes: [],
        })
      : { events: [], lastSeq: 0, nextAfterSeq: null },
  )
  let connectionState = 'connected'
  let notifyConnection = () => {}
  const client = {
    get connectionState() {
      return connectionState
    },
    on: (event: string, listener: () => void) => {
      if (event !== 'connectionStateChanged') return () => {}
      notifyConnection = listener
      return () => {
        notifyConnection = () => {}
      }
    },
    call,
    comparison: {
      create,
      get,
      reconcile,
      submit,
      cancel,
      journal: legacyJournal,
      list: async () => ({
        items: [savedSummary({ ...base, id: 'another-saved-comparison' })],
        nextCursor: null,
      }),
    },
    session: { prompt },
  } as unknown as Client
  const workspace = createComparisonWorkspace(client, () => ({
    runtimes: [descriptor, { ...descriptor, id: 'jevloop', label: 'JevLoop' }],
    workspaces: [{ id: 'w', path: '/project', revision: 1 }] as never,
    model: { route: 'route', model: 'same-model' },
  }))
  await workspace.open()
  document.querySelector('.comparison-setup')?.dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() => expect(document.querySelectorAll('.comparison-lane')).toHaveLength(2))
  // The lane is visible while its cold session load is pending, but diagnostics must wait for the registry owner.
  expect(call.mock.calls.some(([, params]) => params.sessionId === 'right-session')).toBe(false)
  finishOpen()
  await vi.waitFor(() =>
    expect(call).toHaveBeenCalledWith(
      '_agnes/v1/diagnostics.events',
      expect.objectContaining({ sessionId: 'right-session', afterSeq: 0 }),
    ),
  )
  const dialog = document.querySelector('dialog')!
  await vi.waitFor(() =>
    expect(dialog.querySelector('.comparison-transcript .runtime-process-card')).not.toBeNull(),
  )
  const runtimeCard = dialog.querySelector<HTMLDetailsElement>(
    '.comparison-transcript .runtime-process-card',
  )!
  expect(runtimeCard).not.toBeNull()
  expect(runtimeCard.textContent).toContain('采用路径：INSPECT → read')
  runtimeCard.open = true
  const disclosure = runtimeCard.querySelector<HTMLDetailsElement>('.runtime-process-evidence')!
  disclosure.open = true
  disclosure.dispatchEvent(new Event('toggle'))
  expect(disclosure.textContent).toContain('完整决策证据')
  expect(getComputedStyle(dialog).overflow).toBe('hidden')
  expect(getComputedStyle(dialog).display).toBe('flex')
  expect(dialog.querySelector(':scope > header')).not.toBeNull()
  expect(dialog.querySelector(':scope > .comparison-composer')).not.toBeNull()
  for (const lane of document.querySelectorAll('.comparison-lane')) {
    const scroll = lane.querySelector('.comparison-lane-body')!
    expect(getComputedStyle(scroll).overflow).toBe('auto')
    expect(scroll.querySelector('.comparison-transcript')).not.toBeNull()
    expect(lane.querySelector(':scope > header')).not.toBeNull()
  }
  expect(create.mock.calls[0]?.[0]).toMatchObject({
    cwd: '/project',
    isolation: 'snapshot',
    left: { runtime: 'native' },
    right: { runtime: 'jevloop' },
    model: { route: 'route', model: 'same-model' },
  })
  const input = document.querySelector('textarea') as HTMLTextAreaElement
  const permissionTrigger = required(
    document.querySelector<HTMLButtonElement>('.comparison-permission button'),
  )
  permissionTrigger.click()
  required(
    [...document.querySelectorAll('[role="option"]')].find(
      (row) => row.querySelector('.permission-picker-label')?.textContent === '自动审批（保持隔离）',
    ),
  ).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await vi.waitFor(() => expect(permissionTrigger.textContent).toContain('自动审批（保持隔离）'))
  input.value = 'same task'
  input.dispatchEvent(new Event('input'))
  const form = document.querySelector('.comparison-composer') as HTMLFormElement
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() => expect(input.disabled).toBe(true))
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  expect(submit.mock.calls[0]?.[0].permissionMode).toBe('full')
  expect(permissionTrigger.disabled).toBe(true)
  expect(prompt).not.toHaveBeenCalled()
  const stored = JSON.parse(sessionStorage.getItem('agnes-web-comparison') ?? '{}') as {
    pending: { inputId: string; permissionMode: string }
  }
  const inputId = stored.pending.inputId
  expect(inputId).toBeTruthy()
  expect(stored.pending.permissionMode).toBe('full')
  const retry = required(
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === '重试原请求',
    ),
  )
  await vi.waitFor(() => expect(retry.disabled).toBe(false))
  connectionState = 'reconnecting'
  notifyConnection()
  expect(retry.disabled).toBe(true)
  retry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(submit).toHaveBeenCalledTimes(1)
  connectionState = 'connected'
  notifyConnection()
  await vi.waitFor(() => expect(retry.disabled).toBe(false))
  const savedPeer = required(
    document.querySelector<HTMLButtonElement>('[data-comparison-id="another-saved-comparison"] button'),
  )
  expect(savedPeer.disabled).toBe(true)
  const beforeSwitch = get.mock.calls.length
  savedPeer.dispatchEvent(new Event('click'))
  required(
    [...document.querySelectorAll('button')].find((button) => button.textContent === '新建对比'),
  ).dispatchEvent(new Event('click'))
  expect(get.mock.calls.length).toBe(beforeSwitch)
  expect(JSON.parse(sessionStorage.getItem('agnes-web-comparison') ?? '{}').pending.inputId).toBe(inputId)
  expect(input.value).toBe('same task')
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  expect(submit).toHaveBeenCalledTimes(1)
  const refresh = [...document.querySelectorAll('button')].find((node) => node.textContent === '刷新状态')
  refresh?.click()
  await vi.waitFor(() => expect(get).toHaveBeenCalled())
  await vi.waitFor(() => expect(refresh?.disabled).toBe(false))
  expect(document.querySelector('dialog > [role=status]')?.textContent).toContain('transport disconnected')
  get.mockRejectedValueOnce(new Error('specific refresh failure'))
  refresh?.click()
  await vi.waitFor(() =>
    expect(document.querySelector('dialog > [role=status]')?.textContent).toBe('specific refresh failure'),
  )
  refresh?.click()
  await vi.waitFor(() => expect(refresh?.disabled).toBe(false))
  expect(document.querySelector('dialog > [role=status]')?.textContent).toBe('specific refresh failure')
  expect(reconcile).not.toHaveBeenCalled()
  expect(input.disabled).toBe(true)
  current = {
    ...current,
    rounds: [
      {
        inputId,
        permissionMode: 'full',
        acceptances: [
          { side: 'left', sessionId: 'left-session', status: 'accepted', seq: 2 },
          {
            side: 'right',
            sessionId: 'right-session',
            status: 'rejected',
            error: { code: 'BUSY', message: 'busy' },
          },
        ],
        settledSides: [],
        terminalCauses: [],
      },
    ],
  }
  const reconcileButton = [...document.querySelectorAll('button')].find(
    (node) => node.textContent === '核对持久状态',
  )
  await vi.waitFor(() => expect(reconcileButton?.disabled).toBe(false))
  reconcileButton?.click()
  await vi.waitFor(() => expect(input.disabled).toBe(false))
  expect(reconcile).toHaveBeenCalledWith(current.id)
  expect(document.querySelector('dialog > [role=status]')?.textContent).toBe('已确认两侧接收结果。')
  expect(submit).toHaveBeenCalledTimes(1)
  expect(form.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true)
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  expect(submit).toHaveBeenCalledTimes(1)
  expect(document.querySelector('.comparison-rounds')?.textContent).toContain('左侧 已接收 #2')
  expect(document.querySelector('.comparison-rounds')?.textContent).toContain('右侧 接收失败')
  expect(document.querySelector('.comparison-rounds')?.textContent).toContain('自动审批（保持隔离）')
  const stop = document.querySelector('.comparison-lane[data-side="left"] button') as HTMLButtonElement
  stop.click()
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith({ id: current.id, side: 'left' }))
  expect(controllers.get('right-session')?.disposed).toBe(false)
  // Closing during a later load invalidates that mount; its late completion must not start history reads.
  const oldRight = controllers.get('right-session')
  dialog.close()
  await vi.waitFor(() => expect(oldRight?.disposed).toBe(true))
  let finishReopen!: () => void
  openGates.set(
    'right-session',
    new Promise<void>((resolve) => {
      finishReopen = resolve
    }),
  )
  const callsBeforeReopen = call.mock.calls.length
  const reopening = workspace.open()
  await vi.waitFor(() => expect(controllers.get('right-session')).not.toBe(oldRight))
  dialog.close()
  await vi.waitFor(() => expect(controllers.get('right-session')?.disposed).toBe(true))
  finishReopen()
  await reopening
  expect(
    call.mock.calls.slice(callsBeforeReopen).some(([, params]) => params.sessionId === 'right-session'),
  ).toBe(false)
})

it('shows the Jev root direct count at the committed shared prefix and waits for incomplete evidence', async () => {
  const captured = JSON.parse(readFileSync('packages/core/test/fixtures/jev-real-trace.json', 'utf8')) as {
    events: EventEnvelope[]
  }
  // The capture used LLM parameters. Synthetic direct-route variants retain the real dispatch
  // identities, allowing this presentation test to observe both sides of each dispatch boundary.
  const events = captured.events.map((event) => {
    if (event.seq !== 20 && event.seq !== 43) return event
    const data = event.data as { record: { resource: Record<string, unknown> } }
    return {
      ...event,
      data: {
        ...data,
        record: {
          ...data.record,
          resource: {
            ...data.record.resource,
            route: 'direct',
          },
        },
      },
    } as EventEnvelope
  })
  const throughSeq = required(events.at(-1)).seq
  const pair: ComparisonSnapshot = {
    ...base,
    id: 'direct-count-pair',
    storageState: 'released',
    lanes: base.lanes.map((lane) => ({ ...lane, lastSeq: lane.side === 'right' ? throughSeq : 0 })),
  }
  const entries: ComparisonJournalEntry[] = events.map((event) => ({
    seq: event.seq,
    cuts: { left: 0, right: event.seq },
    fact: {
      kind: 'lane',
      side: 'right',
      sessionId: 'right-session',
      localSeq: event.seq,
      digest: 'a'.repeat(64),
    },
  }))
  const views = JSON.parse(
    readFileSync('packages/jev-web/test/fixtures/comparison-real-journal-views.json', 'utf8'),
  ) as {
    accounting: Record<
      'left' | 'right',
      Record<string, ComparisonMetricsResult['lanes'][number]['accounting']>
    >
  }
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const client = {
    comparison: {
      get: async () => pair,
      journal: async ({ id, afterSeq = 0 }: ComparisonJournalParams) => ({
        id,
        afterSeq,
        throughSeq,
        entries: entries.filter((entry) => entry.seq > afterSeq),
        nextAfterSeq: throughSeq,
        complete: true,
      }),
      events: async ({
        id,
        side,
        atSeq,
        afterSeq = 0,
      }: {
        id: string
        side: 'left' | 'right'
        atSeq: number
        afterSeq?: number
      }) => {
        await gate
        return {
          id,
          side,
          atSeq,
          sessionId: `${side}-session`,
          afterSeq,
          throughSeq: side === 'right' ? atSeq : 0,
          events:
            side === 'right' ? events.filter((event) => event.seq > afterSeq && event.seq <= atSeq) : [],
          nextAfterSeq: side === 'right' ? atSeq : 0,
          complete: true,
        }
      },
      projectUI: async ({ id, side, atSeq }: { id: string; side: 'left' | 'right'; atSeq: number }) => {
        const cut = side === 'right' ? atSeq : 0
        return {
          id,
          side,
          atSeq,
          sessionId: `${side}-session`,
          throughSeq: cut,
          timeline: { sessionId: `${side}-session`, upto: cut, opState: null, nodes: [], turns: [] },
        }
      },
      metrics: async ({ id, atSeq }: { id: string; atSeq: number }) => ({
        id,
        atSeq,
        cuts: { left: 0, right: atSeq },
        lanes: pair.lanes.map((lane) => ({
          side: lane.side,
          sessionId: lane.sessionId,
          runtime: lane.runtime,
          accounting: {
            ...required(views.accounting[lane.side]['0']),
            throughSeq: lane.side === 'right' ? atSeq : 0,
          },
        })),
      }),
    },
  } as unknown as Client
  sessionStorage.setItem('agnes-web-comparison', JSON.stringify({ id: pair.id }))
  const workspace = createComparisonWorkspace(client, () => ({ runtimes: [descriptor], workspaces: [] }))
  await workspace.open()
  const reading = () =>
    required(
      document.querySelector<HTMLElement>('.comparison-lane[data-side="right"] [data-jev-direct-count]'),
    )
  expect(reading().hidden).toBe(false)
  expect(reading().textContent).toBe('Jev 直通：待同步')
  release()
  await vi.waitFor(() => expect(reading().textContent).toBe('Jev 直通 2 次'))
  expect(reading().closest('header')).not.toBeNull()
  expect(reading().title).toContain('截至回放位置')
  expect(
    document.querySelector<HTMLElement>('.comparison-lane[data-side="left"] [data-jev-direct-count]')?.hidden,
  ).toBe(true)
  const slider = required(document.querySelector<HTMLInputElement>('[aria-label="双侧共享回放位置"]'))
  for (const [seq, count] of [
    [28, 0],
    [29, 1],
    [53, 1],
    [54, 2],
    [0, 0],
  ]) {
    slider.value = String(seq)
    slider.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(reading().textContent).toBe(`Jev 直通 ${count} 次`))
  }
  required(
    [...document.querySelectorAll<HTMLButtonElement>('.comparison-views button')].find(
      (button) => button.textContent === '双线轨迹',
    ),
  ).click()
  expect(reading().textContent).toBe('Jev 直通 0 次')
  expect(reading().hidden).toBe(false)
  workspace.close()
  await vi.waitFor(() =>
    expect(document.querySelector('.comparison-lane [data-jev-direct-count]')).toBeNull(),
  )
})

it.each(['full', 'released', 'release'] as const)(
  'uses actual durable journal order for both native views, coordinator history and metrics (%s)',
  async (storageState) => {
    const capture = JSON.parse(
      readFileSync('packages/core/test/fixtures/comparison-real-journal.json', 'utf8'),
    ) as {
      id: string
      entries: ComparisonJournalEntry[]
      reports: { lane: ComparisonLane; events: EventEnvelope[] }[]
    }
    // These expected views were generated by Core projectUI and Host accounting from the same sanitized capture.
    const views = JSON.parse(
      readFileSync('packages/jev-web/test/fixtures/comparison-real-journal-views.json', 'utf8'),
    ) as {
      projections: Record<'left' | 'right', Record<string, Omit<UITimeline, 'generation'>>>
      accounting: Record<
        'left' | 'right',
        Record<string, ComparisonMetricsResult['lanes'][number]['accounting']>
      >
    }
    const pair: ComparisonSnapshot = {
      ...base,
      id: capture.id,
      lanes: capture.reports.map((report) => report.lane),
      storageState: storageState === 'release' ? 'full' : storageState,
    }
    const byId = new Map(capture.reports.map((report) => [report.lane.sessionId, report]))
    const project = (id: string, upto: number): UITimeline => ({
      ...required(views.projections[required(byId.get(id)).lane.side][String(upto)]),
      generation: 1,
    })
    for (const report of capture.reports)
      timelines.set(report.lane.sessionId, project(report.lane.sessionId, required(report.events.at(-1)).seq))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let holdMetrics = true
    const metrics = vi.fn(
      async ({ id, atSeq }: { id: string; atSeq: number }): Promise<ComparisonMetricsResult> => {
        const cuts = atSeq === 0 ? { left: 0, right: 0 } : required(capture.entries[atSeq - 1]).cuts
        if (atSeq === 50 && holdMetrics) await gate
        return {
          id,
          atSeq,
          cuts,
          lanes: capture.reports.map(({ lane }) => ({
            side: lane.side,
            sessionId: lane.sessionId,
            runtime: lane.runtime,
            accounting: required(views.accounting[lane.side][String(cuts[lane.side])]),
          })),
        }
      },
    )
    const journal = vi.fn(async ({ id, afterSeq = 0, throughSeq = 225 }: ComparisonJournalParams) => {
      const entries = capture.entries
        .filter((entry) => entry.seq > afterSeq && entry.seq <= throughSeq)
        .slice(0, 17)
      const nextAfterSeq = entries.at(-1)?.seq ?? afterSeq
      return { id, entries, afterSeq, throughSeq, nextAfterSeq, complete: nextAfterSeq === throughSeq }
    })
    const call = vi.fn(
      async (method: string, params: { sessionId: string; upto?: number; afterSeq?: number }) => {
        const report = required(byId.get(params.sessionId))
        if (method === '_agnes/v1/diagnostics.events')
          return {
            events: report.events.filter((event) => event.seq > (params.afterSeq ?? 0)),
            lastSeq: required(report.events.at(-1)).seq,
            nextAfterSeq: null,
          }
        expect(method).toBe('_agnes/v1/session.projectUI')
        return project(params.sessionId, required(params.upto))
      },
    )
    const projectUI = vi.fn(
      async ({ id, side, atSeq }: { id: string; side: 'left' | 'right'; atSeq: number }) => {
        const report = required(capture.reports.find((report) => report.lane.side === side))
        const throughSeq = atSeq === 0 ? 0 : required(capture.entries[atSeq - 1]).cuts[side]
        return {
          id,
          side,
          atSeq,
          sessionId: report.lane.sessionId,
          throughSeq,
          timeline: required(views.projections[side][String(throughSeq)]),
        }
      },
    )
    const readEvents = vi.fn(
      async ({
        id,
        side,
        atSeq,
        afterSeq,
      }: {
        id: string
        side: 'left' | 'right'
        atSeq: number
        afterSeq: number
      }) => {
        const report = required(capture.reports.find((report) => report.lane.side === side))
        const throughSeq = atSeq === 0 ? 0 : required(capture.entries[atSeq - 1]).cuts[side]
        const events = report.events.filter((event) => event.seq > afterSeq && event.seq <= throughSeq)
        return {
          id,
          side,
          atSeq,
          sessionId: report.lane.sessionId,
          throughSeq,
          afterSeq,
          events,
          nextAfterSeq: throughSeq,
          complete: true,
        }
      },
    )
    pair.phase = 'completed'
    pair.rounds = [
      {
        inputId: 'fixture-comparison-input',
        terminalCauses: [
          { side: 'left', cause: 'cancelled' },
          { side: 'right', cause: 'finished' },
        ],
        acceptances: pair.lanes.map((lane) => ({
          side: lane.side,
          sessionId: lane.sessionId,
          status: 'accepted' as const,
          seq: 4,
        })),
        settledSides: ['left', 'right'],
      },
    ]
    const submit = vi.fn(async ({ inputId }: { inputId: string }) => {
      expect(openedSessions.size).toBe(2)
      return { ...required(pair.rounds[0]), inputId }
    })
    const remove = vi.fn(async () => ({ id: pair.id, revision: pair.revision + 1, storageState: 'removed' }))
    const releaseResources = vi.fn(async () => {
      pair.storageState = 'released'
      pair.revision++
      return structuredClone(pair)
    })
    const client = {
      call,
      questions: { pending: vi.fn(), answer: vi.fn(), cancel: vi.fn() },
      comparison: {
        get: async () => pair,
        journal,
        metrics,
        projectUI,
        events: readEvents,
        submit,
        remove,
        release: releaseResources,
      },
    } as unknown as Client
    sessionStorage.setItem('agnes-web-comparison', JSON.stringify({ id: pair.id }))
    const workspace = createComparisonWorkspace(client, () => ({ runtimes: [descriptor], workspaces: [] }))
    await workspace.open()
    const sections = () =>
      [...document.querySelectorAll<HTMLElement>('.comparison-lane')].sort((a, b) =>
        (a.dataset.side ?? '').localeCompare(b.dataset.side ?? ''),
      )
    const assertCursor = (seq: number) => {
      const cuts = seq === 0 ? { left: 0, right: 0 } : required(capture.entries[seq - 1]).cuts
      expect(document.querySelector('.comparison-metrics')?.getAttribute('data-at-seq')).toBe(String(seq))
      expect(sections().map((section) => Number(section.dataset.cut))).toEqual([cuts.left, cuts.right])
      for (const [index, side] of (['left', 'right'] as const).entries()) {
        const trace = required(sections()[index]?.querySelector<HTMLElement>('.comparison-trace-panel'))
        expect(trace.dataset.cut).toBe(String(cuts[side]))
        if (!trace.hidden) {
          const value = project(
            required(capture.reports.find((report) => report.lane.side === side)).lane.sessionId,
            cuts[side],
          )
          const expected = new Set(buildTraceRows(value.nodes, value.turns).map((row) => row.id))
          const visible = [...trace.querySelectorAll<HTMLElement>('[data-trace-row-id]')]
          expect(visible.length > 0).toBe(expected.size > 0)
          for (const row of visible) expect(expected.has(required(row.dataset.traceRowId))).toBe(true)
        }
        const rows = required(sections()[index]).querySelectorAll('.comparison-lane-body > details > ol > li')
        expect(rows).toHaveLength(cuts[side])
        expect(
          required(sections()[index]).querySelector('.comparison-lane-body > details > summary')?.textContent,
        ).toContain(`#0–${cuts[side]}`)
      }
      expect(document.querySelector('.comparison-replay-status')?.textContent).toContain(
        `共享 cursor #${seq}`,
      )
    }
    await vi.waitFor(() => assertCursor(225))
    expect(openedSessions.size).toBe(0)
    expect(client.questions.pending).not.toHaveBeenCalled()
    expect(sinks.size).toBe(0)
    expect(call).not.toHaveBeenCalled()
    expect(readEvents).toHaveBeenCalled()
    expect(projectUI).toHaveBeenCalled()
    required(
      [...document.querySelectorAll<HTMLButtonElement>('.comparison-views button')].find(
        (button) => button.textContent === '双线轨迹',
      ),
    ).click()
    assertCursor(225)
    expect(capture.entries.filter((entry) => entry.fact.kind === 'lane')).toHaveLength(55)
    expect(
      journal.mock.calls.some(
        ([params]) => (params.afterSeq ?? 0) > 0 && (params.afterSeq ?? 0) < 225 && params.throughSeq === 225,
      ),
    ).toBe(true)
    expect(document.querySelector<HTMLDetailsElement>('.comparison-metrics')?.open).toBe(false)
    expect(document.querySelector('.comparison-metrics > summary')?.textContent).toContain('已观测请求')
    expect(document.querySelector('.comparison-rounds')?.textContent).toContain('左侧 已接收 #4 · 已取消')
    expect(document.querySelector('.comparison-rounds')?.textContent).toContain('右侧 已接收 #4 · 已完成')
    const slider = required(document.querySelector<HTMLInputElement>('[aria-label="双侧共享回放位置"]'))
    expect(slider.max).toBe('225')
    const seek = (seq: number) => {
      slider.value = String(seq)
      slider.dispatchEvent(new Event('input'))
    }
    seek(5)
    await vi.waitFor(() => assertCursor(5))
    expect(document.querySelector('.comparison-replay-status')?.textContent).toContain(
      'baseline checkpoint #5：历史前缀交错未知',
    )
    expect(document.querySelector('.comparison-rounds')?.textContent).not.toContain('已取消')
    expect(document.querySelector('.comparison-rounds')?.textContent).not.toContain('已完成')
    expect(document.querySelector('.comparison-graph-column [data-stage="answer"]')?.textContent).toContain(
      '未观测请求',
    )
    seek(85)
    await vi.waitFor(() => assertCursor(85))
    seek(86) // Two actual coordinator publications share the same cuts and remain distinct global cursors.
    await vi.waitFor(() => assertCursor(86))
    expect(required(capture.entries[84]).cuts).toEqual(required(capture.entries[85]).cuts)
    expect(metrics).toHaveBeenCalledWith({ id: pair.id, atSeq: 85 })
    expect(metrics).toHaveBeenCalledWith({ id: pair.id, atSeq: 86 })
    expect(document.querySelector('.comparison-journal-fact > summary')?.textContent).toContain(
      '共享事实 #86 · coordinator',
    )
    seek(50)
    await vi.waitFor(() => expect(metrics).toHaveBeenCalledWith({ id: pair.id, atSeq: 50 }))
    assertCursor(86)
    expect(document.querySelector('.comparison-metrics [role="status"]')?.textContent).toContain('仍显示 #86')
    seek(6)
    await vi.waitFor(() => assertCursor(6))
    expect(document.querySelector('.comparison-rounds')?.textContent).not.toContain('已取消')
    expect(document.querySelector('.comparison-rounds')?.textContent).not.toContain('已完成')
    holdMetrics = false
    release()
    await Promise.resolve()
    await Promise.resolve()
    assertCursor(6)
    seek(0)
    await vi.waitFor(() => assertCursor(0))
    expect(document.querySelectorAll('.comparison-transcript article')).toHaveLength(0)
    const live = required(
      [...document.querySelectorAll<HTMLButtonElement>('.comparison-replay button')].find(
        (button) => button.textContent === '实时',
      ),
    )
    live.click()
    await vi.waitFor(() => assertCursor(225))
    expect(openedSessions.size).toBe(0)
    expect(sinks.size).toBe(0)
    expect(call).not.toHaveBeenCalled()
    expect(readEvents).toHaveBeenCalled()
    expect(projectUI).toHaveBeenCalled()
    expect(document.querySelectorAll('.comparison-transcript .turn-process').length).toBeGreaterThan(0)
    expect(document.querySelector('.comparison-transcript .runtime-process-card')).not.toBeNull()
    expect(
      document.querySelector('.comparison-metrics [data-side="left"] [data-family="llm"]')?.textContent,
    ).toContain('未知')
    expect(document.querySelector('.comparison-metrics')?.textContent).not.toContain('USD')
    const input = required(document.querySelector<HTMLTextAreaElement>('.comparison-composer textarea'))
    if (storageState === 'release') {
      const previousConfirm = window.confirm
      window.confirm = vi.fn(() => true)
      const expectedRevision = pair.revision
      try {
        required(
          [...document.querySelectorAll<HTMLButtonElement>('button')].find(
            (button) => button.textContent === '释放运行资源',
          ),
        ).click()
        await vi.waitFor(() =>
          expect(releaseResources).toHaveBeenCalledWith({ id: pair.id, expectedRevision }),
        )
        await vi.waitFor(() =>
          expect(document.querySelector('dialog > [role="status"]')?.textContent).toContain('运行资源已释放'),
        )
        await vi.waitFor(() => assertCursor(225))
        expect(openedSessions.size).toBe(0)
      } finally {
        window.confirm = previousConfirm
      }
    }
    if (storageState !== 'full') {
      expect(input.disabled).toBe(true)
      input.value = 'must not resume archived owners'
      required(document.querySelector('.comparison-composer')).dispatchEvent(
        new Event('submit', { cancelable: true }),
      )
      await Promise.resolve()
      expect(submit).not.toHaveBeenCalled()
      expect(openedSessions.size).toBe(0)
      const previousConfirm = window.confirm
      window.confirm = vi.fn(() => true)
      try {
        required(
          [...document.querySelectorAll<HTMLButtonElement>('button')].find(
            (button) => button.textContent === '删除对比记录',
          ),
        ).click()
        await vi.waitFor(() =>
          expect(remove).toHaveBeenCalledWith({ id: pair.id, expectedRevision: pair.revision }),
        )
        await vi.waitFor(() => expect(sessionStorage.getItem('agnes-web-comparison')).toBeNull())
        expect(openedSessions.size).toBe(0)
      } finally {
        window.confirm = previousConfirm
      }
      return
    }
    input.value = 'continue after viewing history'
    input.dispatchEvent(new Event('input'))
    const rightId = required(pair.lanes[1]).sessionId
    openGates.set(rightId, Promise.reject(new Error('Load transport lost')))
    disposeFailures.add(rightId)
    required(document.querySelector('.comparison-composer')).dispatchEvent(
      new Event('submit', { cancelable: true }),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('dialog > [role="status"]')?.textContent).toContain('断开连接也未确认'),
    )
    expect(submit).not.toHaveBeenCalled()
    let resume!: () => void
    openGates.set(
      rightId,
      new Promise<void>((resolve) => {
        resume = resolve
      }),
    )
    required(document.querySelector('.comparison-composer')).dispatchEvent(
      new Event('submit', { cancelable: true }),
    )
    await vi.waitFor(() => expect(openedSessions.size).toBe(1))
    expect(submit).not.toHaveBeenCalled()
    expect(JSON.parse(sessionStorage.getItem('agnes-web-comparison')!).pending).toBeUndefined()
    expect(input.value).toBe('continue after viewing history')
    required(document.querySelector('dialog')).close()
    await workspace.open()
    resume()
    await vi.waitFor(() => expect(openedSessions.size).toBe(2))
    expect(submit).not.toHaveBeenCalled() // Retire the old connection attempt across close/reopen.
    expect(JSON.parse(sessionStorage.getItem('agnes-web-comparison')!).pending).toBeUndefined()
    required(document.querySelector('.comparison-composer')).dispatchEvent(
      new Event('submit', { cancelable: true }),
    )
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(sinks.size).toBe(2)
  },
)

it.each(['gap', 'incomplete', 'bytes', 'identity', 'bound', 'permission'] as const)(
  'keeps missing or invalid shared journal evidence visible without fabricating fallback (%s)',
  async (failure) => {
    const capture = JSON.parse(
      readFileSync('packages/core/test/fixtures/comparison-real-journal.json', 'utf8'),
    ) as { id: string; entries: ComparisonJournalEntry[]; reports: { lane: ComparisonLane }[] }
    const entries = structuredClone(capture.entries.slice(0, 2))
    if (failure === 'gap') required(entries[1]).seq = 3
    if (failure === 'bytes') {
      const fact = required(entries[0]).fact
      if (fact.kind !== 'coordinator') throw new Error('Expected real coordinator fact')
      fact.lanes.left = {
        sessionId: required(capture.reports[0]).lane.sessionId,
        runtime: owner,
        phase: 'x'.repeat(2_097_152),
      }
    }
    const states: ComparisonJournalState[] = []
    const journal = createComparisonJournal(
      {
        comparison: {
          journal: async () => {
            if (failure === 'permission')
              throw new JsonRpcError({
                code: -32003,
                message: '权限不足',
                data: { code: 'CAPABILITY_DENIED' },
              })
            return {
              id: failure === 'identity' ? 'foreign' : capture.id,
              entries,
              afterSeq: 0,
              throughSeq: failure === 'bound' ? -1 : 2,
              nextAfterSeq: 2,
              complete: failure !== 'incomplete',
            }
          },
        },
      } as unknown as Client,
      capture.id,
      capture.reports.map((report) => report.lane),
      (state) => states.push(state),
    )
    await journal.read()
    expect(states.at(-1)?.mode).toBe('error')
    expect(states.at(-1)?.entries).toEqual([])
    expect(states.at(-1)?.error).toContain('共享 journal 读取失败')
    journal.dispose()
  },
)

it('fixes each journal page boundary while new publications arrive, preserving the old prefix on a failed refresh', async () => {
  const capture = JSON.parse(
    readFileSync('packages/core/test/fixtures/comparison-real-journal.json', 'utf8'),
  ) as { id: string; entries: ComparisonJournalEntry[]; reports: { lane: ComparisonLane }[] }
  const terminal = required(capture.entries.findLast((entry) => entry.fact.kind === 'coordinator'))
  // Synthetic later coordinator append tests page isolation; the first 225 publication entries are actual.
  const later: ComparisonJournalEntry = {
    seq: 226,
    cuts: required(capture.entries.at(-1)).cuts,
    fact: terminal.fact,
  }
  let head = 225
  let corrupt = false
  const api = vi.fn(async ({ id, afterSeq = 0, throughSeq = head }: ComparisonJournalParams) => {
    const all = [...capture.entries, later]
    const entries = all.filter((entry) => entry.seq > afterSeq && entry.seq <= throughSeq).slice(0, 13)
    const nextAfterSeq = entries.at(-1)?.seq ?? afterSeq
    head = 226
    return {
      id,
      entries: corrupt ? [] : entries,
      afterSeq,
      throughSeq,
      nextAfterSeq,
      complete: nextAfterSeq === throughSeq,
    }
  })
  const states: ComparisonJournalState[] = []
  const journal = createComparisonJournal(
    { comparison: { journal: api } } as unknown as Client,
    capture.id,
    capture.reports.map((report) => report.lane),
    (state) => states.push(state),
  )
  await journal.read()
  expect(states.at(-1)?.throughSeq).toBe(225)
  expect(states.at(-1)?.entries).toEqual(capture.entries)
  expect(api.mock.calls.slice(1).every(([params]) => params.throughSeq === 225)).toBe(true)
  corrupt = true
  await journal.read()
  expect(states.at(-1)?.throughSeq).toBe(225)
  expect(states.at(-1)?.error).toContain('前缀未完整返回')
  corrupt = false
  await journal.read()
  expect(states.at(-1)?.throughSeq).toBe(226)
  expect(states.at(-1)?.error).toBeUndefined()
  journal.dispose()
})

it('renders API partial totals as known subtotals and independent currencies without inventing prices', () => {
  const views = JSON.parse(
    readFileSync('packages/jev-web/test/fixtures/comparison-real-journal-views.json', 'utf8'),
  ) as {
    accounting: Record<
      'left' | 'right',
      Record<string, ComparisonMetricsResult['lanes'][number]['accounting']>
    >
  }
  const accounting = structuredClone(required(views.accounting.right['37']))
  // Currency totals exercise rendering of wire values, rather than deriving rates or charges in Web.
  accounting.llm.costs = {
    EUR: { state: 'partial', value: null, knownSubtotal: 2, missing: 1 },
    USD: { state: 'unknown', value: null, knownSubtotal: null, missing: 1 },
  }
  accounting.llm.tokens.output = { state: 'partial', value: null, knownSubtotal: 1206, missing: 1 }
  accounting.llm.outcomes = { completed: 1, failed: 0, cancelled: 0, pending: 0, unknown: 0 }
  accounting.llm.byPurpose = { answer: { attempts: 1, outcomes: accounting.llm.outcomes } }
  accounting.llm.reportedBilling = {
    gateway: {
      attempts: 0,
      usdMicros: { state: 'unknown', value: null, knownSubtotal: null, missing: 1 },
      subscriptionAttempts: 0,
      nonSubscriptionAttempts: 0,
    },
    estimated: {
      attempts: 1,
      usdMicros: { state: 'partial', value: null, knownSubtotal: 309, missing: 1 },
      subscriptionAttempts: 0,
      nonSubscriptionAttempts: 1,
    },
    missingAttempts: 1,
  }
  accounting.issues = ['incomplete_reader']
  const host = document.createElement('div')
  const metrics = createComparisonMetrics(host)
  metrics.render({
    id: 'wire',
    atSeq: 225,
    cuts: { left: 24, right: 37 },
    lanes: [{ side: 'right', sessionId: 'r', runtime: { id: 'jevloop', version: '1' }, accounting }],
  })
  const prepared = {
    sessionId: 'r',
    sourceSeq: 4,
    sourceDigest: 'a'.repeat(64),
    configuration: {
      runtime: { id: 'jevloop', version: '1' },
      effective: {
        preset: {
          name: 'frozen-standard',
          definitionDigest: 'b'.repeat(64),
          scope: 'resolved-preset-view' as const,
        },
        models: [
          {
            slot: 'primary',
            route: 'frozen-route',
            model: 'frozen-model',
            thinking: null,
            contextWindow: 8192,
          },
        ],
        tools: { count: 2, digest: 'c'.repeat(64), scope: 'registered-tool-definitions' as const },
        permission: {
          approvalMode: 'manual' as const,
          yolo: false,
          enforcement: null,
          policyDigest: null,
          digest: null,
        },
      },
      runtimeConfig: null,
      fingerprints: {
        tools: 'c'.repeat(64),
        model: 'd'.repeat(64),
        preset: 'b'.repeat(64),
        permission: null,
      },
    },
  }
  metrics.render({
    id: 'wire',
    atSeq: 225,
    cuts: { left: 24, right: 37 },
    lanes: [
      { side: 'right', sessionId: 'r', runtime: { id: 'jevloop', version: '1' }, accounting, prepared },
    ],
  })
  const preparation = required(host.querySelector<HTMLDetailsElement>('.comparison-prepared'))
  expect(preparation.open).toBe(false)
  expect(preparation.textContent).toContain('frozen-standard')
  expect(preparation.textContent).toContain('frozen-route / frozen-model')
  expect(preparation.textContent).toContain('预设输出上限 未知（旧回执未记录）')
  expect(preparation.closest('.comparison-results')).not.toBeNull()
  expect(preparation.textContent).toContain('源 #4')
  expect(preparation.textContent).toContain('挂载配置：未知（此回执无可信挂载证据）')
  preparation.open = true
  metrics.render({
    id: 'wire',
    atSeq: 225,
    cuts: { left: 24, right: 37 },
    lanes: [
      {
        side: 'right',
        sessionId: 'r',
        runtime: { id: 'jevloop', version: '1' },
        accounting,
        prepared: structuredClone(prepared),
      },
    ],
  })
  expect(host.querySelector('.comparison-prepared')).toBe(preparation)
  expect(preparation.open).toBe(true)
  metrics.render({
    id: 'wire',
    atSeq: 224,
    cuts: { left: 24, right: 3 },
    lanes: [
      { side: 'right', sessionId: 'r', runtime: { id: 'jevloop', version: '1' }, accounting, prepared: null },
    ],
  })
  expect(host.querySelector('.comparison-prepared')).toBeNull()
  expect(host.textContent).toContain('准备配置：未知')
  expect(host.querySelector<HTMLDetailsElement>('.comparison-metrics')?.open).toBe(false)
  const content = host.querySelector('[data-family="llm"]')?.textContent
  expect(content).toContain('已知小计 1206（非总量，缺失 1）')
  expect(content).toContain('价格估算费用 EUR已知小计 2（非总量，缺失 1）')
  expect(content).toContain('价格估算费用 USD未知')
  expect(content).not.toContain('USD0')
  expect(content).toContain('已观测请求结果完成 1')
  expect(content).toContain('用途：回答1 已观测请求')
  expect(content).toContain('网关报告金额（微美元）未知')
  expect(content).toContain('已报告估算金额（微美元）已知小计 309（非总量，缺失 1）')
  expect(content).toContain('已报告估算覆盖1 已观测请求 · 订阅 0 · 非订阅 1')
  expect(content).toContain('缺少金额报告的请求1')
  expect(content).toContain('总输入（含缓存）未知')
  expect(host.querySelector('.comparison-metrics-lanes details > summary')?.textContent).toBe(
    '证据不完整，查看读取限制',
  )
  expect(host.querySelector<HTMLDetailsElement>('.comparison-metrics-lanes details')?.open).toBe(false)
  expect(host.textContent).not.toContain('attempts')
})

it('gates pointer and keyboard submission until every admitted lane is durably terminal', async () => {
  let current = structuredClone(base)
  const submit = vi.fn()
  const get = vi.fn(async () => current)
  const client = {
    comparison: { get, submit, journal: legacyJournal },
    call: async (method: string, params: { sessionId: string; upto?: number }) =>
      method === '_agnes/v1/session.projectUI'
        ? {
            sessionId: params.sessionId,
            generation: 1,
            upto: params.upto ?? 0,
            opState: null,
            nodes: [],
            turns: [],
          }
        : { events: [], lastSeq: 0, nextAfterSeq: null },
  } as unknown as Client
  sessionStorage.setItem('agnes-web-comparison', JSON.stringify({ id: base.id }))
  const workspace = createComparisonWorkspace(client, () => ({ runtimes: [descriptor], workspaces: [] }))
  await workspace.open()
  const form = required(document.querySelector<HTMLFormElement>('.comparison-composer'))
  const input = required(form.querySelector('textarea'))
  const send = required(form.querySelector<HTMLButtonElement>('button[type=submit]'))
  const refresh = required(
    [...document.querySelectorAll('button')].find((button) => button.textContent === '刷新状态'),
  )
  input.value = 'next task'
  input.dispatchEvent(new Event('input'))
  await vi.waitFor(() => expect(send.disabled).toBe(false))
  const permission = required(document.querySelector<HTMLButtonElement>('.comparison-permission button'))
  permission.click()
  const menu = required(document.querySelector('[role="listbox"]'))
  let finishRefresh!: (value: ComparisonSnapshot) => void
  get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRefresh = resolve
      }),
  )
  // Dispatch without an outside pointer click, just as the background snapshot timer does.
  refresh.dispatchEvent(new Event('click'))
  expect(refresh.disabled).toBe(true)
  expect(permission.disabled).toBe(false)
  expect(menu.isConnected).toBe(true)
  required(
    [...menu.querySelectorAll('[role="option"]')].find(
      (row) => row.querySelector('.permission-picker-label')?.textContent === '自动审批（保持隔离）',
    ),
  ).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await vi.waitFor(() => expect(permission.textContent).toContain('自动审批（保持隔离）'))
  permission.click()
  const reopenedMenu = required(document.querySelector('[role="listbox"]'))
  finishRefresh(current)
  await vi.waitFor(() => expect(refresh.disabled).toBe(false))
  expect(reopenedMenu.isConnected).toBe(true)
  expect(permission.disabled).toBe(false)
  expect(permission.textContent).toContain('自动审批（保持隔离）')
  expect(submit).not.toHaveBeenCalled()
  reopenedMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const accepted: ComparisonSnapshot['rounds'][number] = {
    inputId: 'previous',
    acceptances: [
      { side: 'left', sessionId: 'left-session', status: 'accepted', seq: 2 },
      { side: 'right', sessionId: 'right-session', status: 'accepted', seq: 2 },
    ],
    settledSides: [],
    terminalCauses: [],
  }
  const cases: [ComparisonSnapshot['phase'], ComparisonSnapshot['rounds'], boolean][] = [
    ['preparing', [], true],
    ['failed', [], true],
    ['running', [accepted], true],
    ['completed', [accepted], true],
    ['partial', [{ ...accepted, settledSides: ['left'] }], true],
    [
      'partial',
      [
        {
          ...accepted,
          acceptances: [
            required(accepted.acceptances[0]),
            { side: 'right', sessionId: 'right-session', status: 'unknown' },
          ],
          settledSides: ['left', 'right'],
        },
      ],
      true,
    ],
    ['completed', [{ ...accepted, settledSides: ['left', 'right'] }], false],
    [
      'cancelled',
      [
        {
          ...accepted,
          terminalCauses: [
            { side: 'left', cause: 'cancelled' },
            { side: 'right', cause: 'cancelled' },
          ],
        },
      ],
      false,
    ],
    [
      'partial',
      [
        {
          ...accepted,
          acceptances: accepted.acceptances.map((item) => ({
            side: item.side,
            sessionId: item.sessionId,
            status: 'rejected' as const,
            error: { code: 'REFUSED', message: 'refused' },
          })),
        },
      ],
      false,
    ],
  ]
  for (const [phase, rounds, disabled] of cases) {
    current = { ...base, phase, rounds }
    refresh.click()
    await vi.waitFor(() => expect(refresh.disabled).toBe(false))
    expect(send.disabled).toBe(disabled)
    expect(
      required(document.querySelector<HTMLButtonElement>('.comparison-permission button')).disabled,
    ).toBe(disabled)
    expect(input.value).toBe('next task')
    if (disabled) {
      send.click()
      form.dispatchEvent(new Event('submit', { cancelable: true }))
      expect(submit).not.toHaveBeenCalled()
    }
  }
})

it.each([
  ['COMPARISON_BUSY', {}, true],
  ['COMPARISON_NOT_READY', {}, true],
  ['COMPARISON_NOT_READY', { admissionReason: 'configuration-changed' }, true],
  ['COMPARISON_NOT_READY', { admissionReason: 'prepared-source-invalid' }, true],
  ['COMPARISON_NOT_READY', { admissionReason: 'resource-recovery-required' }, true],
  ['COMPARISON_BUSY', { id: 'another-comparison' }, false],
  ['COMPARISON_BUSY', { inputId: 'another-input' }, false],
  ['COMPARISON_BUSY', { phase: 'post-admission' }, false],
  ['COMPARISON_BUSY', { inputAccepted: undefined }, false],
  ['COMPARISON_BUSY', { inputAccepted: true }, false],
  ['INTERNAL', {}, false],
] as const)(
  'releases a rejected draft only with matching pre-admission proof (%s, %j)',
  async (code, overrides, refused) => {
    const requests: string[] = []
    const submit = vi.fn(async (params: { id: string; inputId: string }) => {
      requests.push(params.inputId)
      if (requests.length === 1) {
        throw new JsonRpcError({
          code: -32000,
          message: 'Request rejected',
          data: { code, ...params, phase: 'pre-admission', inputAccepted: false, ...overrides },
        })
      }
      if (!refused && requests.length === 2)
        throw new JsonRpcError({
          code: -32000,
          message: 'Retry refused while the first invocation remains unknown',
          data: { code: 'COMPARISON_BUSY', ...params, phase: 'pre-admission', inputAccepted: false },
        })
      return {
        inputId: params.inputId,
        acceptances: [
          { side: 'left', sessionId: 'left-session', status: 'accepted', seq: 2 },
          { side: 'right', sessionId: 'right-session', status: 'accepted', seq: 2 },
        ],
        settledSides: [],
        terminalCauses: [],
      }
    })
    const client = {
      comparison: { get: async () => structuredClone(base), submit, journal: legacyJournal },
      call: async (method: string, params: { sessionId: string; upto?: number }) =>
        method === '_agnes/v1/session.projectUI'
          ? {
              sessionId: params.sessionId,
              generation: 1,
              upto: params.upto ?? 0,
              opState: null,
              nodes: [],
              turns: [],
            }
          : { events: [], lastSeq: 0, nextAfterSeq: null },
    } as unknown as Client
    sessionStorage.setItem('agnes-web-comparison', JSON.stringify({ id: base.id }))
    const workspace = createComparisonWorkspace(client, () => ({ runtimes: [descriptor], workspaces: [] }))
    await workspace.open()
    const form = required(document.querySelector<HTMLFormElement>('.comparison-composer'))
    const input = required(form.querySelector('textarea'))
    const send = required(form.querySelector<HTMLButtonElement>('button[type=submit]'))
    const refresh = required(
      [...document.querySelectorAll('button')].find((button) => button.textContent === '刷新状态'),
    )
    input.value = 'preserved draft'
    input.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(send.disabled).toBe(false))
    send.click()
    await vi.waitFor(() =>
      expect(document.querySelector('dialog > [role=status]')?.textContent).toContain(
        refused ? '本次输入尚未接收' : '连接未确认提交结果',
      ),
    )
    expect(requests).toHaveLength(1)
    expect(input.value).toBe('preserved draft')
    const stored = () =>
      JSON.parse(sessionStorage.getItem('agnes-web-comparison') ?? '{}') as { pending?: { inputId: string } }
    if (refused) {
      expect(stored().pending).toBeUndefined()
      expect(input.disabled).toBe(false)
      expect(send.disabled).toBe(false)
      expect(document.querySelector('dialog > [role=status]')?.textContent).toContain('本次输入尚未接收')
      if ('admissionReason' in overrides)
        expect(document.querySelector('dialog > [role=status]')?.textContent).toContain(
          overrides.admissionReason === 'resource-recovery-required' ? '运行资源需要恢复' : '请新建对比',
        )
      send.click()
      await vi.waitFor(() => expect(requests).toHaveLength(2))
      expect(requests[1]).not.toBe(requests[0])
      await vi.waitFor(() => expect(input.value).toBe(''))
    } else {
      // Even a successful read with no such round cannot prove a request was never accepted.
      refresh.click()
      await vi.waitFor(() => expect(refresh.disabled).toBe(false))
      expect(stored().pending?.inputId).toBe(requests[0])
      expect(send.disabled).toBe(true)
      form.dispatchEvent(new Event('submit', { cancelable: true }))
      expect(requests).toHaveLength(1)
      const retry = required(
        [...document.querySelectorAll('button')].find((button) => button.textContent === '重试原请求'),
      )
      expect(retry.disabled).toBe(false)
      retry.click()
      await vi.waitFor(() => expect(requests).toHaveLength(2))
      expect(requests[1]).toBe(requests[0])
      await vi.waitFor(() => expect(retry.disabled).toBe(false))
      expect(stored().pending?.inputId).toBe(requests[0])
      expect(input.disabled).toBe(true)
      retry.click()
      await vi.waitFor(() => expect(requests).toHaveLength(3))
      expect(requests[2]).toBe(requests[0])
      await vi.waitFor(() => expect(input.value).toBe(''))
    }
  },
)

it.each([
  ['WORKSPACE_SYMLINK_UNRESOLVED', '无法解析或循环引用'],
  ['WORKSPACE_EXTERNAL_REFERENCE_DENIED', '外部文件引用未获读取授权'],
  ['WORKSPACE_SNAPSHOT_LIMIT', '工作区超过快照'],
  ['COMPARISON_ISOLATION_REQUIRED', '需要启用文件系统隔离'],
  ['COMPARISON_PREPARATION_BUSY', '已有会话仍持有运行配置'],
  ['WORKSPACE_UNKNOWN_PRIVATE', '旧记录不能补推原因'],
  ['COMPARISON_CREATE_FAILED', '旧记录不能补推原因'],
])('renders a bounded creation refusal for %s without remote exception prose', async (code, explanation) => {
  const create = vi.fn(async () => {
    throw new JsonRpcError({ code: -32011, message: '/private/source secret exception', data: { code } })
  })
  const client = {
    comparison: { create, list: async () => ({ items: [], nextCursor: null }) },
  } as unknown as Client
  const workspace = createComparisonWorkspace(client, () => ({
    runtimes: [descriptor],
    workspaces: [{ id: 'w', path: '/project', revision: 1 }] as never,
  }))
  await workspace.open()
  required(document.querySelector('.comparison-setup')).dispatchEvent(
    new Event('submit', { cancelable: true }),
  )
  await vi.waitFor(() =>
    expect(document.querySelector('dialog > [role=status]')?.textContent).toContain(explanation),
  )
  expect(document.querySelector('dialog > [role=status]')?.textContent).not.toContain('/private/')
  expect(document.querySelector('dialog > [role=status]')?.textContent).not.toContain('secret exception')
  expect(controllers.size).toBe(0)
})

it('pages saved metadata without opening lanes, switches explicitly without cancellation and preserves drafts on failure', async () => {
  const capture = JSON.parse(
    readFileSync('packages/core/test/fixtures/comparison-real-cancel.json', 'utf8'),
  ) as { pair: ComparisonSnapshot }
  const first = capture.pair
  const second: ComparisonSnapshot = {
    ...first,
    id: 'another-saved-pair',
    lanes: first.lanes.map((lane) => ({ ...lane, sessionId: `second-${lane.side}` })),
  }
  const preparing: ComparisonListItem = {
    ...savedSummary(first),
    id: 'preparing-pair',
    phase: 'preparing',
    inspectable: false,
    lanes: [],
  }
  const failed: ComparisonListItem = { ...preparing, id: 'failed-pair', phase: 'failed' }
  const list = vi.fn(
    async (params: ComparisonListParams): Promise<ComparisonListResult> =>
      params.cursor
        ? { items: [savedSummary(second)], nextCursor: null }
        : { items: [savedSummary(first), preparing, failed], nextCursor: 'fixed-membership-page-2' },
  )
  let failGet = false
  const get = vi.fn(async (id: string) => {
    if (failGet && id === second.id)
      throw new JsonRpcError({
        code: -32011,
        message: '/private/saved selection unavailable',
        data: { code: 'WORKSPACE_SOURCE_CHANGED' },
      })
    return id === first.id ? first : second
  })
  const cancel = vi.fn()
  const create = vi.fn()
  const reconcile = vi.fn()
  const client = {
    call: emptyHistoryProjection,
    comparison: { list, get, cancel, create, reconcile, journal: legacyJournal },
  } as unknown as Client
  const workspace = createComparisonWorkspace(client, () => ({ runtimes: [descriptor], workspaces: [] }))
  await workspace.open()
  await vi.waitFor(() => expect(document.querySelectorAll('.comparison-history-rows li')).toHaveLength(3))
  expect(list).toHaveBeenCalledWith({ limit: 20 })
  expect(controllers.size).toBe(0)
  expect(get).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(reconcile).not.toHaveBeenCalled()
  expect(document.querySelector('.comparison-history-rows')?.textContent).toContain('创建：未知；更新：未知')
  const choose = (id: string) =>
    required(document.querySelector<HTMLButtonElement>(`[data-comparison-id="${id}"] button`))
  expect(choose(preparing.id).disabled).toBe(true)
  expect(choose(failed.id).disabled).toBe(true)
  expect(document.querySelector('[data-comparison-id="preparing-pair"]')?.textContent).toContain('仍在准备')
  const more = required(
    [...document.querySelectorAll('button')].find((button) => button.textContent === '加载更多对比'),
  )
  more.click()
  await vi.waitFor(() => expect(document.querySelectorAll('.comparison-history-rows li')).toHaveLength(4))
  expect(list).toHaveBeenLastCalledWith({ limit: 20, cursor: 'fixed-membership-page-2' })
  expect(more.hidden).toBe(true)
  expect(controllers.size).toBe(0)
  choose(first.id).click()
  await vi.waitFor(() => expect(choose(first.id).getAttribute('aria-current')).toBe('true'))
  await vi.waitFor(() => expect(choose(second.id).disabled).toBe(false))
  const input = required(document.querySelector<HTMLTextAreaElement>('.comparison-composer textarea'))
  input.value = 'draft for first pair'
  input.dispatchEvent(new Event('input'))
  const firstPanes = first.lanes.map((lane) => required(controllers.get(lane.sessionId)))
  choose(second.id).click()
  await vi.waitFor(() => expect(choose(first.id).disabled).toBe(false))
  expect(firstPanes.every((pane) => pane.disposed)).toBe(true)
  expect(input.value).toBe('')
  input.value = 'second draft'
  input.dispatchEvent(new Event('input'))
  choose(first.id).click()
  await vi.waitFor(() => expect(choose(second.id).disabled).toBe(false))
  expect(input.value).toBe('draft for first pair')
  const retained = first.lanes.map((lane) => required(controllers.get(lane.sessionId)))
  failGet = true
  choose(second.id).click()
  await vi.waitFor(() =>
    expect(document.querySelector('dialog > [role=status]')?.textContent).toContain(
      '工作区在快照期间发生变化',
    ),
  )
  expect(document.querySelector('dialog > [role=status]')?.textContent).not.toContain('/private/')
  expect(retained.every((pane) => !pane.disposed)).toBe(true)
  expect(input.value).toBe('draft for first pair')
  expect(JSON.parse(sessionStorage.getItem('agnes-web-comparison') ?? '{}').id).toBe(first.id)
  failGet = false
  let rejectOpen!: (error: Error) => void
  openGates.set(
    'second-left',
    new Promise<void>((_resolve, reject) => {
      rejectOpen = reject
    }),
  )
  choose(second.id).click()
  await vi.waitFor(() => expect(controllers.get('second-left')?.disposed).toBe(false))
  rejectOpen(new Error('saved lane unavailable'))
  await vi.waitFor(() =>
    expect(document.querySelector('dialog > [role=status]')?.textContent).toContain('saved lane unavailable'),
  )
  expect(input.value).toBe('draft for first pair')
  expect(choose(first.id).getAttribute('aria-current')).toBe('true')
  expect(controllers.get('second-right')?.disposed).toBe(true)
  expect(cancel).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(reconcile).not.toHaveBeenCalled()
})

it.each(['close', 'new', 'select', 'dispose'] as const)(
  'retires late saved-list responses after %s',
  async (action) => {
    const capture = JSON.parse(
      readFileSync('packages/core/test/fixtures/comparison-real-cancel.json', 'utf8'),
    ) as { pair: ComparisonSnapshot }
    const pair = capture.pair
    let finish!: (value: ComparisonListResult) => void
    const list = vi.fn(
      async (): Promise<ComparisonListResult> => ({ items: [savedSummary(pair)], nextCursor: null }),
    )
    const get = vi.fn(async () => pair)
    const client = {
      call: emptyHistoryProjection,
      comparison: { list, get, journal: legacyJournal },
    } as unknown as Client
    const workspace = createComparisonWorkspace(client, () => ({ runtimes: [descriptor], workspaces: [] }))
    await workspace.open()
    await vi.waitFor(() => expect(document.querySelectorAll('.comparison-history-rows li')).toHaveLength(1))
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    required(
      [...document.querySelectorAll('button')].find((button) => button.textContent === '刷新已保存对比'),
    ).click()
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    if (action === 'dispose') {
      await workspace.dispose()
      expect(document.querySelector('.comparison-workspace')).toBeNull()
      await workspace.open(pair.id)
      expect(document.querySelector('.comparison-workspace')).toBeNull()
    } else if (action === 'close') required(document.querySelector('dialog')).close()
    else if (action === 'new')
      required(
        [...document.querySelectorAll('button')].find((button) => button.textContent === '新建对比'),
      ).click()
    else required(document.querySelector<HTMLButtonElement>('.comparison-history-rows button')).click()
    await Promise.resolve()
    finish({ items: [{ ...savedSummary(pair), id: 'stale-list-reply' }], nextCursor: null })
    await Promise.resolve()
    await Promise.resolve()
    expect(document.querySelector('[data-comparison-id="stale-list-reply"]')).toBeNull()
    if (action === 'select') await vi.waitFor(() => expect(controllers.size).toBe(2))
    else expect(controllers.size).toBe(0)
  },
)

it('retires a saved selection response when its dialog closes and reopens', async () => {
  const capture = JSON.parse(
    readFileSync('packages/core/test/fixtures/comparison-real-cancel.json', 'utf8'),
  ) as { pair: ComparisonSnapshot }
  let finish!: (value: ComparisonSnapshot) => void
  const get = vi.fn(
    () =>
      new Promise<ComparisonSnapshot>((resolve) => {
        finish = resolve
      }),
  )
  const client = {
    call: emptyHistoryProjection,
    comparison: {
      get,
      list: async () => ({ items: [savedSummary(capture.pair)], nextCursor: null }),
      journal: legacyJournal,
    },
  } as unknown as Client
  const workspace = createComparisonWorkspace(client, () => ({ runtimes: [descriptor], workspaces: [] }))
  await workspace.open()
  await vi.waitFor(() => expect(document.querySelectorAll('.comparison-history-rows li')).toHaveLength(1))
  required(document.querySelector<HTMLButtonElement>('.comparison-history-rows button')).click()
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
  required(document.querySelector('dialog')).close()
  await workspace.open()
  finish(capture.pair)
  await Promise.resolve()
  await Promise.resolve()
  expect(controllers.size).toBe(0)
  expect(sessionStorage.getItem('agnes-web-comparison')).toBeNull()
})

it('keeps an uncertain input and its draft locked when restoring the saved comparison fails', async () => {
  const saved = { id: base.id, pending: { inputId: 'uncertain-persisted-input', text: 'unconfirmed draft' } }
  sessionStorage.setItem('agnes-web-comparison', JSON.stringify(saved))
  const create = vi.fn()
  const client = {
    comparison: {
      create,
      get: async () => {
        throw new Error('restore unavailable')
      },
      list: async () => ({ items: [savedSummary({ ...base, id: 'other-pair' })], nextCursor: null }),
    },
  } as unknown as Client
  const workspace = createComparisonWorkspace(client, () => ({ runtimes: [descriptor], workspaces: [] }))
  await expect(workspace.open()).rejects.toThrow('restore unavailable')
  await vi.waitFor(() => expect(document.querySelectorAll('.comparison-history-rows li')).toHaveLength(1))
  expect(document.querySelector<HTMLButtonElement>('.comparison-history-rows button')?.disabled).toBe(true)
  expect(
    required([...document.querySelectorAll('button')].find((button) => button.textContent === '新建对比'))
      .disabled,
  ).toBe(true)
  expect(document.querySelector<HTMLTextAreaElement>('.comparison-composer textarea')?.value).toBe(
    saved.pending.text,
  )
  expect(JSON.parse(sessionStorage.getItem('agnes-web-comparison') ?? '{}')).toEqual(saved)
  expect(controllers.size).toBe(0)
  required(document.querySelector('.comparison-setup')).dispatchEvent(
    new Event('submit', { cancelable: true }),
  )
  expect(create).not.toHaveBeenCalled()
})

it('renders all four captured accounting members and binds each lazy price reader to its own fixed cut', async () => {
  const captured = JSON.parse(
    readFileSync('packages/jev-web/test/fixtures/comparison-real-tree-prices.json', 'utf8'),
  ) as {
    metrics: ComparisonMetricsResult
    details: ComparisonPriceDetailsResult[]
  }
  const load = vi.fn(async (input: { side: string; memberSessionId?: string }) => {
    const lane = required(captured.metrics.lanes.find((lane) => lane.side === input.side))
    return required(
      captured.details.find((detail) => detail.sessionId === (input.memberSessionId ?? lane.sessionId)),
    )
  })
  const host = document.createElement('div')
  const view = createComparisonMetrics(host, load)
  view.render(captured.metrics)
  expect(host.textContent).toContain('左：Jev 0 / LLM 9')
  expect(host.textContent).toContain('右：Jev 6 / LLM 7')
  expect(host.textContent).toContain('会话树 2 个已观测成员 · 树覆盖完整')
  const panels = [...host.querySelectorAll<HTMLDetailsElement>('.comparison-price-details')]
  expect(panels).toHaveLength(4)
  expect(load).not.toHaveBeenCalled()
  for (const [index, panel] of panels.entries()) {
    panel.open = true
    panel.dispatchEvent(new Event('toggle'))
    const detail = required(captured.details[index])
    await vi.waitFor(() => expect(panel.querySelectorAll('section')).toHaveLength(detail.entries.length))
    expect(load).toHaveBeenNthCalledWith(
      index + 1,
      expect.objectContaining({
        id: captured.metrics.id,
        side: detail.side,
        atSeq: captured.metrics.atSeq,
        afterSeq: 0,
        ...(index % 2 ? { memberSessionId: detail.sessionId } : {}),
      }),
    )
  }
  expect(captured.details.map((detail) => detail.entries.length)).toEqual([6, 3, 7, 6])
  view.render(structuredClone(captured.metrics))
  expect(host.querySelector('.comparison-price-details')).toBe(panels[0])
  expect(load).toHaveBeenCalledTimes(4)
  view.reset()
})

it.each([
  'valid',
  'current-price',
  'wrong-cut',
  'bad-progress',
  'wrong-session',
  'future-settlement',
] as const)('pages real Flash quote details at one exact cursor (%s)', async (mode) => {
  const captured = JSON.parse(
    readFileSync('packages/jev-web/test/fixtures/comparison-real-price-details.json', 'utf8'),
  ) as {
    reports: {
      sessionId: string
      runtime: ComparisonPriceDetailsResult['runtime']
      throughSeq: number
      entries: ComparisonPriceDetailsResult['entries']
      evidenceComplete: boolean
      issues: string[]
    }[]
  }
  const report = required(captured.reports[1])
  if (mode === 'current-price') {
    const entry = required(report.entries.find((entry) => entry.quote))
    entry.priceBasis = 'current'
    entry.bucketCosts.inputTotal = entry.bucketCosts.inputUncached
  }
  const views = JSON.parse(
    readFileSync('packages/jev-web/test/fixtures/comparison-real-journal-views.json', 'utf8'),
  ) as {
    accounting: { right: Record<string, ComparisonMetricsResult['lanes'][number]['accounting']> }
  }
  const lane = {
    side: 'right' as const,
    sessionId: report.sessionId,
    runtime: report.runtime,
    accounting: { ...required(views.accounting.right['37']), throughSeq: report.throughSeq },
  }
  const value: ComparisonMetricsResult = {
    id: 'priced',
    atSeq: 999,
    cuts: { left: 0, right: report.throughSeq },
    lanes: [lane],
  }
  const load = vi.fn(async (input: { afterSeq?: number }) => {
    const entries = report.entries.filter((entry) => entry.originSeq > (input.afterSeq ?? 0)).slice(0, 2)
    const complete = entries.at(-1)?.originSeq === report.entries.at(-1)?.originSeq
    const result: ComparisonPriceDetailsResult = {
      id: value.id,
      side: lane.side,
      atSeq: value.atSeq,
      sessionId: lane.sessionId,
      runtime: lane.runtime,
      throughSeq: report.throughSeq,
      afterSeq: input.afterSeq ?? 0,
      entries,
      nextAfterSeq: complete ? report.throughSeq : required(entries.at(-1)).originSeq,
      complete,
      evidenceComplete: report.evidenceComplete,
      issues: report.issues,
    }
    if (mode === 'wrong-cut') result.atSeq++
    if (mode === 'wrong-session') result.sessionId = 'replacement'
    if (mode === 'bad-progress') result.nextAfterSeq++
    if (mode === 'future-settlement')
      result.entries = result.entries.map((entry) => ({ ...entry, settledSeq: report.throughSeq + 1 }))
    return result
  })
  const host = document.createElement('div')
  const view = createComparisonPriceDetails(host, value, lane, load)
  const panel = required(host.querySelector('details'))
  expect(panel.open).toBe(false)
  expect(load).not.toHaveBeenCalled()
  panel.open = true
  panel.dispatchEvent(new Event('toggle'))
  if (mode !== 'valid' && mode !== 'current-price') {
    await vi.waitFor(() => expect(host.textContent).toContain('报价详情读取失败'))
    expect(host.querySelectorAll('section')).toHaveLength(0)
  } else {
    await vi.waitFor(() => expect(host.querySelectorAll('section')).toHaveLength(2))
    while (!required(host.querySelector<HTMLButtonElement>('button')).hidden) {
      const count = host.querySelectorAll('section').length
      required(host.querySelector<HTMLButtonElement>('button')).click()
      await vi.waitFor(() => expect(host.querySelectorAll('section').length).toBeGreaterThan(count))
    }
    expect(host.querySelectorAll('section')).toHaveLength(report.entries.length)
    if (mode === 'current-price') {
      expect(host.textContent).toContain('按当前配置重估（未写入历史记录）')
      expect(host.textContent).toContain('总输入')
    }
    expect(host.textContent).toContain('冻结的目录估算')
    expect(host.textContent).toContain('无有效历史报价')
    expect(host.textContent).toContain('已报告估算')
    expect(host.textContent).toContain('未缓存输入 0.15')
    expect(host.textContent).not.toContain('reasoningText')
    expect(load.mock.calls.every(([input]) => (input as { atSeq?: number }).atSeq === 999)).toBe(true)
  }
  view.dispose()
})

it('retains expanded quotes, active reads and loaded data across equivalent fixed-cut metrics refreshes', async () => {
  const captured = JSON.parse(
    readFileSync('packages/jev-web/test/fixtures/comparison-real-price-details.json', 'utf8'),
  ) as {
    reports: {
      sessionId: string
      runtime: ComparisonPriceDetailsResult['runtime']
      throughSeq: number
      entries: ComparisonPriceDetailsResult['entries']
      evidenceComplete: boolean
      issues: string[]
    }[]
  }
  const views = JSON.parse(
    readFileSync('packages/jev-web/test/fixtures/comparison-real-journal-views.json', 'utf8'),
  ) as {
    accounting: { right: Record<string, ComparisonMetricsResult['lanes'][number]['accounting']> }
  }
  const report = required(captured.reports[1])
  let resolve!: (value: ComparisonPriceDetailsResult) => void
  const load = vi.fn(
    () =>
      new Promise<ComparisonPriceDetailsResult>((done) => {
        resolve = done
      }),
  )
  const host = document.createElement('div')
  const metrics = createComparisonMetrics(host, load)
  const lane = {
    side: 'right' as const,
    sessionId: report.sessionId,
    runtime: report.runtime,
    accounting: { ...required(views.accounting.right['37']), throughSeq: report.throughSeq },
  }
  const value = { id: 'saved', atSeq: 80, cuts: { left: 0, right: report.throughSeq }, lanes: [lane] }
  metrics.render(value)
  const outer = required(host.querySelector<HTMLDetailsElement>('.comparison-metrics'))
  outer.open = true
  const quote = required(host.querySelector<HTMLDetailsElement>('.comparison-price-details'))
  quote.open = true
  quote.dispatchEvent(new Event('toggle'))
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
  for (let index = 0; index < 3; index++) {
    metrics.loading(80)
    // Same wire facts with new object identities and a different top-level key insertion order.
    metrics.render({
      lanes: structuredClone(value.lanes),
      cuts: { right: report.throughSeq, left: 0 },
      atSeq: 80,
      id: value.id,
    })
    expect(host.querySelector<HTMLDetailsElement>('.comparison-price-details')?.open).toBe(true)
    expect(host.querySelector('.comparison-metrics > summary')?.textContent).not.toContain('正在同步')
    expect(host.querySelector('.comparison-metrics > [role="status"]')?.textContent).not.toContain('正在同步')
  }
  resolve({
    id: value.id,
    side: lane.side,
    atSeq: 80,
    sessionId: lane.sessionId,
    runtime: lane.runtime,
    throughSeq: report.throughSeq,
    afterSeq: 0,
    entries: report.entries,
    nextAfterSeq: report.throughSeq,
    complete: true,
    evidenceComplete: report.evidenceComplete,
    issues: report.issues,
  })
  await vi.waitFor(() =>
    expect(host.querySelectorAll('.comparison-price-details h5')).toHaveLength(report.entries.length),
  )
  metrics.unavailable('transient refresh failed')
  metrics.render(structuredClone(value))
  expect(host.querySelector<HTMLDetailsElement>('.comparison-price-details')?.open).toBe(true)
  expect(host.querySelectorAll('.comparison-price-details h5')).toHaveLength(report.entries.length)
  expect(host.textContent).toContain('已读完可见请求')
  expect(host.textContent).not.toContain('transient refresh failed')
  expect(load).toHaveBeenCalledOnce()
  metrics.reset()
})

it('does not install late price details after the shared cursor changes', async () => {
  const views = JSON.parse(
    readFileSync('packages/jev-web/test/fixtures/comparison-real-journal-views.json', 'utf8'),
  ) as {
    accounting: { right: Record<string, ComparisonMetricsResult['lanes'][number]['accounting']> }
  }
  let resolve!: (value: ComparisonPriceDetailsResult) => void
  const load = vi.fn(
    () =>
      new Promise<ComparisonPriceDetailsResult>((done) => {
        resolve = done
      }),
  )
  const host = document.createElement('div')
  const metrics = createComparisonMetrics(host, load)
  const lane = {
    side: 'right' as const,
    sessionId: 'r',
    runtime: { id: 'jevloop', version: '1' },
    accounting: required(views.accounting.right['37']),
  }
  const value = { id: 'priced', atSeq: 225, cuts: { left: 24, right: 37 }, lanes: [lane] }
  metrics.render(value)
  const old = required(host.querySelector<HTMLDetailsElement>('.comparison-price-details'))
  old.open = true
  old.dispatchEvent(new Event('toggle'))
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
  metrics.render({ ...value, atSeq: 224 })
  resolve({
    id: value.id,
    side: lane.side,
    atSeq: 225,
    sessionId: lane.sessionId,
    runtime: lane.runtime,
    throughSeq: 37,
    afterSeq: 0,
    entries: [],
    nextAfterSeq: 37,
    complete: true,
    evidenceComplete: true,
    issues: [],
  })
  await Promise.resolve()
  expect(host.querySelector('.comparison-price-details')?.textContent).toContain('展开读取')
  expect(host.textContent).not.toContain('已读完可见请求')
  expect(host.textContent).toContain('准备配置：未知')
  metrics.reset()
})
