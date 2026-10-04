import { readFileSync } from 'node:fs'
import type { ApprovalVerdict, UINode } from '@agnes/protocol'
import { validateAgainst, validateSlotPayload } from '@agnes/protocol'
import { UITimeline } from '@agnes/protocol/gen/agnes-v1'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ParentMessageSources } from '../src/project/parent-message-source.js'
import { projectUI, type SlotFillRunner, UIProjectionCell } from '../src/project/ui.js'
import { ToolRegistry } from '../src/registry/tools.js'
import type { SessionImpl } from '../src/step/session.js'
import type { Event, EventInput } from '../src/types.js'
import { fakeProvider, sentFor, textTurn, toolTurn, usage } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, readTool, shellTool } from './helpers/open-session.js'

const owned: SessionImpl[] = []
afterEach(async () => {
  for (const session of owned.splice(0)) await session.close()
})
async function open(
  over: Parameters<typeof openSession>[0] = { provider: fakeProvider([textTurn('answer')]) },
) {
  const result = await openSession(over)
  owned.push(result.session)
  return result
}
async function input(session: SessionImpl) {
  await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'question' }] })
  const itemId = (session.latest('inbox') as { items: Array<{ itemId: string }> }).items[0]?.itemId
  await session.acceptInput()
  const messages = await session.scan({ type: 'user/message', order: 'desc', limit: 1 })
  expect((messages[0]?.data as { itemId?: string } | undefined)?.itemId).toBe(itemId)
}
const run = (session: SessionImpl) => session.run({ until: 'turn-end', signal: new AbortController().signal })
const kind = <K extends UINode['kind']>(nodes: UINode[], target: K) =>
  nodes.filter((node): node is Extract<UINode, { kind: K }> => node.kind === target)
const row = (type: string, data: EventInput['data'], extra: Partial<EventInput> = {}): EventInput => ({
  type,
  data,
  actor,
  origin: 'system',
  trust: 'trusted',
  ...extra,
})

it('projects empty defaults without invented generation, state or budget', async () => {
  expect(await projectUI([], { sessionKey: 'empty' })).toEqual({
    sessionId: 'empty',
    upto: 0,
    opState: null,
    nodes: [],
    turns: [],
  })
  const { session } = await open()
  const before = session.lastSeq
  const timeline = await session.projectUI()
  expect(timeline).toMatchObject({
    sessionId: 'k',
    upto: before,
    opState: null,
    nodes: [],
    turns: [],
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      context: { tokens: 0, window: 128000, autoCompact: true },
      model: { route: 'default', id: 'default', thinking: 'off' },
    },
  })
  expect(session.lastSeq).toBe(before)
  expect(await session.projectUI(0)).toMatchObject({
    sessionId: 'k',
    upto: 0,
    opState: null,
    nodes: [],
    turns: [],
    usage: { context: { tokens: 0, window: 128000, autoCompact: true } },
  })
  expect(validateAgainst(UITimeline, { ...timeline, generation: 7 }).ok).toBe(true)
})

it('pages through adapter scan caps instead of silently truncating a long session', async () => {
  const { session, storage } = await open({ provider: fakeProvider([]) })
  const scan = storage.scan.bind(storage)
  const cappedScan = vi.spyOn(storage, 'scan').mockImplementation((key, query) =>
    scan(key, {
      ...query,
      limit: Math.min(query.limit ?? 500, 500),
    }),
  )
  const beforeMessages = session.lastSeq
  await session.append(
    Array.from({ length: 1001 }, (_, index) =>
      row('user/message', { content: [{ type: 'text', text: `message ${index + 1}` }] }),
    ),
  )

  const timeline = await session.projectUI()
  expect(timeline.upto).toBe(session.lastSeq)
  expect(kind(timeline.nodes, 'user')).toHaveLength(1001)
  expect(kind(timeline.nodes, 'user').at(-1)?.content).toEqual([{ type: 'text', text: 'message 1001' }])
  // Head reads come from the live cell and never touch storage, no matter how long the ledger is.
  expect(cappedScan).not.toHaveBeenCalled()
  const applied = session.d.ui.diagnostics().applied
  expect(await session.projectUI()).toEqual(timeline)
  expect(session.d.ui.diagnostics().applied).toBe(applied)
  expect(cappedScan).not.toHaveBeenCalled()

  const historicalCut = beforeMessages + 550
  const historical = await session.projectUI(historicalCut)
  expect(historical.upto).toBe(historicalCut)
  expect(kind(historical.nodes, 'user')).toHaveLength(550)
  expect(cappedScan).toHaveBeenCalledTimes(2)
})

it('opens a bounded live tail without cloning through storage and pages a stable historical cut', async () => {
  const { session, storage } = await open({ provider: fakeProvider([]) })
  await session.append(
    Array.from({ length: 1000 }, (_, index) =>
      row('user/message', { content: [{ type: 'text', text: `bounded ${index + 1}` }] }),
    ),
  )
  const scan = vi.spyOn(storage, 'scan')
  const opening = await session.projectUIOpening({ surface: 'tui', maxNodes: 17, maxBytes: 1024 * 1024 })

  expect(opening).toMatchObject({ hasEarlier: true, startIndex: 983, totalNodes: 1000 })
  expect(opening.timeline.upto).toBe(session.lastSeq)
  expect(opening.timeline.nodes).toHaveLength(17)
  expect(kind(opening.timeline.nodes, 'user')[0]?.content).toEqual([{ type: 'text', text: 'bounded 984' }])
  expect(kind(opening.timeline.nodes, 'user').at(-1)?.content).toEqual([
    { type: 'text', text: 'bounded 1000' },
  ])
  expect(scan).not.toHaveBeenCalled()

  const cut = opening.timeline.upto
  await session.append([row('user/message', { content: [{ type: 'text', text: 'after stable cut' }] })])
  const firstHistory = await session.projectUIHistory(cut, opening.startIndex, {
    surface: 'tui',
    limit: 37,
    maxBytes: 1024 * 1024,
  })
  expect(firstHistory).toMatchObject({
    cut,
    hasEarlier: true,
    startIndex: 946,
    totalNodes: 1000,
  })
  expect(firstHistory.nodes).toHaveLength(37)
  expect(JSON.stringify(firstHistory.nodes)).not.toContain('after stable cut')

  const seen = new Set(opening.timeline.nodes.map((node) => node.id))
  let before = opening.startIndex
  while (before > 0) {
    const page = await session.projectUIHistory(cut, before, {
      surface: 'tui',
      limit: 137,
      maxBytes: 1024 * 1024,
    })
    expect(page.totalNodes).toBe(1000)
    for (const node of page.nodes) {
      expect(seen.has(node.id)).toBe(false)
      seen.add(node.id)
    }
    expect(page.startIndex).toBeLessThan(before)
    before = page.startIndex
  }
  expect(seen.size).toBe(1000)
})

it('honors the opening byte budget at node boundaries and reports global patch coordinates', async () => {
  const { session } = await open({ provider: fakeProvider([]) })
  await session.append(
    Array.from({ length: 20 }, (_, index) =>
      row('user/message', { content: [{ type: 'text', text: `${index}:${'x'.repeat(400)}` }] }),
    ),
  )
  const opening = await session.projectUIOpening({ maxNodes: 20, maxBytes: 1_200 })
  expect(opening.timeline.nodes.length).toBeGreaterThan(0)
  expect(opening.timeline.nodes.length).toBeLessThan(20)
  expect(new TextEncoder().encode(JSON.stringify(opening.timeline.nodes)).byteLength).toBeLessThanOrEqual(
    1_200,
  )

  await session.append([row('user/message', { content: [{ type: 'text', text: 'new tail' }] })])
  const update = await session.projectUIPatch(opening.timeline.upto)
  expect(update).toMatchObject({ kind: 'patch', patch: { totalNodes: 21 } })
})

it('keeps a ten-thousand-node opening snapshot at the frozen default tail size', async () => {
  const { session, storage } = await open({ provider: fakeProvider([]) })
  await session.append(
    Array.from({ length: 10_000 }, (_, index) =>
      row('user/message', { content: [{ type: 'text', text: `ten-k ${index + 1}` }] }),
    ),
  )
  const scan = vi.spyOn(storage, 'scan')
  const opening = await session.projectUIOpening({ surface: 'tui' })
  expect(opening).toMatchObject({ hasEarlier: true, startIndex: 9_800, totalNodes: 10_000 })
  expect(opening.timeline.nodes).toHaveLength(200)
  expect(JSON.stringify(opening.timeline.nodes.at(-1))).toContain('ten-k 10000')
  expect(new TextEncoder().encode(JSON.stringify(opening.timeline)).byteLength).toBeLessThan(256 * 1024)
  expect(scan).not.toHaveBeenCalled()
})

