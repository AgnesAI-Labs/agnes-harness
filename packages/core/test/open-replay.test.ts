import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { forkBaseProviders } from '../src/log/fork-seed.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { scanPages } from '../src/log/scan-pages.js'
import { SessionLogImpl } from '../src/log/session-log.js'
import type { StorageAdapter } from '../src/log/storage.js'
import { encodeLedgerState } from '../src/project/cache.js'
import { computeSurface } from '../src/project/surface.js'
import { projectUI, UIProjectionCell } from '../src/project/ui.js'
import { openTracked, StateTracker } from '../src/reduce/tracker.js'
import { canonicalJson } from '../src/request/hash.js'
import type { Event, EventInput } from '../src/types.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const base = { actor, origin: 'system', trust: 'trusted' } as const
const noTimers = { setTimeout: () => 0, clearTimeout: () => undefined }
const common = {
  ttlMs: 60_000,
  clock: () => 1_757_203_200_000,
  timers: noTimers,
  relationCheck: () => undefined,
}
const EMOJI = '\u{1F600}'
const usageOpts = {
  route: 'default',
  model: { id: 'm', contextWindow: 1_000_000 },
  thinking: 'high' as const,
  autoCompact: true,
}

const row = (type: string, data: EventInput['data'], extra: Partial<EventInput> = {}): EventInput => ({
  ...base,
  type,
  data,
  ...extra,
})

/** One turn with a tool call whose preview holds astral characters, a parked approval and a cost row. */
function turn(n: number, firstSeq: number): EventInput[] {
  return [
    row('user/message', { content: [{ type: 'text', text: `question ${n}` }] }),
    row('turn/start', { turn: n, trigger: 'prompt' }),
    row('tool/call', {
      toolUseId: `tool-${n}`,
      name: 'read',
      args: { path: EMOJI.repeat(1100) },
      ordinal: 0,
    }),
    row('approval/asked', {
      requestId: `approval-${n}`,
      kind: 'tool',
      summary: 'read',
      risk: 'always',
      bindingHash: 'a'.repeat(64),
      options: ['allowed-once', 'rejected'],
      toolUseId: `tool-${n}`,
      pending: { ticket: `ticket-${n}`, expiresAt: '2026-09-13T00:10:00.000Z' },
    }),
    row('approval/decided', { requestId: `approval-${n}`, verdict: 'allowed-once', via: 'callback' }),
    row('tool/result', {
      toolUseId: `tool-${n}`,
      content: [{ type: 'text', text: EMOJI.repeat(3000) }],
      isError: false,
      enforcement: { level: 'full', scope: ['process'] },
      authz: { decisionId: `decision-${n}` },
    }),
    row('assistant/message', { content: [{ type: 'text', text: `answer ${n}` }], stopReason: 'end_turn' }),
    row('cost/ledger', {
      purpose: 'inference',
      effectId: `inference-${n}`,
      tokens: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0 },
      credits: 1,
      creditSource: 'gateway',
      model: 'm',
    }),
    row('turn/end', { reason: 'completed', lastAssistantSeq: firstSeq + 6 }),
  ]
}

async function allEvents(storage: StorageAdapter, key: string): Promise<Event[]> {
  const out: Event[] = []
  for await (const page of scanPages((q) => storage.scan(key, q), { fromSeq: 1 }, 500)) out.push(...page)
  return out
}

/** A session long enough for several verification pages, closed so the next open is cold. */
async function written(storage: MemoryStorage, key = 'k', turns = 60): Promise<void> {
  const opened = await openTracked({ ...common, storage, key, writerRunId: 'w', ids: defaultIds() })
  for (let n = 1; n <= turns; n++) await opened.log.append(turn(n, opened.log.lastSeq + 1))
  // A compaction that masks the first turn's model-visible rows.
  await opened.log.append([
    row(
      'assistant/message',
      { content: [{ type: 'text', text: 'summary' }], stopReason: 'end_turn' },
      {
        surfaceOp: { op: 'replace', start: 1, end: 8 },
        sourceEventSeqs: [1, 6, 8],
      },
    ),
  ])
  await opened.log.close()
}

