import type { ApprovalVerdict, UINode } from '@agnes/protocol'
import { validateAgainst, validateSlotPayload } from '@agnes/protocol'
import { UITimeline } from '@agnes/protocol/gen/agnes-v1'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  await session.acceptInput()
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
    event('turn/end', { reason: 'parked', lastAssistantSeq: null }),
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
    await expect(pending).rejects.toThrow('output disk unavailable')
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
  expect(kind((await session.projectUI()).nodes, 'tool')[0]).toMatchObject({
    status: 'completed',
    argsPreview: '{"path":"a"}',
    resultPreview: 'file',
    enforcement: { level: 'full' },
  })
  const stableHistory = await session.projectUIHistory(historicalCut, opening.startIndex, {
    limit: 100,
    maxBytes: 1024 * 1024,
  })
  expect(kind(stableHistory.nodes, 'tool')[0]?.status).toBe('planned')
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