it.each(['tui', 'web'] as const)('projects permission-only changes for %s subscribers', async (surface) => {
  const { session, log } = await open({ provider: fakeProvider([]) })
  const baseline = await session.projectUIOpening({ surface })
  expect(baseline.timeline.yolo).toBe(false)
  let after = baseline.timeline.upto
  let notified: ReturnType<SessionImpl['projectUIPatch']> | undefined
  const dispose = log.observeCommitted(['x/core/yolo-switch'], () => {
    notified = session.projectUIPatch(after, undefined, { surface })
  })
  try {
    for (const enabled of [true, false]) {
      const seq = await session.setYolo(enabled, actor)
      expect(notified).toBeDefined()
      expect(await notified).toMatchObject({
        kind: 'patch',
        patch: { from: after, upto: seq, yolo: enabled, changes: [], turnChanges: [] },
      })
      expect((await session.projectUIOpening({ surface })).timeline.yolo).toBe(enabled)
      expect((await session.projectUI(undefined, { surface })).yolo).toBe(enabled)
      expect(
        await session.projectUIPatch(baseline.timeline.upto, baseline.timeline.upto, { surface }),
      ).toMatchObject({
        kind: 'replace',
        timeline: { upto: baseline.timeline.upto, yolo: enabled },
      })
      after = seq
    }
  } finally {
    dispose()
  }
})

it('applies each committed event once and serves a head patch from the bounded cell journal', async () => {
  const { session, storage } = await open({ provider: fakeProvider([]) })
  const baseline = await session.projectUI()
  const scan = vi.spyOn(storage, 'scan')
  const before = session.d.ui.diagnostics().applied
  await session.append([row('user/message', { content: [{ type: 'text', text: 'increment' }] })])
  expect(session.d.ui.diagnostics().applied).toBe(before + 1)

  const update = await session.projectUIPatch(baseline.upto)
  expect(update).toMatchObject({
    kind: 'patch',
    patch: {
      from: baseline.upto,
      upto: session.lastSeq,
      changes: [{ op: 'upsert', index: 0, node: { kind: 'user' } }],
    },
  })
  expect(scan).not.toHaveBeenCalled()
  expect(session.d.ui.diagnostics().applied).toBe(before + 1)
})

it('falls back to an authoritative historical replacement when append races past the requested cut', async () => {
  const { session, storage } = await open({ provider: fakeProvider([]) })
  const baseline = await session.projectUI()
  await session.append([row('user/message', { content: [{ type: 'text', text: 'at cut' }] })])
  const requestedCut = session.lastSeq
  await session.append([row('user/message', { content: [{ type: 'text', text: 'after cut' }] })])
  const scan = vi.spyOn(storage, 'scan')

  const update = await session.projectUIPatch(baseline.upto, requestedCut)
  expect(update.kind).toBe('replace')
  if (update.kind !== 'replace') throw new Error('expected historical replacement')
  expect(update.timeline.upto).toBe(requestedCut)
  expect(JSON.stringify(update.timeline.nodes)).toContain('at cut')
  expect(JSON.stringify(update.timeline.nodes)).not.toContain('after cut')
  expect(scan).toHaveBeenCalledTimes(1)
})

it('bounds the change journal and rejects gaps instead of publishing a plausible delta', async () => {
  const { session } = await open({ provider: fakeProvider([]) })
  await session.append(
    Array.from({ length: 3 }, (_, index) =>
      row('user/message', { content: [{ type: 'text', text: `row ${index + 1}` }] }),
    ),
  )
  const events = await session.scan({ fromSeq: 1, toSeq: session.lastSeq })
  const cell = new UIProjectionCell('k', 'main', { maxEvents: 2, maxBytes: 1024 * 1024 })
  cell.apply(events.slice(0, 1))
  cell.sealReplay()
  cell.apply(events.slice(1))

  expect(cell.diagnostics()).toMatchObject({ floor: events.at(-3)?.seq, entries: 2 })
  expect(cell.journalPatch(events[0]?.seq ?? 0)).toBeNull()
  expect(cell.journalPatch(events.at(-3)?.seq ?? 0)).toMatchObject({
    from: events.at(-3)?.seq,
    upto: events.at(-1)?.seq,
  })
  await expect(cell.view()).resolves.toEqual(await projectUI(events, { sessionKey: 'k' }))

  const gap = { ...events.at(-1), seq: (events.at(-1)?.seq ?? 0) + 2 } as Event
  expect(() => cell.apply([gap])).toThrowError(/non-contiguous ledger/)
})

it('projects a completed real turn once, with original user content, cost and historical state', async () => {
  const { session } = await open()
  await input(session)
  const accepted = session.lastSeq
  expect((await session.projectUI()).opState).toMatchObject({ turn: 1, step: 0, phase: 'checkpoint' })
  await run(session)
  const timeline = await session.projectUI()
  expect(kind(timeline.nodes, 'user')[0]?.content).toEqual([{ type: 'text', text: 'question' }])
  expect(kind(timeline.nodes, 'assistant')).toHaveLength(1)
  expect(kind(timeline.nodes, 'assistant')[0]).toMatchObject({ text: 'answer', streaming: false })
  expect(kind(timeline.nodes, 'cost')[0]).toMatchObject({ credits: 1, source: 'estimated' })
  expect(timeline.opState).toBeNull()
  const historical = await session.projectUI(accepted)
  // A past cut has no program counter of its own, only the open turn it falls inside.
  expect(historical.opState).toMatchObject({ turn: 1, step: 0, phase: 'running' })
  expect(historical.nodes.map((node) => node.kind)).toEqual(['user'])
  expect(historical.upto).toBe(accepted)
  expect(validateAgainst(UITimeline, { ...timeline, generation: 2 }).ok).toBe(true)
})

it('groups approval continuation into one lane-isolated turn with measured cost and final cutoff', async () => {
  let seq = 0
  const event = (type: string, data: Event['data'], extra: Partial<Event> = {}): Event => {
    seq += 1
    return {
      seq,
      ts: new Date(Date.UTC(2026, 8, 13, 0, 0, seq)).toISOString(),
      id: `01K0000000000000000000${String(seq).padStart(4, '0')}`,
      type,
      data,
      actor,
      origin: 'system',
      trust: 'trusted',
      ...extra,
    }
  }
  const events = [
    event('user/message', { content: [{ type: 'text', text: 'do it' }] }),
    event('turn/start', { turn: 1, trigger: 'prompt' }),
    event('tool/call', { toolUseId: 'tool-1', name: 'shell', args: {}, ordinal: 0 }),
    event('approval/asked', {
      requestId: 'approval-1',
      kind: 'tool',
      summary: 'run',
      risk: 'always',
      bindingHash: 'a'.repeat(64),
      options: ['allowed-once', 'allowed-session', 'allowed-permanent', 'rejected'],
      pending: { ticket: 'ticket-1', expiresAt: '2026-09-13T00:10:00.000Z' },
    }),
    event('turn/end', {
      reason: 'parked',
      lastAssistantSeq: null,
      error: { code: 'APPROVAL_PENDING', message: 'Waiting for approval' },
    }),
    event('turn/start', { turn: 1, trigger: 'prompt' }, { lane: 'side' }),
    event('approval/decided', { requestId: 'approval-1', verdict: 'allowed-once', via: 'callback' }),
    event('turn/start', {
      turn: 2,
      trigger: 'approval-resume',
      continues: { turn: 1, step: 1, toolUseId: 'tool-1', requestId: 'approval-1' },
    }),
    event('tool/result', {
      toolUseId: 'tool-1',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      enforcement: { level: 'full', scope: ['process'] },
      authz: { decisionId: 'd1' },
    }),
    event('request/header', { model: 'model-a' }),
    event('assistant/message', {
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
    }),
    event('cost/ledger', {
      purpose: 'inference',
      effectId: 'inference-1',
      tokens: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 3 },
      credits: 1.5,
      creditSource: 'gateway',
      billing: { usdMicros: 25, source: 'gateway', subscription: true },
      model: 'model-a',
      timing: { ttftMs: 4, durationMs: 20 },
    }),
    event('turn/end', { reason: 'completed', lastAssistantSeq: 11 }),
  ]

  const timeline = await projectUI(events, { sessionKey: 'approval-chain', lane: 'main' })
  expect(kind(timeline.nodes, 'approval')[0]?.options).toEqual([
    'allow_once',
    'allow_always',
    'allow_permanent',
    'reject_once',
  ])
  expect(timeline.turns).toHaveLength(1)
  expect(timeline.turns?.[0]?.error).toBeUndefined()
  expect(timeline.turns[0]).toMatchObject({
    id: 'turn:1',
    turn: 1,
    startSeq: 2,
    endSeq: 13,
    status: 'completed',
    reason: 'completed',
    finalModel: 'model-a',
    inherited: false,
    forkable: true,
    usage: {
      totals: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 3 },
      cost: { usdMicros: 25, source: 'gateway', subscription: true },
      credits: { amount: 1.5, source: 'gateway', complete: true },
      reasoningComplete: true,
      billingComplete: true,
    },
  })
})