/** Counts storage reads a cold open makes. */
function counted(storage: MemoryStorage) {
  const integrity: Array<[number, number]> = []
  let scans = 0
  const wrapped = new Proxy(storage, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function') return value
      if (property === 'scanIntegrity')
        return async (key: string, q: { fromSeq: number; toSeq: number; limit: number }) => {
          const rows = await storage.scanIntegrity(key, q)
          if (!(q.limit === 1 && q.fromSeq === q.toSeq))
            integrity.push([rows[0]?.event.seq ?? 0, rows.at(-1)?.event.seq ?? 0])
          return rows
        }
      if (property === 'scan') {
        return (...args: unknown[]) => {
          scans++
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return (value as (...a: unknown[]) => unknown).bind(target)
    },
  }) as StorageAdapter
  const covered = () =>
    integrity.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from + i))
  return { storage: wrapped, covered, scans: () => scans }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a cold open folds the rows it verifies', () => {
  it('rebuilds the UI projection and surface exactly as a full replay does', async () => {
    const storage = new MemoryStorage()
    await written(storage)
    const events = await allEvents(storage, 'k')
    const opened = await openTracked({ ...common, storage, key: 'k', writerRunId: 'r', ids: defaultIds() })
    const usage = opened.ui.usage(usageOpts)
    expect(await opened.ui.view({ usage })).toEqual(await projectUI(events, { sessionKey: 'k', usage }))
    const fresh = new UIProjectionCell('k', 'main')
    fresh.apply(events)
    fresh.sealReplay()
    const page = { maxNodes: 7, maxBytes: 1024 * 1024, usage }
    expect(await opened.ui.opening(page)).toEqual(await fresh.opening(page))
    expect(opened.surface.nodes()).toEqual(computeSurface(events))
    await opened.log.close()
  })

  it('folds the tracker from the first row and leaves it equal to a full rebuild', async () => {
    const storage = new MemoryStorage()
    await written(storage)
    const applied: number[] = []
    const original = StateTracker.prototype.apply
    vi.spyOn(StateTracker.prototype, 'apply').mockImplementation(function (this: StateTracker, events) {
      applied.push(...events.map((event) => event.seq))
      return original.call(this, events)
    })
    const opened = await openTracked({ ...common, storage, key: 'k', writerRunId: 'r', ids: defaultIds() })
    vi.restoreAllMocks()
    expect(applied).toEqual(Array.from({ length: opened.log.lastSeq }, (_, i) => i + 1))
    const rebuilt = await StateTracker.rebuild(opened.log)
    expect(opened.tracker.state).toEqual(rebuilt.state)
    await opened.log.close()
  })

  it('reads the ledger once: every row verified exactly once and no replay scan', async () => {
    const storage = new MemoryStorage()
    await written(storage)
    const probe = counted(storage)
    const opened = await openTracked({
      ...common,
      storage: probe.storage,
      key: 'k',
      writerRunId: 'r',
      ids: defaultIds(),
    })
    expect(probe.covered()).toEqual(Array.from({ length: opened.log.lastSeq }, (_, i) => i + 1))
    expect(probe.scans()).toBe(0)
    await opened.log.close()
  })

  it('reads a reopened fork child once, parent prefix included', async () => {
    const storage = new MemoryStorage()
    await written(storage, 'parent', 20)
    const parent = await openTracked({
      ...common,
      storage,
      key: 'parent',
      writerRunId: 'p',
      ids: defaultIds(),
    })
    const forked = await parent.log.forkInto(parent.log.lastSeq, 'child', {
      actor,
      agnesVersion: 'test',
      preset: null,
      resolvedProfileHash: null,
      writerRunId: 'c',
      lane: 'main',
    })
    const child = await openTracked({
      ...common,
      storage,
      key: 'child',
      writerRunId: 'c',
      ids: defaultIds(),
      existing: forked,
    })
    await child.log.append(turn(99, child.log.lastSeq + 1))
    await child.log.close()
    await parent.log.close()
    const probe = counted(storage)
    const reopened = await openTracked({
      ...common,
      storage: probe.storage,
      key: 'child',
      writerRunId: 'c2',
      ids: defaultIds(),
    })
    expect(probe.covered()).toEqual(Array.from({ length: reopened.log.lastSeq }, (_, i) => i + 1))
    expect(probe.scans()).toBe(0)
    const events = await allEvents(storage, 'child')
    const usage = reopened.ui.usage(usageOpts)
    expect(await reopened.ui.view({ usage })).toEqual(await projectUI(events, { sessionKey: 'child', usage }))
    await reopened.log.close()
  })

  it('still replays an attached fork opened without a fork point', async () => {
    const storage = new MemoryStorage()
    await written(storage, 'parent', 5)
    const parent = await openTracked({
      ...common,
      storage,
      key: 'parent',
      writerRunId: 'p',
      ids: defaultIds(),
    })
    forkBaseProviders.delete(parent.log)
    const forked = await parent.log.forkInto(parent.log.lastSeq, 'child', {
      actor,
      agnesVersion: 'test',
      preset: null,
      resolvedProfileHash: null,
      writerRunId: 'c',
      lane: 'main',
    })
    const probe = counted(storage)
    const originalScan = storage.scan.bind(storage)
    let scans = 0
    storage.scan = async (key, q) => {
      scans++
      return originalScan(key, q)
    }
    const child = await openTracked({
      ...common,
      storage,
      key: 'child',
      writerRunId: 'c',
      ids: defaultIds(),
      existing: forked,
    })
    expect(scans).toBeGreaterThan(0)
    expect(child.surface.nodes()).toEqual(computeSurface(await allEvents(storage, 'child')))
    void probe
    await child.log.close()
    await parent.log.close()
  })

  it('fails the open when folding a verified page throws: lease released, no renewal timer', async () => {
    const storage = new MemoryStorage()
    await written(storage)
    let calls = 0
    const original = UIProjectionCell.prototype.apply
    vi.spyOn(UIProjectionCell.prototype, 'apply').mockImplementation(function (
      this: UIProjectionCell,
      events,
    ) {
      calls++
      if (calls === 2) throw new TypeError('bad row')
      return original.call(this, events)
    })
    let armed = 0
    const timers = {
      setTimeout: () => {
        armed++
        return 0
      },
      clearTimeout: () => undefined,
    }
    await expect(
      openTracked({ ...common, timers, storage, key: 'k', writerRunId: 'r', ids: defaultIds() }),
    ).rejects.toThrow('bad row')
    expect(armed).toBe(0)
    vi.restoreAllMocks()
    await expect(storage.open('k', { writerRunId: 'other', ttlMs: 60_000 })).resolves.toBeDefined()
  })
})

describe('verification comes before folding', () => {
  it('never hands a replay consumer a row that fails verification', async () => {
    const storage = new MemoryStorage()
    const writer = await SessionLogImpl.open({
      ...common,
      storage,
      key: 'k',
      writerRunId: 'w',
      ids: defaultIds(),
    })
    for (let n = 0; n < 700; n += 100)
      await writer.append(
        Array.from({ length: 100 }, (_, i) =>
          row('user/message', { content: [{ type: 'text', text: `m${n + i}` }] }),
        ),
      )
    await writer.close()
    const tampered = new Proxy(storage, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown
        if (property === 'scanIntegrity')
          return async (key: string, q: { fromSeq: number; toSeq: number; limit: number }) =>
            (await storage.scanIntegrity(key, q)).map((r) =>
              r.event.seq === 600
                ? { ...r, event: { ...r.event, data: { content: [{ type: 'text', text: 'altered' }] } } }
                : r,
            )
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as StorageAdapter
    let highest = 0
    const opening = SessionLogImpl.open({
      ...common,
      storage: tampered,
      key: 'k',
      writerRunId: 'r',
      ids: defaultIds(),
      replay: {
        page: (events) => {
          for (const event of events) {
            if (event.seq === 600) throw new Error('an unverified row reached the replay consumer')
            highest = Math.max(highest, event.seq)
          }
        },
      },
    })
    await expect(opening).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    expect(highest).toBeLessThanOrEqual(500)
  })
})

/** Plain data, so a live cell and a reopened one compare on content rather than object identity. */
const plain = (value: unknown): unknown => JSON.parse(canonicalJson(value))

/** Rows that exercise every part of the fold: both lanes, compaction, a sub-agent tool, a parked approval. */
async function busySession(storage: MemoryStorage, lane: string) {
  const other = lane === 'main' ? 'side' : 'main'
  const live = await openTracked({ ...common, storage, key: 'k', writerRunId: 'w', lane, ids: defaultIds() })
  for (let n = 1; n <= 25; n++) await live.log.append(turn(n, live.log.lastSeq + 1))
  const onLane = (events: EventInput[]) => events.map((event) => ({ ...event, lane }))
  await live.log.append(
    onLane([
      row('user/message', { content: [{ type: 'text', text: 'on this lane' }] }),
      row('assistant/message', { content: [{ type: 'text', text: 'reply' }], stopReason: 'end_turn' }),
    ]),
  )
  const firstOnLane = live.log.lastSeq - 1
  await live.log.append([
    row('user/message', { content: [{ type: 'text', text: 'on the other lane' }] }, { lane: other }),
  ])
  await live.log.append(
    onLane([
      row(
        'assistant/message',
        { content: [{ type: 'text', text: 'summary' }], stopReason: 'end_turn' },
        {
          surfaceOp: { op: 'replace', start: firstOnLane, end: firstOnLane + 1 },
          sourceEventSeqs: [firstOnLane, firstOnLane + 1],
        },
      ),
    ]),
  )
  // A sub-agent tool nested under the tool that spawned it.
  await live.log.append(
    onLane([
      row('tool/call', { toolUseId: 'parent-tool', name: 'subagent_spawn', args: {}, ordinal: 0 }),
      row('effect/intent', {
        effectId: 'parent-effect',
        kind: 'tool',
        tool: { toolUseId: 'parent-tool', name: 'subagent_spawn' },
        replay: 'never',
      }),
      row('tool/call', { toolUseId: 'child-tool', name: 'read', args: {}, ordinal: 0 }),
      row('effect/intent', {
        effectId: 'child-effect',
        parentEffectId: 'parent-effect',
        kind: 'tool',
        tool: { toolUseId: 'child-tool', name: 'read' },
        replay: 'safe',
      }),
    ]),
  )
  // An approval left parked at the head.
  await live.log.append(
    onLane([
      row('tool/call', { toolUseId: 'parked-tool', name: 'read', args: {}, ordinal: 0 }),
      row('approval/asked', {
        requestId: 'parked',
        kind: 'tool',
        summary: 'read',
        risk: 'always',
        bindingHash: 'b'.repeat(64),
        options: ['allowed-once', 'rejected'],
        toolUseId: 'parked-tool',
        pending: { ticket: 'parked-ticket', expiresAt: '2026-09-13T00:10:00.000Z' },
      }),
    ]),
  )
  return live
}

async function snapshot(opened: Awaited<ReturnType<typeof openTracked>>) {
  const usage = opened.ui.usage(usageOpts)
  return {
    view: plain(await opened.ui.view({ usage })),
    opening: plain(await opened.ui.opening({ maxNodes: 9, maxBytes: 1024 * 1024, usage })),
    usage: plain(usage),
    tracker: plain(encodeLedgerState(opened.tracker.state)),
    surface: plain(opened.surface.nodes()),
  }
}

describe('a cold reopen matches the live writer', () => {
  it.each(['main', 'side'])('rebuilds the %s lane exactly as the writer held it', async (lane) => {
    const storage = new MemoryStorage()
    const live = await busySession(storage, lane)
    const tools = (await live.ui.view()).nodes.filter((node) => node.kind === 'tool')
    expect(tools.find((node) => node.toolUseId === 'parent-tool')?.children?.length).toBe(1)
    const expected = await snapshot(live)
    await live.log.close()
    const reopened = await openTracked({
      ...common,
      storage,
      key: 'k',
      writerRunId: 'r',
      lane,
      ids: defaultIds(),
    })
    expect(await snapshot(reopened)).toEqual(expected)
    await reopened.log.close()
  })
})