it('assigns a committed follow-up to the next visible turn while steering stays in the active turn', async () => {
  let seq = 0
  const event = (type: string, data: Event['data']): Event => ({
    seq: ++seq,
    ts: new Date(Date.UTC(2026, 8, 13, 1, 0, seq)).toISOString(),
    id: `01K0000000000000000001${String(seq).padStart(4, '0')}`,
    type,
    data,
    actor,
    origin: 'system',
    trust: 'trusted',
  })
  const events = [
    event('user/message', { content: [{ type: 'text', text: 'first' }] }),
    event('turn/start', { turn: 1, trigger: 'prompt' }),
    event('user/message', { content: [{ type: 'text', text: 'steer current' }] }),
    event('assistant/message', { content: [{ type: 'text', text: 'first answer' }], stopReason: 'end_turn' }),
    event('turn/end', { reason: 'completed', lastAssistantSeq: 4 }),
    event('user/message', { content: [{ type: 'text', text: 'queued follow-up' }] }),
    event('turn/start', { turn: 2, trigger: 'follow_up' }),
    event('assistant/message', {
      content: [{ type: 'text', text: 'second answer' }],
      stopReason: 'end_turn',
    }),
    event('turn/end', { reason: 'completed', lastAssistantSeq: 8 }),
  ]

  const timeline = await projectUI(events, { sessionKey: 'follow-up-ownership', lane: 'main' })
  expect(timeline.turns).toHaveLength(2)
  expect(timeline.turns[0]?.nodeIds).toHaveLength(3)
  expect(timeline.turns[1]?.nodeIds).toHaveLength(2)
  const owner = new Map(timeline.turns.flatMap((turn) => turn.nodeIds.map((id) => [id, turn.id])))
  const steer = timeline.nodes.find(
    (node) => node.kind === 'user' && JSON.stringify(node).includes('steer current'),
  )
  const queued = timeline.nodes.find(
    (node) => node.kind === 'user' && JSON.stringify(node).includes('queued follow-up'),
  )
  expect(steer && owner.get(steer.id)).toBe('turn:1')
  expect(queued && owner.get(queued.id)).toBe('turn:2')
})

it('shows a live partial stream and finalizes it without duplicate assistant content', async () => {
  let release = () => {}
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  const provider = fakeProvider([])
  provider.infer = async function* (req) {
    yield sentFor(req)
    yield { type: 'text_delta', delta: 'partial' }
    yield { type: 'thinking_delta', delta: 'reason' }
    await paused
    yield usage()
    yield { type: 'done', reason: 'stop' }
  }
  const { session } = await open({ provider })
  const seen: string[] = []
  session.onPreview((p) => seen.push(`${p.stream}:${p.delta}`))
  await input(session)
  const pending = session.runInference()
  // Wait for the stream's committed start marker, not a wall-clock guess about provider startup.
  for (let n = 0; n < 100; n++) {
    if ((await session.scan({ type: 'assistant/output', toSeq: session.lastSeq })).length) break
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  try {
    const timeline = await session.projectUI()
    // The node exists while streaming, but its text lives only in the previews a viewer merges in.
    const [streaming] = kind(timeline.nodes, 'assistant')
    expect(streaming).toMatchObject({ text: '', streaming: true })
    expect(typeof streaming?.effectId).toBe('string')
    expect(seen).toContain('text:partial')
  } finally {
    release()
    await pending
  }
  const after = await session.projectUI()
  expect(kind(after.nodes, 'assistant')).toHaveLength(1)
  expect(kind(after.nodes, 'assistant')[0]).toMatchObject({
    text: 'partial',
    thinking: 'reason',
    streaming: false,
  })
})

it('flushes a short first delta immediately and later short deltas while the provider is paused', async () => {
  let releaseFirst = () => {}
  let releaseSecond = () => {}
  const firstPause = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const secondPause = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })
  const provider = fakeProvider([])
  provider.infer = async function* (req) {
    yield sentFor(req)
    yield { type: 'text_delta', delta: '先检查工作目录。' }
    await firstPause
    yield { type: 'text_delta', delta: '再执行受控命令。' }
    await secondPause
    yield usage()
    yield { type: 'done', reason: 'stop' }
  }
  const { session } = await open({ provider })
  const seen: string[] = []
  session.onPreview((p) => seen.push(p.delta))
  await input(session)
  const pending = session.runInference()
  const waitForPreviews = async (count: number): Promise<void> => {
    for (let n = 0; n < 100; n++) {
      if (seen.length >= count) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${count} previews`)
  }

  try {
    await waitForPreviews(1)
    expect(seen).toEqual(['先检查工作目录。'])
    expect(kind((await session.projectUI()).nodes, 'assistant')[0]).toMatchObject({ streaming: true })

    releaseFirst()
    await waitForPreviews(2)
    expect(seen).toEqual(['先检查工作目录。', '再执行受控命令。'])
  } finally {
    releaseFirst()
    releaseSecond()
    await pending
  }

  const after = await session.projectUI()
  expect(kind(after.nodes, 'assistant')).toHaveLength(1)
  expect(kind(after.nodes, 'assistant')[0]).toMatchObject({
    text: '先检查工作目录。再执行受控命令。',
    streaming: false,
  })
})

it('wakes a paused provider when a bounded stream flush fails', async () => {
  let release = () => {}
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  const provider = fakeProvider([])
  provider.infer = async function* (req) {
    yield sentFor(req)
    yield { type: 'text_delta', delta: 'first' }
    yield { type: 'text_delta', delta: 'second' }
    // Deliberately ignore the inference signal. The flush failure must still settle the owner.
    await paused
    yield usage()
    yield { type: 'done', reason: 'stop' }
  }
  // Each clock read is ten seconds on, so the flush that follows the start writes a count row.
  let now = 1_757_203_200_000
  const { session, storage } = await open({ provider, clock: () => (now += 10_000) })
  const commit = storage.commit.bind(storage)
  let outputAppends = 0
  vi.spyOn(storage, 'commit').mockImplementation(async (key, tx) => {
    if (tx.events.some((event) => event.type === 'assistant/output')) {
      outputAppends += 1
      if (outputAppends === 2) throw new Error('output disk unavailable')
    }
    return commit(key, tx)
  })
  await input(session)
  const pending = session.runInference()
  try {
    const error: unknown = await pending.catch((failure: unknown) => failure)
    expect(error).toMatchObject({ code: 'E_STORAGE_FAULT' })
    const messages: string[] = []
    const seen = new Set<unknown>()
    let cause = error
    while (cause instanceof Error && !seen.has(cause)) {
      seen.add(cause)
      messages.push(cause.message)
      cause =
        (cause as Error & { detail?: { cause?: unknown }; cause?: unknown }).detail?.cause ??
        (cause as Error & { cause?: unknown }).cause
    }
    expect(messages).toContain('output disk unavailable')
  } finally {
    release()
  }
  expect(outputAppends).toBe(2)
})

it('settles an inference whose provider ignores cancellation while waiting for its next event', async () => {
  let release = () => {}
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  const provider = fakeProvider([])
  provider.infer = async function* (req) {
    yield sentFor(req)
    yield { type: 'text_delta', delta: 'visible before cancellation' }
    // The iterator intentionally ignores the signal until its external wait ends.
    await paused
    yield usage()
    yield { type: 'done', reason: 'stop' }
  }
  const { session } = await open({ provider })
  await input(session)
  const pending = session.runInference()
  for (let n = 0; n < 100; n++) {
    if ((await session.scan({ type: 'assistant/output', toSeq: session.lastSeq })).length) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  try {
    await session.abort()
    await expect(pending).resolves.toMatchObject({ phase: 'failure_drain' })
  } finally {
    release()
  }
})

it('tool cards follow planned, running and result states at the requested sequence', async () => {
  let release = () => {}
  let started = () => {}
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const registry = new ToolRegistry()
  registry.add(
    readTool(async () => {
      started()
      await pending
      return { content: [{ type: 'text', text: 'file' }] }
    }),
    { source: 'test', trust: 'builtin' },
  )
  const { session } = await open({
    provider: fakeProvider([toolTurn('read', { path: 'a' }), textTurn('done')]),
    registry,
  })
  await input(session)
  await session.runInference()
  const planned = session.lastSeq
  expect(kind((await session.projectUI()).nodes, 'tool')[0]?.status).toBe('planned')
  await session.append([row('user/message', { content: [{ type: 'text', text: 'stable-cut-tail-marker' }] })])
  const historicalCut = session.lastSeq
  const opening = await session.projectUIOpening({ maxNodes: 1, maxBytes: 1024 * 1024 })
  expect(opening.timeline.nodes).toHaveLength(1)
  expect(opening.hasEarlier).toBe(true)
  const phase = session.runToolsPhase()
  await running
  try {
    expect(kind((await session.projectUI()).nodes, 'tool')[0]?.status).toBe('running')
  } finally {
    release()
    await phase
  }
  await run(session)
  const resultSeq = (await session.scan({ type: 'tool/result', toSeq: session.lastSeq }))[0]?.seq
  expect(kind((await session.projectUI()).nodes, 'tool')[0]).toMatchObject({
    status: 'completed',
    resultSeq,
    argsPreview: '{"path":"a"}',
    resultPreview: 'file',
    enforcement: { level: 'full' },
  })
  const stableHistory = await session.projectUIHistory(historicalCut, opening.startIndex, {
    limit: 100,
    maxBytes: 1024 * 1024,
  })
  expect(kind(stableHistory.nodes, 'tool')[0]?.status).toBe('planned')
  expect(kind(stableHistory.nodes, 'tool')[0]?.resultSeq).toBeUndefined()
  expect(JSON.stringify(stableHistory.nodes)).not.toContain('"status":"completed"')
  expect(kind((await session.projectUI(planned)).nodes, 'tool')[0]?.status).toBe('planned')
})

it('cancelled planned tools remain cancelled after close, reopen and resume', async () => {
  const registry = new ToolRegistry()
  registry.add(readTool(), { source: 'test', trust: 'builtin' })
  const provider = fakeProvider([toolTurn('read', {}), textTurn('done')])
  const { session, storage } = await open({ provider, registry })
  await input(session)
  await session.runInference()
  await session.abort()
  expect((await session.projectUI()).opState?.phase).toBe('cancel_requested')
  await session.close()
  const reopened = (await open({ provider, registry, storage })).session
  expect((await reopened.projectUI()).opState?.phase).toBe('cancel_requested')
  await reopened.resume()
  await run(reopened)
  const timeline = await reopened.projectUI()
  expect(kind(timeline.nodes, 'tool')[0]).toMatchObject({
    status: 'cancelled',
    resultPreview: 'cancelled before start',
  })
  expect(timeline.opState).toBeNull()
  await expect(session.projectUI()).rejects.toMatchObject({ code: 'E_CLOSED' })
})

it('preserves a turn error before inference in live patches and through a reopen', async () => {
  const provider = fakeProvider([])
  const { session, storage } = await open({ provider })
  await input(session)
  const baseline = await session.projectUI()
  const error = { code: 'BUDGET_EXCEEDED', message: 'Increase the context budget or reset it to automatic.' }
  await session.endTurn('budget', { error })
  const timeline = await session.projectUI()
  expect(timeline.turns?.at(-1)).toMatchObject({ status: 'failed', reason: 'budget', error })
  expect(await session.projectUIPatch(baseline.upto)).toMatchObject({
    kind: 'patch',
    patch: { turnChanges: [{ op: 'upsert', turn: { error } }] },
  })
  expect(validateAgainst(UITimeline, { ...timeline, generation: 1 }).ok).toBe(true)
  await session.close()
  const reopened = (await open({ provider, storage })).session
  expect((await reopened.projectUI()).turns).toEqual(timeline.turns)
})

it('preserves a failed tool result through a reopen without declaring completion', async () => {
  const registry = new ToolRegistry()
  registry.add(
    readTool(async () => {
      throw new Error('read failed')
    }),
    { source: 'test', trust: 'builtin' },
  )
  const provider = fakeProvider([toolTurn('read', {}), textTurn('failed safely')])
  const { session, storage } = await open({ provider, registry })
  await input(session)
  await run(session)
  expect(kind((await session.projectUI()).nodes, 'tool')[0]?.status).toBe('failed')
  const before = await session.projectUI()
  await session.close()
  const reopened = (await open({ provider, registry, storage })).session
  expect(await reopened.projectUI()).toEqual(before)
})

describe('approval cards', () => {
  it.each(['allowed-once', 'rejected', 'unavailable'] as ApprovalVerdict[])(
    'shows real %s decision and result',
    async (verdict) => {
      const registry = new ToolRegistry()
      registry.add(shellTool(), { source: 'test', trust: 'builtin' })
      const { session } = await open({
        provider: fakeProvider([toolTurn('shell', {}), textTurn('done')]),
        registry,
        seams: fakeSeams({ approval: { ask: async () => verdict } }),
      })
      await input(session)
      await run(session)
      const timeline = await session.projectUI()
      expect(kind(timeline.nodes, 'approval')[0]).toMatchObject({
        state: 'decided',
        decision: { verdict: verdict === 'unavailable' ? 'rejected' : verdict, via: 'sync' },
      })
      expect(kind(timeline.nodes, 'tool')[0]?.status).toBe(
        verdict === 'allowed-once' ? 'completed' : 'failed',
      )
    },
  )
  it('reconstructs parked state despite the op tombstone, then honors only ledger timeout decisions', async () => {
    const registry = new ToolRegistry()
    registry.add(shellTool(), { source: 'test', trust: 'builtin' })
    const { session } = await open({
      provider: fakeProvider([toolTurn('shell', {})]),
      registry,
      seams: fakeSeams({
        approval: { ask: async () => ({ ticket: 'ticket', expiresAt: '2020-01-01T00:00:00Z' }) },
      }),
    })
    await input(session)
    expect((await run(session)).reason).toBe('parked')
    const parkedAt = session.lastSeq
    const timeline = await session.projectUI()
    expect(timeline.opState).toMatchObject({
      phase: 'parked',
      turn: 1,
      step: 1,
      parked: { ticket: 'ticket' },
    })
    expect(kind(timeline.nodes, 'tool')[0]?.status).toBe('awaiting_approval')
    expect(kind(timeline.nodes, 'approval')[0]?.state).toBe('pending')
    const asked = (await session.scan({ type: 'approval/asked', toSeq: session.lastSeq }))[0]
    if (!asked) throw new Error('missing approval request')
    const requestId = (asked.data as { requestId: string }).requestId
    await session.append([
      row('approval/decided', { requestId, verdict: 'rejected', via: 'timeout', ticket: 'ticket' }),
    ])
    expect(kind((await session.projectUI()).nodes, 'approval')[0]?.state).toBe('expired')
    expect((await session.projectUI()).opState).toBeNull()
    expect(kind((await session.projectUI(parkedAt)).nodes, 'approval')[0]?.state).toBe('pending')
  })
})

it('shows original transcript plus compaction marker, unknown cost, artifacts and budget from the cut', async () => {
  const { session } = await open()
  await input(session)
  await session.runInference()
  const surface = session.surface()
  const first = surface[0]?.seq
  const last = surface.at(-1)?.seq
  if (!first || !last) throw new Error('missing source range')
  const cost = {
    purpose: 'inference',
    effectId: 'historic',
    tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
    creditSource: 'estimated',
    model: 'm',
  }
  await session.append([
    row('cost/ledger', cost),
    row(
      'budget.state',
      { slot: 'primary', escalate: false, creditsUsed: 1, creditsCap: 10 },
      { register: 'budget.state' },
    ),
    row(
      'artifact/job',
      { jobId: 'file', status: 'done', ref: { sha256: 'a'.repeat(64), size: 7, mime: 'text/plain' } },
      { register: 'artifact/job' },
    ),
    row(
      'assistant/message',
      { content: [{ type: 'text', text: 'summary' }], stopReason: 'end_turn' },
      { surfaceOp: { op: 'replace', start: first, end: last }, sourceEventSeqs: [first, last] },
    ),
  ])
  const cut = session.lastSeq
  const timeline = await session.projectUI()
  expect(kind(timeline.nodes, 'assistant').map((node) => node.text)).toEqual(['answer'])
  expect(kind(timeline.nodes, 'compaction')[0]).toMatchObject({
    seq: cut,
    range: [first, last],
    summary: 'summary',
  })
  expect(kind(timeline.nodes, 'compaction')[0]).not.toHaveProperty('tokensBefore')
  expect(kind(timeline.nodes, 'cost').at(-1)).not.toHaveProperty('credits')
  expect(kind(timeline.nodes, 'artifact')[0]).toMatchObject({ name: 'file', ref: { size: 7 } })
  expect(timeline.budget?.creditsCap).toBe(10)
  await session.append([row('budget.state', null, { register: 'budget.state' })])
  expect((await session.projectUI()).budget).toBeUndefined()
  expect((await session.projectUI(cut)).budget?.creditsCap).toBe(10)
  expect(validateAgainst(UITimeline, { ...timeline, generation: 1 }).ok).toBe(true)
})

it('rejects invalid bounds and unknown events rather than returning a plausible empty view', async () => {
  await expect(projectUI([], { sessionKey: 's', upto: -1 })).rejects.toMatchObject({ code: 'E_ENVELOPE' })
  await expect(projectUI([{ type: 'bad', seq: 1 } as Event], { sessionKey: 's' })).rejects.toMatchObject({
    code: 'E_UNKNOWN_EVENT',
  })
})

it('fills only supported surface triggers after real results, never pending tool cards', async () => {
  const registry = new ToolRegistry()
  registry.add(readTool(), { source: 'test', trust: 'builtin' })
  const { session } = await open({
    provider: fakeProvider([toolTurn('read', {}), textTurn('done')]),
    registry,
  })
  await input(session)
  await session.runInference()
  const calls: string[] = []
  const fills: SlotFillRunner = async (_surface, trigger) => {
    calls.push(trigger.kind)
    return [
      { slot: 'tool.card.inline', extId: 'test/ext', payload: { title: 'card' } },
      { slot: 'status.line', extId: 'test/ext', payload: { text: 'status', level: 'info' } },
    ]
  }
  await session.projectUI(undefined, { fills })
  expect(calls).toEqual([])
  await session.projectUI(undefined, { surface: 'tui', fills })
  expect(calls).toEqual(['tick'])
  await run(session)
  calls.length = 0
  const timeline = await session.projectUI(undefined, { surface: 'tui', fills })
  expect(calls).toEqual(['tool_result', 'turn_end', 'tick'])
  expect(kind(timeline.nodes, 'tool')[0]?.slots?.[0]?.payload).toEqual({ title: 'card' })
  expect(kind(timeline.nodes, 'slot')).toHaveLength(1)
})

it('isolates lane state and does not let later rows influence an earlier cut', async () => {
  const { session } = await open()
  await input(session)
  const cut = session.lastSeq
  await session.append([
    row(
      'user/message',
      { content: [{ type: 'text', text: 'other lane' }] },
      { lane: 'other', origin: 'principal' },
    ),
  ])
  const timeline = await session.projectUI()
  expect(kind(timeline.nodes, 'user').map((node) => node.content)).toEqual([
    [{ type: 'text', text: 'question' }],
  ])
  expect((await session.projectUI(cut)).upto).toBe(cut)
})

it('slot failures and invalid payloads leave the ledger and valid timeline intact', async () => {
  const { session } = await open()
  await input(session)
  await run(session)
  const before = session.lastSeq
  const base = await session.projectUI()
  const throwing: SlotFillRunner = async () => {
    throw new Error('extension failed')
  }
  expect(await session.projectUI(undefined, { surface: 'web', fills: throwing })).toEqual(base)
  const invalid: SlotFillRunner = async () => [
    { slot: 'status.line', extId: 'test', payload: { text: 'x'.repeat(70000), level: 'info' } },
    { slot: 'notification', extId: 'test', payload: { message: 'bad' } },
    { slot: 'sidebar.action', extId: 'test', payload: { title: 'bad' } },
  ]
  expect(await session.projectUI(undefined, { surface: 'channel', fills: invalid })).toEqual(base)
  expect(session.lastSeq).toBe(before)
})

it('enforces the slot byte cap after schema validation with a valid payload control', async () => {
  const registry = new ToolRegistry()
  registry.add(readTool(), { source: 'test', trust: 'builtin' })
  const { session } = await open({
    provider: fakeProvider([toolTurn('read', {}), textTurn('done')]),
    registry,
  })
  await input(session)
  await run(session)
  const large = {
    title: 'large',
    table: { columns: ['x'], rows: Array.from({ length: 64 }, () => ['界'.repeat(400)]) },
  }
  expect(validateSlotPayload('tool.card.inline', large).ok).toBe(true)
  expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeGreaterThan(65536)
  const fills: SlotFillRunner = async () => [
    { slot: 'tool.card.inline', extId: 'test', payload: large },
    { slot: 'tool.card.inline', extId: 'test', payload: { title: 'small' } },
  ]
  const timeline = await session.projectUI(undefined, { surface: 'tui', fills })
  expect(kind(timeline.nodes, 'tool')[0]?.slots).toHaveLength(1)
  expect(kind(timeline.nodes, 'tool')[0]?.slots?.map((fill) => fill.payload)).toEqual([{ title: 'small' }])
})

it('refuses projection after storage fault and reconstructs the committed prefix after reopening', async () => {
  const { session, storage } = await open()
  await input(session)
  const before = await session.projectUI()
  const failing = vi.spyOn(storage, 'commit').mockRejectedValueOnce(new Error('disk unavailable'))
  await expect(
    session.append([row('user/message', { content: [{ type: 'text', text: 'not committed' }] })]),
  ).rejects.toThrow()
  await expect(session.projectUI()).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
  failing.mockRestore()
  await session.close()
  const reopened = (await open({ storage, provider: fakeProvider([]) })).session
  expect(await reopened.projectUI()).toEqual(before)
})

it('keeps two-turn notifications in source order and same-sequence fills stable', async () => {
  const { session } = await open({ provider: fakeProvider([textTurn('first'), textTurn('second')]) })
  await input(session)
  await run(session)
  await input(session)
  await run(session)
  const turnEnds = await session.scan({ type: 'turn/end', toSeq: session.lastSeq })
  expect(turnEnds).toHaveLength(2)
  const fills: SlotFillRunner = async (_surface, trigger) =>
    trigger.kind === 'turn_end'
      ? [
          { slot: 'notification', extId: 'test/first', payload: { title: 'first fill', body: 'one' } },
          { slot: 'notification', extId: 'test/second', payload: { title: 'second fill', body: 'two' } },
        ]
      : [{ slot: 'status.line', extId: 'test/tick', payload: { text: 'current', level: 'info' } }]
  const timeline = await session.projectUI(undefined, { surface: 'web', fills })
  const slots = kind(timeline.nodes, 'slot')
  expect(slots.map((node) => [node.seq, node.fill.extId])).toEqual([
    [turnEnds[0]?.seq, 'test/first'],
    [turnEnds[0]?.seq, 'test/second'],
    [turnEnds[1]?.seq, 'test/first'],
    [turnEnds[1]?.seq, 'test/second'],
    [session.lastSeq, 'test/tick'],
  ])
  const secondUser = kind(timeline.nodes, 'user')[1]
  if (!secondUser || !slots[0] || !slots[1]) throw new Error('missing projected nodes')
  expect(timeline.nodes.indexOf(slots[0])).toBeLessThan(timeline.nodes.indexOf(secondUser))
  expect(timeline.nodes.indexOf(slots[1])).toBeLessThan(timeline.nodes.indexOf(secondUser))
  expect(timeline.nodes.map((node) => node.seq)).toEqual(
    timeline.nodes.map((node) => node.seq).sort((a, b) => (a ?? 0) - (b ?? 0)),
  )
  expect(timeline.nodes.at(-1)).toBe(slots.at(-1))
})

describe('cache health on the live projection cell', () => {
  const usageOpts = {
    route: 'agnes-api',
    model: { id: 'deepseek-v4-pro', contextWindow: 1_000_000 },
    thinking: 'high' as const,
    autoCompact: true,
  }

  const header = (seq: number, promptPrefixHash: string): Event =>
    ({
      seq,
      ts: '2026-09-14T00:00:00.000Z',
      id: `01K00000000000000000000${String(seq).padStart(2, '0')}`,
      type: 'request/header',
      data: {
        derived_hash: 'd',
        prompt_prefix_hash: promptPrefixHash,
        tool_schema_hash: 't',
        parser_version: '1',
        contract_id: null,
        model: 'deepseek-v4-pro',
        envelopeNonce: 'n',
      },
      actor: { id: 'system', org: 'local', role: 'system', deptPath: [], attrs: {} },
      origin: 'system',
      trust: 'trusted',
      lane: 'main',
      v: 1,
    }) as Event

  const inferenceRow = (
    seq: number,
    effectId: string,
    tokens: { input: number; cacheRead: number; cacheWrite: number },
  ): Event =>
    ({
      seq,
      ts: '2026-09-14T00:00:00.000Z',
      id: `01K00000000000000000000${String(seq).padStart(2, '0')}`,
      type: 'cost/ledger',
      data: {
        purpose: 'inference',
        effectId,
        tokens: { ...tokens, output: 1 },
        creditSource: 'gateway',
        model: 'deepseek-v4-pro',
      },
      actor: { id: 'system', org: 'local', role: 'system', deptPath: [], attrs: {} },
      origin: 'system',
      trust: 'trusted',
      lane: 'main',
      v: 1,
    }) as Event

  it('reports a cumulative hit rate as inference rows are applied one at a time', () => {
    const cell = new UIProjectionCell('k', 'main', { maxEvents: 2, maxBytes: 1024 * 1024 })
    cell.apply([
      header(1, 'h1'),
      inferenceRow(2, 'e1', { input: 500, cacheRead: 9000, cacheWrite: 0 }),
      header(3, 'h1'),
      inferenceRow(4, 'e2', { input: 9500, cacheRead: 0, cacheWrite: 0 }),
    ])
    expect(cell.usage(usageOpts).cache?.hitRate).toBeCloseTo(9000 / 19000)
    expect(cell.usage(usageOpts).cache?.lastInvalidation).toMatchObject({ cause: 'history-changed' })
  })

  it('keeps guardian cost in totals without replacing the live context anchor', () => {
    const cell = new UIProjectionCell('k', 'main', { maxEvents: 2, maxBytes: 1024 * 1024 })
    const guardian = inferenceRow(2, 'guardian-1', { input: 1024, cacheRead: 0, cacheWrite: 0 })
    guardian.data = { ...(guardian.data as object), purpose: 'approval-guardian', credits: 0.5 }
    cell.apply([inferenceRow(1, 'inference-1', { input: 10, cacheRead: 3, cacheWrite: 4 }), guardian])
    expect(cell.usage(usageOpts)).toMatchObject({
      totals: { input: 1034, output: 2, cacheRead: 3, cacheWrite: 4 },
      credits: { amount: 0.5 },
      context: { tokens: 18 },
    })
  })

  it('keeps auxiliary media cost in totals without replacing the live context anchor', () => {
    const cell = new UIProjectionCell('k', 'main', { maxEvents: 2, maxBytes: 1024 * 1024 })
    const media = inferenceRow(2, 'media-1', { input: 2048, cacheRead: 0, cacheWrite: 0 })
    media.data = { ...(media.data as object), purpose: 'media', credits: 0.75 }
    cell.apply([inferenceRow(1, 'inference-1', { input: 10, cacheRead: 3, cacheWrite: 4 }), media])
    expect(cell.usage(usageOpts)).toMatchObject({
      totals: { input: 2058, output: 2, cacheRead: 3, cacheWrite: 4 },
      credits: { amount: 0.75 },
      context: { tokens: 18 },
    })
  })
})

describe('context-sections and contribute-conflict projection', () => {
  it('projects a context-breakdown diagnostic into a context-sections node', async () => {
    const cell = new UIProjectionCell('k', 'main')
    const event: Event = {
      seq: 1,
      ts: '2026-09-14T00:00:00.000Z',
      id: '01K000000000000000000001',
      type: 'x/core/context-breakdown',
      data: { sections: [{ id: 'core:untrusted-envelope', order: 0, source: 'core', tokens: 378 }] },
      actor: { id: 'system', org: 'local', role: 'system', deptPath: [], attrs: {} },
      origin: 'system',
      trust: 'trusted',
      lane: 'main',
      v: 1,
      ignorable: true,
    } as Event
    cell.apply([event])
    const { nodes } = await cell.view()
    expect(nodes).toContainEqual({
      kind: 'context-sections',
      id: '01K000000000000000000001',
      seq: 1,
      sections: [{ id: 'core:untrusted-envelope', order: 0, source: 'core', tokens: 378 }],
    })
  })

  it('projects a contribute-conflict diagnostic into a contribute-conflict node', async () => {
    const cell = new UIProjectionCell('k', 'main')
    const event: Event = {
      seq: 1,
      ts: '2026-09-14T00:00:00.000Z',
      id: '01K000000000000000000002',
      type: 'x/core/contribute-conflict',
      data: { key: 'tools:sdk', ops: ['code-mode', 'skills'] },
      actor: { id: 'system', org: 'local', role: 'system', deptPath: [], attrs: {} },
      origin: 'system',
      trust: 'trusted',
      lane: 'main',
      v: 1,
      ignorable: true,
    } as Event
    cell.apply([event])
    const { nodes } = await cell.view()
    expect(nodes).toContainEqual({
      kind: 'contribute-conflict',
      id: '01K000000000000000000002',
      seq: 1,
      key: 'tools:sdk',
      ops: ['code-mode', 'skills'],
    })
  })
})

describe('runtime-context user/message projection', () => {
  it('projects a runtime_context user/message to a context node, not a user node', async () => {
    const cell = new UIProjectionCell('k', 'main')
    const event: Event = {
      seq: 1,
      ts: '2026-09-14T00:00:00.000Z',
      id: '01K000000000000000000003',
      type: 'user/message',
      data: { content: [{ type: 'text', text: '{"model":"x","cwd":"/repo"}' }], kind: 'runtime_context' },
      actor: { id: 'system', org: 'local', role: 'system', deptPath: [], attrs: {} },
      origin: 'system',
      trust: 'trusted',
      lane: 'main',
      v: 1,
      ignorable: true,
    } as Event
    cell.apply([event])
    const { nodes } = await cell.view()
    expect(nodes).toContainEqual({
      kind: 'context',
      id: '01K000000000000000000003',
      seq: 1,
      text: '{"model":"x","cwd":"/repo"}',
    })
    expect(kind(nodes, 'user')).toHaveLength(0)
  })

  it('still projects a genuine user message (no data.kind) to a user node', async () => {
    const cell = new UIProjectionCell('k', 'main')
    const event: Event = {
      seq: 1,
      ts: '2026-09-14T00:00:00.000Z',
      id: '01K000000000000000000004',
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'hello' }] },
      actor: { id: 'operator', org: 'local', role: 'user', deptPath: [], attrs: {} },
      origin: 'system',
      trust: 'trusted',
      lane: 'main',
      v: 1,
      ignorable: true,
    } as Event
    cell.apply([event])
    const { nodes } = await cell.view()
    expect(nodes).toContainEqual({
      kind: 'user',
      id: '01K000000000000000000004',
      seq: 1,
      content: [{ type: 'text', text: 'hello' }],
      actorLabel: 'operator',
    })
    expect(kind(nodes, 'context')).toHaveLength(0)
  })

  it('still projects a user message with an unrelated data.kind (e.g. "prompt") to a user node', async () => {
    const cell = new UIProjectionCell('k', 'main')
    const event: Event = {
      seq: 1,
      ts: '2026-09-14T00:00:00.000Z',
      id: '01K000000000000000000005',
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'hello again' }], kind: 'prompt' },
      actor: { id: 'operator', org: 'local', role: 'user', deptPath: [], attrs: {} },
      origin: 'system',
      trust: 'trusted',
      lane: 'main',
      v: 1,
      ignorable: true,
    } as Event
    cell.apply([event])
    const { nodes } = await cell.view()
    expect(nodes).toContainEqual({
      kind: 'user',
      id: '01K000000000000000000005',
      seq: 1,
      content: [{ type: 'text', text: 'hello again' }],
      actorLabel: 'operator',
    })
    expect(kind(nodes, 'context')).toHaveLength(0)
  })
})

it('replays the observed Jev and Flash read/write/read run without promoting its answer to verification', async () => {
  const capture = JSON.parse(readFileSync(new URL('./fixtures/jev-real-trace.json', import.meta.url), 'utf8'))
  const events = capture.events as Event[]
  const options = { sessionKey: 'agnes:jev-real-fixture' }
  const replay = await projectUI(events, options)
  const cell = new UIProjectionCell(options.sessionKey)
  cell.sealReplay()
  for (const event of events) cell.apply([event])
  expect(await cell.view()).toEqual(replay)
  const work = kind(replay.nodes, 'runtime')
  expect(work.filter((node) => node.purpose === 'decision')).toHaveLength(4)
  expect(work.filter((node) => node.purpose === 'parameters')).toHaveLength(3)
  expect(work.find((node) => node.purpose === 'answer')?.model).toBe('deepseek-v4-flash')
  expect(work.filter((node) => node.category === 'action').map((node) => node.status)).toEqual([
    'completed',
    'completed',
    'completed',
  ])
  const tools = kind(replay.nodes, 'tool')
  expect(tools.map((node) => node.name)).toEqual(['read', 'write', 'read'])
  expect(kind(replay.nodes, 'assistant')).toHaveLength(1)
  expect(work.every((node) => replay.turns[0]?.nodeIds.includes(node.id))).toBe(true)
  // The model claimed equality, but the captured bytes disagree. A completed turn is not a verifier.
  expect(capture.observedFiles.exactCopy).toBe(false)
  expect(capture.observedFiles.copy).toBe(capture.observedFiles.source.slice(0, -1))
  const write = events.find(
    (event) => event.type === 'tool/call' && (event.data as { name?: string } | null)?.name === 'write',
  )!
  expect((write.data as { args: { content: string } }).args.content).toBe(capture.observedFiles.copy)
  const prefix = await projectUI(events, { ...options, upto: write.seq - 1 })
  expect(kind(prefix.nodes, 'assistant')).toHaveLength(0)
  expect(kind(prefix.nodes, 'runtime').find((node) => node.title === '动作准备 · write')?.status).toBe(
    'waiting',
  )
})

it('adopts a generic durable output anchor from real answer evidence only with its live same-turn source', async () => {
  const acceptedCapture = JSON.parse(
    readFileSync(new URL('./fixtures/jev-real-answer-accepted.json', import.meta.url), 'utf8'),
  ) as { sessionId: string; events: Event[] }
  const actualAnchor = acceptedCapture.events.find((event) => event.type === 'assistant/output')
  if (!actualAnchor) throw new Error('Missing actual accepted-answer anchor')
  const actualCell = new UIProjectionCell(acceptedCapture.sessionId)
  actualCell.sealReplay()
  actualCell.apply(acceptedCapture.events.filter((event) => event.seq <= actualAnchor.seq))
  expect(kind((await actualCell.view()).nodes, 'assistant')).toMatchObject([
    { id: actualAnchor.id, streaming: true, text: '' },
  ])
  actualCell.apply(acceptedCapture.events.filter((event) => event.seq > actualAnchor.seq))
  const actualFinal = await actualCell.view()
  expect(kind(actualFinal.nodes, 'assistant')).toMatchObject([{ id: actualAnchor.id, streaming: false }])
  expect(kind(actualFinal.nodes, 'assistant')).toHaveLength(1)
  expect(actualFinal).toEqual(
    await projectUI(acceptedCapture.events, { sessionKey: acceptedCapture.sessionId }),
  )
  const capture = JSON.parse(
    readFileSync(new URL('./fixtures/jev-real-answer-preview.json', import.meta.url), 'utf8'),
  ) as { sessionId: string; events: Event[] }
  const requested = capture.events.find((event) => event.seq === 47)
  const originalMessage = capture.events.find((event) => event.type === 'assistant/message')
  if (!requested || !originalMessage) throw new Error('Missing real answer request/message')
  const source = 48
  const effectId = 'portable-answer-owner'
  const anchor: Event = {
    ...requested,
    seq: source as Event['seq'],
    type: 'assistant/output',
    sourceEventSeqs: [47],
    data: { state: 'started', effectId, chars: { text: 0, thinking: 0 }, estimatedTokens: 0 },
  } as Event
  const prefix = [...capture.events.filter((event) => event.seq <= 47), anchor]
  const options = { sessionKey: capture.sessionId }
  for (const constraint of ['accepted', 'ended', 'other-turn', 'other-lane'] as const) {
    const cell = new UIProjectionCell(capture.sessionId)
    cell.sealReplay()
    cell.apply(prefix)
    expect(kind((await cell.view()).nodes, 'assistant')).toMatchObject([
      { text: '', streaming: true, effectId },
    ])
    const middle: Event[] =
      constraint === 'other-turn'
        ? [
            { ...anchor, seq: 49 as Event['seq'], type: 'step/end', data: { turn: 1, step: 2 } } as Event,
            {
              ...anchor,
              seq: 50 as Event['seq'],
              type: 'turn/end',
              data: { reason: 'completed', lastAssistantSeq: null },
            } as Event,
            {
              ...anchor,
              seq: 51 as Event['seq'],
              type: 'turn/start',
              data: { turn: 2, trigger: 'prompt' },
            } as Event,
          ]
        : constraint === 'ended'
          ? [
              {
                ...anchor,
                seq: 49 as Event['seq'],
                data: {
                  state: 'interrupted',
                  effectId,
                  chars: { text: 0, thinking: 0 },
                  estimatedTokens: 0,
                  content: [],
                },
              } as Event,
            ]
          : [{ ...capture.events[47], seq: 49 as Event['seq'] } as Event]
    const adopted: Event = {
      ...originalMessage,
      seq: (constraint === 'other-turn' ? 52 : 50) as Event['seq'],
      lane: constraint === 'other-lane' ? 'foreign' : 'main',
      sourceEventSeqs: [49, source],
    } as Event
    const events = [...prefix, ...middle, adopted]
    cell.apply([...middle, adopted])
    const nodes = kind((await cell.view()).nodes, 'assistant')
    if (constraint === 'accepted') {
      expect(nodes).toHaveLength(1)
      expect(nodes[0]).toMatchObject({
        id: anchor.id,
        streaming: false,
        text: (originalMessage.data as { content: { text: string }[] }).content
          .map((block) => block.text)
          .join(''),
      })
    } else if (constraint === 'ended') {
      expect(nodes).toHaveLength(2)
      expect(nodes[0]).toMatchObject({ text: '', streaming: false })
    } else {
      expect(nodes[0]).toMatchObject({ text: '', streaming: true })
    }
    expect(await cell.view()).toEqual(await projectUI(events, options))
  }
})

it('projects runtime work once across live patches, replay, trace association and history pages', async () => {
  const runtime = { id: 'jevloop', version: '1' }
  const records: EventInput[] = []
  const work = (record: Record<string, unknown>) =>
    row('runtime/record', {
      runtime,
      record: { version: 1, turn: 'run-1', step: 'step-1', ...record },
    } as EventInput['data'])
  records.push(
    row('user/message', { content: [{ type: 'text', text: 'inspect' }] }),
    row('turn/start', { turn: 1, trigger: 'prompt' }),
    row('step/start', { step: 1 }),
    work({
      id: 'request-1',
      kind: 'model.requested',
      call: { purpose: 'decision', requestedModel: 'decision-model', input: { question: 'next operation' } },
    }),
    work({
      id: 'settled-1',
      kind: 'model.settled',
      requested: 'request-1',
      settlement: { output: { scores: { INSPECT: 0.9 } }, usage: { input: 12 } },
    }),
    work({
      id: 'decision-1',
      kind: 'decision.selected',
      requested: 'request-1',
      phase: 'INSPECT',
      operation: 'read',
      confidence: 0.9,
      source: 'jev',
    }),
    work({
      id: 'intent-record',
      kind: 'action.intended',
      decision: 'decision-1',
      intent: { id: 'intent-1', tool: 'read', arguments: { path: 'README.md' }, effectClass: 'read' },
    }),
    work({ id: 'dispatch', kind: 'action.dispatching', intentId: 'intent-1', epoch: 'env' }),
    row('tool/call', { toolUseId: 'intent-1', name: 'read', args: { path: 'README.md' }, ordinal: 0 }),
    work({
      id: 'action-done',
      kind: 'action.settled',
      intentId: 'intent-1',
      outcome: { kind: 'success', content: [{ kind: 'text', text: 'ordinary-tool-result' }] },
      effect: 'none',
    }),
    row('tool/result', {
      toolUseId: 'intent-1',
      content: [{ type: 'text', text: 'ordinary-tool-result' }],
      isError: false,
    }),
    work({
      id: 'answer-request',
      kind: 'model.requested',
      call: {
        purpose: 'answer',
        requestedModel: 'language-model',
        input: { content: 'answer-input-not-duplicated' },
      },
    }),
    work({
      id: 'answer-done',
      kind: 'model.settled',
      requested: 'answer-request',
      settlement: { output: { content: 'final-answer' }, observedModel: 'language-model' },
    }),
    row('assistant/message', { content: [{ type: 'text', text: 'final-answer' }] }),
    work({
      id: 'stop',
      kind: 'run.stopped',
      reason: 'completed',
      detail: 'not a second answer',
      unresolved: [],
    }),
    row('step/end', {}),
    row('turn/end', { reason: 'completed', lastAssistantSeq: 14 }),
  )
  const events: Event[] = records.map((record, index) => ({
    ...record,
    seq: index + 1,
    id: `runtime-test-${index}`,
    ts: new Date(1000 * index).toISOString(),
  }))
  const cell = new UIProjectionCell('runtime-session')
  cell.apply(events.slice(0, 4))
  cell.sealReplay()
  const before = await cell.view()
  const initial = kind(before.nodes, 'runtime')[0]
  if (!initial) throw new Error('missing runtime request')
  expect(initial).toMatchObject({ id: 'runtime:4', status: 'running', requestId: 'request-1' })
  cell.apply(events.slice(4))
  const live = await cell.view()
  expect(live).toEqual(await projectUI(events, { sessionKey: 'runtime-session' }))
  const nodes = kind(live.nodes, 'runtime')
  expect(nodes).toHaveLength(4)
  expect(nodes[0]).toMatchObject({
    id: initial.id,
    seq: 4,
    lastSeq: 6,
    status: 'completed',
    category: 'model',
  })
  expect(nodes[0]?.summary).toContain('INSPECT → read')
  expect(nodes[0]?.detail).toContain('scores')
  expect(nodes[0]?.detail).toContain('采用路径')
  expect(nodes.at(-1)?.detail).toContain('not a second answer')
  expect(JSON.stringify(nodes)).not.toContain('ordinary-tool-result')
  expect(JSON.stringify(nodes)).not.toContain('final-answer')
  expect(JSON.stringify(nodes)).not.toContain('answer-input-not-duplicated')
  expect(kind(live.nodes, 'assistant')).toHaveLength(1)
  expect(kind(live.nodes, 'tool')).toHaveLength(1)
  expect(live.turns[0]?.nodeIds).toEqual(expect.arrayContaining(nodes.map((node) => node.id)))
  const spans = live.turns[0]?.trace?.children.flatMap((step) => step.children) ?? []
  expect(spans.filter((span) => span.kind === 'runtime')).toHaveLength(4)
  expect(spans.find((span) => span.requestId === 'request-1')).toMatchObject({
    runtime,
    nodeIds: [initial.id],
    status: 'completed',
  })
  const patch = cell.journalPatch(4)
  if (!patch) throw new Error('missing live patch')
  expect(patch.changes).toContainEqual(expect.objectContaining({ op: 'upsert', index: 1, node: nodes[0] }))
  const opening = await cell.opening({ maxNodes: 2, maxBytes: 100_000 })
  const earlier = cell.history(cell.upto, opening.startIndex, 100, 100_000)
  expect([...earlier.nodes, ...opening.timeline.nodes]).toEqual(live.nodes)
  expect(earlier.turns[0]?.nodeIds).toContain(initial.id)
  const checked = validateAgainst(UITimeline, { ...live, generation: 1 })
  expect(checked.ok ? [] : checked.errors).toEqual([])
})

it('keeps uncertain runtime effects explicit and associates late resolution with its original turn', async () => {
  const runtime = { id: 'jevloop', version: '1' }
  const inputs = [
    row('turn/start', { turn: 1, trigger: 'prompt' }),
    row('runtime/record', {
      runtime,
      record: {
        version: 1,
        id: 'intent',
        turn: 'run',
        kind: 'action.intended',
        intent: { id: 'action', tool: 'write', arguments: {} },
      },
    }),
    row('runtime/record', {
      runtime,
      record: {
        version: 1,
        id: 'settled',
        turn: 'run',
        kind: 'action.settled',
        intentId: 'action',
        effect: 'unknown',
        outcome: {
          kind: 'error',
          error: { code: 'WRITE_UNKNOWN', message: 'Connection lost after dispatch' },
        },
      },
    }),
    row('turn/end', { reason: 'blocked', lastAssistantSeq: null }),
  ]
  const events: Event[] = inputs.map((input, index) => ({
    ...input,
    seq: index + 1,
    id: `uncertain-${index}`,
    ts: new Date(index * 1000).toISOString(),
  }))
  const uncertain = await projectUI(events, { sessionKey: 'uncertain' })
  expect(kind(uncertain.nodes, 'runtime')[0]?.status).toBe('unknown')
  expect(kind(uncertain.nodes, 'runtime')[0]?.detail).toContain('Connection lost after dispatch')
  expect(uncertain.turns[0]?.trace?.children[0]?.children[0]?.status).toBe('unknown')
  events.push({
    ...row('runtime/record', {
      runtime,
      record: {
        version: 1,
        id: 'resolved',
        turn: 'run',
        kind: 'action.resolved',
        intentId: 'action',
        resolution: 'confirmed_not_applied',
        evidence: ['checked'],
      },
    }),
    seq: 5,
    id: 'resolution',
    ts: new Date(5000).toISOString(),
  })
  const resolved = await projectUI(events, { sessionKey: 'uncertain' })
  expect(kind(resolved.nodes, 'runtime')).toHaveLength(1)
  expect(kind(resolved.nodes, 'runtime')[0]).toMatchObject({
    id: 'runtime:2',
    lastSeq: 5,
    status: 'cancelled',
  })
  expect(resolved.turns[0]?.trace?.children[0]?.children).toHaveLength(1)
  expect(resolved.turns[0]?.trace?.children[0]?.children[0]?.status).toBe('cancelled')
  expect(resolved.turns[0]?.trace?.children[0]?.children[0]?.name).toBe(
    '动作准备 · write · 动作核验：confirmed_not_applied',
  )
})

const parentReports = JSON.parse(
  readFileSync(new URL('./fixtures/child-parent-message-real.json', import.meta.url), 'utf8'),
) as {
  cases: Array<{ runtime: string; parentSessionId: string; events: Event[] }>
}

it.each(parentReports.cases)(
  'projects actual $runtime parent reports by receipt and inbox identity at a fixed prefix',
  async ({ parentSessionId, events }) => {
    // The capture intentionally omits unrelated request/output rows. These explicit test-only
    // ignorable placeholders maintain original coordinates without inventing runtime facts.
    const cell = new UIProjectionCell(parentSessionId, 'main')
    const first = events[0] as Event
    cell.startAfter(first.seq - 1)
    const actual = new Map(events.map((event) => [event.seq, event]))
    const message = events.at(-1) as Event
    for (let seq = first.seq; seq < message.seq; seq++)
      cell.apply([
        actual.get(seq) ?? {
          ...first,
          seq,
          id: `omitted:${seq}`,
          type: 'x/test/omitted',
          ignorable: true,
          data: {},
        },
      ])
    expect((await cell.view()).nodes.some((node) => node.seq === message.seq)).toBe(false)
    cell.apply([message])
    const projected = await cell.view()
    const node = projected.nodes.find((value) => value.seq === message.seq)
    const receipt = events[1] as Event
    const data = receipt.data as {
      kind: 'agent-message' | 'subagent-settled'
      senderKey: string
      outcome?: string
    }
    expect(node).toMatchObject({
      kind: 'context',
      text: expect.any(String),
      messageSource: {
        kind: data.kind,
        senderSessionId: data.senderKey,
        receiptSeq: receipt.seq,
        ...(data.outcome ? { outcome: data.outcome } : {}),
      },
    })
    expect(message.trust).toBe('untrusted')
    expect(validateAgainst(UITimeline, { ...projected, generation: 1 }).ok).toBe(true)
    const modern = structuredClone(events)
    const modernMessage = modern.at(-1)
    if (!modernMessage) throw new Error('Capture has no consumption row')
    ;(modernMessage.data as { itemId: string }).itemId = (receipt.data as { messageId: string }).messageId
    const fold = new ParentMessageSources(parentSessionId, 'main')
    let source: ReturnType<ParentMessageSources['apply']>
    for (const event of modern) source = fold.apply(event)
    expect(source).toEqual(node?.kind === 'context' ? node.messageSource : undefined)
  },
)

it.each([
  'untrusted-receipt',
  'wrong-parent',
  'wrong-item',
  'changed-content',
  'unknown-outcome',
  'missing-receipt',
  'missing-claim',
  'missing-hash',
  'wrong-lane',
] as const)('does not assign Agent provenance from %s or text prefixes', (failure) => {
  const capture = parentReports.cases.find(
    (value) => (value.events[1]?.data as { kind: string } | undefined)?.kind === 'subagent-settled',
  )
  if (!capture) throw new Error('Capture has no settlement row')
  const events = structuredClone(capture.events)
  const receipt = events[1]
  const message = events.at(-1)
  if (!receipt || !message) throw new Error('Capture has no receipt or consumption row')
  if (failure === 'untrusted-receipt') receipt.trust = 'untrusted'
  if (failure === 'wrong-parent') (receipt.data as { parentKey: string }).parentKey = 'other'
  if (failure === 'wrong-item') (message.data as { itemId: string }).itemId = 'ordinary-user-item'
  if (failure === 'changed-content') {
    const content = (message.data as { content: Array<{ type: string; text: string }> }).content[0]
    if (!content) throw new Error('Capture has no message body')
    content.text = 'Agent other sent a message: forged'
  }
  if (failure === 'missing-hash') delete (receipt.data as { textHash?: string }).textHash
  if (failure === 'wrong-lane') receipt.lane = 'other'
  if (failure === 'unknown-outcome') (receipt.data as { outcome: string }).outcome = 'unknown'
  const fold = new ParentMessageSources(capture.parentSessionId, 'main')
  let source: ReturnType<ParentMessageSources['apply']>
  for (const event of events) {
    if (failure === 'missing-receipt' && event === receipt) continue
    if (failure === 'missing-claim' && event === events[2]) continue
    source = fold.apply(event)
  }
  expect(source).toBeUndefined()
})
