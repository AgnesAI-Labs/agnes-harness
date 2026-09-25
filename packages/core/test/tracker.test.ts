import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import type { EventInput, StorageAdapter } from '../src/index.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { initialState } from '../src/reduce/reducer.js'
import { effectTree } from '../src/reduce/state.js'
import {
  openTracked,
  REGISTER_NAMES,
  registerRows,
  StateTracker,
  verifyRegisters,
} from '../src/reduce/tracker.js'
import { canonicalJson } from '../src/request/hash.js'
import { encodeLedgerState } from '../testkit/encode-ledger-state.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const noTimers = { setTimeout: () => 0, clearTimeout: () => undefined }
const base = { actor, origin: 'system', trust: 'trusted' } as const
// Every batch has to satisfy the batch-end rule "an open turn on a lane iff an op.state cell on it",
// so a batch that opens a turn writes the program counter too. The counter is a cell, not a row: the
// batch carries a neutral row where the old row stood, so seqs stay where they were.
const opData = {
  meta: {
    turn: 1,
    lane: 'main',
    acceptedAt: 't',
    triggerSeq: 1,
    presetName: 'standard',
    profileHash: null,
    depthLimit: 1,
  },
  control: { status: 'running' as const },
  step: 0,
  latestAssistantSeq: null,
  taint: false,
  phase: { kind: 'checkpoint' as const, continuation: 'need_assistant' as const, triggerSeq: 1 },
}
const running = { opState: { lane: 'main', data: opData } }
const idle = { opState: { lane: 'main', data: null } }
const note = (): EventInput => ({ ...base, type: 'x/core/note', ignorable: true, data: {} })
const common = { key: 'k', ttlMs: 900, clock: () => Date.now(), timers: noTimers }
const wrapped = (storage: MemoryStorage, over: Partial<StorageAdapter>): StorageAdapter => ({
  open: storage.open.bind(storage),
  commit: storage.commit.bind(storage),
  renew: storage.renew.bind(storage),
  release: storage.release.bind(storage),
  scan: storage.scan.bind(storage),
  scanIntegrity: storage.scanIntegrity.bind(storage),
  registers: storage.registers.bind(storage),
  createChild: storage.createChild.bind(storage),
  close: storage.close.bind(storage),
  ...over,
})

describe('StateTracker', () => {
  it('rebuilds state from storage and keeps it live on append', async () => {
    const storage = new MemoryStorage()
    const { log, tracker } = await openTracked({ ...common, storage, writerRunId: 'r1', ids: defaultIds() })
    await log.append(
      [
        { ...base, type: 'turn/start', data: { turn: 1, trigger: 'prompt' } },
        {
          ...base,
          type: 'effect/intent',
          data: { effectId: 'e1', kind: 'tool', tool: { toolUseId: 't1', name: 'shell' }, replay: 'never' },
        },
        note(),
      ],
      running,
    )
    expect(tracker.state.openTurn.get('main')?.turn).toBe(1)
    expect(effectTree(tracker.state).map((n) => n.effectId)).toEqual(['e1'])
    await log.close()
    const again = await openTracked({ ...common, storage, writerRunId: 'r2', ids: defaultIds() })
    expect(again.tracker.state.lastSeq).toBe(3)
    expect(again.tracker.state.pendingEffects.has('e1')).toBe(true)
    expect(again.registersRebuilt).toBe(false)
    await again.log.close()
  })

  it('rebuilds pending effects across a reopen', async () => {
    // A rebuild that reads one page and stops leaves the tail of a long session unfolded, which is
    // indistinguishable from a correct rebuild on any fixture that fits in a page.
    const storage = new MemoryStorage()
    const first = await openTracked({ ...common, storage, writerRunId: 'r1', ids: defaultIds() })
    await first.log.append(
      [{ ...base, type: 'turn/start', data: { turn: 1, trigger: 'prompt' } }, note()],
      running,
    )
    for (let i = 0; i < 12; i++) {
      await first.log.append([
        {
          ...base,
          type: 'effect/intent',
          data: { effectId: `e${i}`, kind: 'job', replay: 'safe' },
        },
      ])
    }
    await first.log.close()
    const again = await openTracked({
      ...common,
      storage,
      writerRunId: 'r2',
      ids: defaultIds(),
    })
    expect(again.tracker.state.lastSeq).toBe(14)
    expect(again.tracker.state.pendingEffects.size).toBe(12)
    await again.log.close()
  })

  it('detects a drifted register table and rebuilds', async () => {
    const storage = new MemoryStorage()
    const first = await openTracked({ ...common, storage, writerRunId: 'r1', ids: defaultIds() })
    await first.log.append(
      [
        { ...base, type: 'turn/start', data: { turn: 1, trigger: 'prompt' } },
        { ...base, type: 'plan.items', register: 'plan.items', data: { items: [] } },
        note(),
      ],
      running,
    )
    await first.log.append(
      [{ ...base, type: 'turn/end', data: { reason: 'completed', lastAssistantSeq: null } }, note()],
      idle,
    )
    await first.log.close()
    // Corrupt the register table: the seq is wrong. op.state is gone by tombstone, so plan.items is
    // the only row left in the table.
    const rows = await storage.registers('k')
    expect(rows.map((r) => r.register)).toEqual(['plan.items'])
    ;(rows[0] as { seq: number }).seq = 99
    const {
      log: reopened,
      tracker,
      registersRebuilt,
    } = await openTracked({ ...common, storage, writerRunId: 'r2', ids: defaultIds() })
    expect(verifyRegisters(tracker, rows)).toEqual({ ok: false, mismatches: ['plan.items main: seq 99 ≠ 2'] })
    expect(tracker.state.registers.planItems.get('main')?.seq).toBe(2)
    expect(registersRebuilt).toBe(true)
    // The overwritten cache has to read back: both sides address the cache by its two halves, and a
    // write that spelled its own composite key would leave every rebuilt register unreadable.
    expect(reopened.latest('plan.items')).toEqual({ items: [] })
    expect(reopened.registerRow('plan.items')?.seq).toBe(2)
    await reopened.close()
  })

  it('names both directions of drift, and passes a table that agrees', async () => {
    const storage = new MemoryStorage()
    const { log, tracker } = await openTracked({ ...common, storage, writerRunId: 'r1', ids: defaultIds() })
    await log.append(
      [
        { ...base, type: 'turn/start', data: { turn: 1, trigger: 'prompt' } },
        { ...base, type: 'plan.items', register: 'plan.items', data: { items: [] } },
        note(),
      ],
      running,
    )
    expect(verifyRegisters(tracker, log.allRegisters())).toEqual({ ok: true, mismatches: [] })
    // A row the rebuild does not produce, and a cell the table has lost, are both reported.
    expect(
      verifyRegisters(tracker, [
        ...log.allRegisters(),
        { register: 'inbox', key: 'main', seq: 7, data: { items: [] } },
      ]).mismatches,
    ).toContain('inbox main: not in rebuild')
    // The program counter is not folded from rows, so it is not part of this comparison.
    expect(verifyRegisters(tracker, []).mismatches.sort()).toEqual(['plan.items main: missing from table'])
    await log.close()
  })

  it('names every register map the state holds, and names each one once', () => {
    // The invariant the fixture below can only sample: registerRows must cover the whole of
    // state.registers. A seventh map added to LedgerState and left out of the table would leave the
    // resume path silently short of one register while every test that folds six stayed green — and
    // a count assertion would only invite bumping the count.
    expect(Object.keys(REGISTER_NAMES).sort()).toEqual(Object.keys(initialState().registers).sort())
    const names = Object.values(REGISTER_NAMES)
    expect(new Set(names).size).toBe(names.length)
    // And the rows a fold produces carry exactly those register names, never an invented one.
    const blank = initialState()
    const state = {
      ...blank,
      registers: {
        ...blank.registers,
        inbox: new Map([['main', { seq: 1, value: { items: [] } }]]),
        harnessEntries: new Map([['memory\u0000m1', { seq: 2, value: {} as never }]]),
      },
    }
    expect(new Set(registerRows(state).map((r) => r.register))).toEqual(new Set(['inbox', 'harness/entry']))
    expect(registerRows(state).every((r) => names.includes(r.register))).toBe(true)
  })

  it('carries every one of the six registers through the verify and the reseed', async () => {
    // registerRows is the single source for both halves of the resume path, so a register missing
    // from it fails twice over and silently: verify reports every stored cell of that register as
    // "not in rebuild", which forces a rebuild that was not needed, and the reseed then writes a
    // cache with none of that register's cells in it. Fixture: one live cell in each of the six.
    const storage = new MemoryStorage()
    const first = await openTracked({ ...common, storage, writerRunId: 'r1', ids: defaultIds() })
    await first.log.append(
      [
        { ...base, type: 'turn/start', data: { turn: 1, trigger: 'prompt' } },
        note(),
        {
          ...base,
          type: 'plan.items',
          register: 'plan.items',
          data: { items: [{ id: 'p1', text: 'do', status: 'todo' }] },
        },
        {
          ...base,
          type: 'budget.state',
          register: 'budget.state',
          data: { slot: 'primary', escalate: false, creditsUsed: 3, creditsCap: null },
        },
        { ...base, type: 'artifact/job', register: 'artifact/job', data: { jobId: 'j1', status: 'queued' } },
        { ...base, type: 'inbox', register: 'inbox', data: { items: [] } },
        {
          ...base,
          type: 'harness/entry',
          register: 'harness/entry',
          data: {
            kind: 'memory',
            id: 'm1',
            title: 't',
            content: 'c',
            scope: 'local',
            version: 1,
            source: 'test',
          },
        },
      ],
      running,
    )
    await first.log.close()
    // Each cell named the way a consumer addresses it: register plus the key half storage spells.
    const cells: [string, string, unknown][] = [
      ['op.state', 'main', 7],
      ['plan.items', 'main', 3],
      ['budget.state', 'main', 4],
      ['artifact/job', 'j1', 5],
      ['inbox', 'main', 6],
      ['harness/entry', 'memory\u0000m1', 7],
    ]

    // A table that agrees is not rebuilt. A register missing from registerRows breaks this first:
    // its stored cells appear in no rebuild, so the verify fails on a table that is in fact correct.
    const clean = await openTracked({ ...common, storage, writerRunId: 'r2', ids: defaultIds() })
    expect(verifyRegisters(clean.tracker, await storage.registers('k'))).toEqual({ ok: true, mismatches: [] })
    expect(clean.registersRebuilt).toBe(false)
    await clean.log.close()

    // Now drift the table by one seq, so the reseed runs, and read all six back through the cache it
    // wrote. A register the reseed does not produce is gone from latest() with nothing said.
    const rows = await storage.registers('k')
    const planRow = rows.find((r) => r.register === 'plan.items') as { seq: number }
    planRow.seq = 99
    const again = await openTracked({ ...common, storage, writerRunId: 'r3', ids: defaultIds() })
    expect(again.registersRebuilt).toBe(true)
    for (const [register, key, seq] of cells) {
      expect(again.log.registerRow(register, key), `${register} ${key} survives the reseed`).toMatchObject({
        seq,
      })
      expect(again.log.latest(register, key), `${register} ${key} reads back`).toBeTruthy()
    }
    expect((again.log.latest('harness/entry', 'memory\u0000m1') as { id: string }).id).toBe('m1')
    await again.log.close()
  })

  it('uses a caller-supplied relationCheck instead of the default one', async () => {
    // The default check is a fallback, not a fixture: a caller that brings its own replaces it
    // wholesale, and a call that quietly ran the default alongside it would apply rules the caller
    // said it was taking over.
    const storage = new MemoryStorage()
    const seen: number[] = []
    const { log } = await openTracked({
      ...common,
      storage,
      writerRunId: 'r1',
      ids: defaultIds(),
      relationCheck: (events) => {
        seen.push(events.length)
      },
    })
    // A lone step/start outside any turn is what the default check refuses; the caller's does not.
    await log.append([{ ...base, type: 'step/start', data: { turn: 1, step: 1 } }])
    expect(seen).toEqual([1])
    await log.close()
  })

  it('rebuild() folds a log without touching its caches', async () => {
    const storage = new MemoryStorage()
    const { log } = await openTracked({ ...common, storage, writerRunId: 'r1', ids: defaultIds() })
    await log.append([{ ...base, type: 'turn/start', data: { turn: 1, trigger: 'prompt' } }, note()], running)
    const standalone = await StateTracker.rebuild(log)
    expect(standalone.state.lastSeq).toBe(2)
    expect(standalone.state.openTurn.get('main')?.turn).toBe(1)
    await log.close()
  })

  it('reopens by folding every row from the first while verifying, reading nothing twice', async () => {
    const storage = new MemoryStorage()
    const first = await openTracked({ ...common, storage, writerRunId: 'r1', ids: defaultIds() })
    await first.log.append(
      Array.from({ length: 200 }, (_, index) => ({
        ...base,
        type: 'user/message',
        data: { content: [{ type: 'text', text: `message-${index}` }] },
      })),
    )
    await first.log.close()

    const scannedFrom: number[] = []
    const originalScan = storage.scan.bind(storage)
    storage.scan = async (key, query) => {
      scannedFrom.push(query.fromSeq ?? 1)
      return originalScan(key, query)
    }
    const applied: number[] = []
    const original = StateTracker.prototype.apply
    StateTracker.prototype.apply = function (this: StateTracker, events) {
      applied.push(...events.map((event) => event.seq))
      return original.call(this, events)
    }
    let reopened: Awaited<ReturnType<typeof openTracked>>
    try {
      reopened = await openTracked({ ...common, storage, writerRunId: 'r2', ids: defaultIds() })
    } finally {
      StateTracker.prototype.apply = original
    }
    expect(applied).toEqual(Array.from({ length: 200 }, (_, i) => i + 1))
    expect(reopened.tracker.state.lastSeq).toBe(200)
    expect(reopened.surface.nodes()).toHaveLength(200)
    expect(reopened.ui.diagnostics().applied).toBe(200)
    // The rows were folded while the open verified them; nothing reads them a second time.
    expect(scannedFrom).toEqual([])
    await reopened.log.close()
  })

  it('keeps no UI projection state in storage: commits carry none and close only releases', async () => {
    const storage = new MemoryStorage()
    const calls: string[] = []
    const commits: string[][] = []
    const counted = new Proxy(storage, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          calls.push(String(property))
          if (property === 'commit') commits.push(Object.keys(args[1] as object).sort())
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      },
    }) as StorageAdapter
    const opened = await openTracked({
      ...common,
      storage: counted,
      writerRunId: 'r1',
      ids: defaultIds(),
      relationCheck: () => undefined,
    })
    await opened.log.append([
      {
        ...base,
        type: 'session/start',
        data: { key: 'k', resolvedProfileHash: null, preset: null, agnesVersion: 'test' },
      },
    ])
    await opened.log.append([
      { ...base, type: 'turn/end', data: { reason: 'completed', lastAssistantSeq: null } },
    ])
    calls.length = 0
    await opened.log.close()
    expect(calls).toEqual(['release'])
    for (const keys of commits)
      expect(
        keys.filter((key) => !['claim', 'events', 'expectedWriterRunId', 'integrity'].includes(key)),
      ).toEqual([])
  })

  it('does not let a reopen past a tampered prefix row', async () => {
    const storage = new MemoryStorage()
    const first = await openTracked({ ...common, storage, writerRunId: 'r1', ids: defaultIds() })
    await first.log.append(
      Array.from({ length: 200 }, (_, index) => ({
        ...base,
        type: 'user/message',
        data: { content: [{ type: 'text', text: `prefix-${index}` }] },
      })),
    )
    await first.log.close()
    const tampered = wrapped(storage, {
      scanIntegrity: async (key, query) => {
        const rows = await storage.scanIntegrity(key, query)
        return rows.map((row) =>
          row.event.seq === 1
            ? { ...row, event: { ...row.event, data: { content: [{ type: 'text', text: 'tampered' }] } } }
            : row,
        )
      },
    })
    await expect(
      openTracked({ ...common, storage: tampered, writerRunId: 'r2', ids: defaultIds() }),
    ).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
  })

  it('serializes concurrent appends, and a reopen folds the committed state', async () => {
    const storage = new MemoryStorage()
    const opened = await openTracked({
      ...common,
      storage,
      writerRunId: 'r1',
      ids: defaultIds(),
      relationCheck: () => undefined,
    })
    const batch = (prefix: string) =>
      Array.from({ length: 100 }, (_, index) => ({
        ...base,
        type: 'user/message',
        data: { content: [{ type: 'text', text: `${prefix}-${index}` }] },
      }))
    await Promise.all([opened.log.append(batch('a')), opened.log.append(batch('b'))])
    expect(opened.tracker.state.lastSeq).toBe(200)
    await opened.log.close()

    const reopened = await openTracked({
      ...common,
      storage,
      writerRunId: 'r2',
      ids: defaultIds(),
      relationCheck: () => undefined,
    })
    expect(reopened.tracker.state.lastSeq).toBe(200)
    expect(reopened.surface.nodes()).toHaveLength(200)
    await reopened.log.close()
  })

  it('round-trips populated register, map and set state deeply across a reopen', async () => {
    const storage = new MemoryStorage()
    const first = await openTracked({
      ...common,
      storage,
      writerRunId: 'r1',
      ids: defaultIds(),
      relationCheck: () => undefined,
    })
    const rich: EventInput[] = [
      {
        ...base,
        type: 'session/start',
        data: { key: 'k', resolvedProfileHash: null, preset: null, agnesVersion: 'test' },
      },
      {
        ...base,
        type: 'approval/asked',
        data: {
          requestId: 'resume',
          kind: 'tool',
          summary: 'resume',
          risk: 'always',
          bindingHash: 'a'.repeat(64),
        },
      },
      {
        ...base,
        type: 'approval/decided',
        data: { requestId: 'resume', verdict: 'allowed-once', via: 'callback' },
      },
      {
        ...base,
        type: 'turn/start',
        data: {
          turn: 1,
          trigger: 'approval-resume',
          continues: { turn: 1, step: 1, requestId: 'resume' },
        },
      },
      { ...base, type: 'step/start', data: { turn: 1, step: 1 } },
      {
        ...base,
        type: 'tool/call',
        data: { toolUseId: 'tool-1', name: 'read', args: { path: 'x' }, ordinal: 0 },
      },
      {
        ...base,
        type: 'effect/intent',
        data: {
          effectId: 'effect-1',
          kind: 'tool',
          replay: 'safe',
          tool: { toolUseId: 'tool-1', name: 'read' },
        },
      },
      {
        ...base,
        type: 'approval/asked',
        data: {
          requestId: 'pending',
          kind: 'tool',
          summary: 'pending',
          risk: 'always',
          bindingHash: 'b'.repeat(64),
        },
      },
      {
        ...base,
        type: 'user/message',
        trust: 'untrusted',
        data: { content: [{ type: 'text', text: 'taint' }] },
      },
      note(),
      {
        ...base,
        type: 'plan.items',
        register: 'plan.items',
        data: { items: [{ id: 'p', text: 'do', status: 'todo' }] },
      },
      {
        ...base,
        type: 'budget.state',
        register: 'budget.state',
        data: { slot: 'primary', escalate: false, creditsUsed: 3, creditsCap: 10 },
      },
      { ...base, type: 'artifact/job', register: 'artifact/job', data: { jobId: 'job', status: 'queued' } },
      { ...base, type: 'inbox', register: 'inbox', data: { items: [] } },
      {
        ...base,
        type: 'harness/entry',
        register: 'harness/entry',
        data: {
          kind: 'memory',
          id: 'm',
          title: 't',
          content: 'c',
          scope: 'local',
          version: 1,
          source: 'test',
        },
      },
      {
        ...base,
        type: 'cost/ledger',
        data: {
          purpose: 'inference',
          effectId: 'cost',
          tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
          credits: 2.5,
          creditSource: 'gateway',
          model: 'm',
        },
      },
    ]
    const fillers: EventInput[] = Array.from({ length: 200 - rich.length }, (_, index) => ({
      ...base,
      type: 'user/message',
      data: { content: [{ type: 'text', text: `filler-${index}` }] },
    }))
    for (const [index, event] of rich.entries()) {
      try {
        await first.log.append([event], running)
      } catch (error) {
        throw new Error(`rich fold fixture event ${index} (${event.type}) was rejected`, { cause: error })
      }
    }
    await first.log.append(fillers)
    const coldState = first.tracker.state
    expect([...coldState.resumedRequests]).toEqual(['resume'])
    expect(coldState.pendingEffects.size).toBe(1)
    expect(coldState.pendingApprovals.size).toBe(1)
    expect(Object.values(coldState.registers).every((register) => register.size === 1)).toBe(true)
    // Compared encoded: structuredClone drops the chunked tables' private contents, which would make
    // the comparison below pass whatever the tables held.
    const cold = canonicalJson(encodeLedgerState(coldState))
    const coldUI = await first.ui.view()
    await first.log.close()

    const reopened = await openTracked({
      ...common,
      storage,
      writerRunId: 'r2',
      ids: defaultIds(),
      relationCheck: () => undefined,
    })
    expect(canonicalJson(encodeLedgerState(reopened.tracker.state))).toBe(cold)
    expect(await reopened.ui.view()).toEqual(coldUI)
    await reopened.log.close()
  })

  it('keeps a live parent and its forked child apart', async () => {
    const storage = new MemoryStorage()
    const parent = await openTracked({ ...common, storage, writerRunId: 'parent', ids: defaultIds() })
    await parent.log.append(
      Array.from({ length: 200 }, (_, index) => ({
        ...base,
        type: 'user/message',
        data: { content: [{ type: 'text', text: `parent-${index}` }] },
      })),
    )
    const forked = await parent.log.forkInto(200, 'child', {
      actor,
      agnesVersion: 'test',
      preset: null,
      resolvedProfileHash: null,
      writerRunId: 'child-run',
      lane: 'main',
    })
    const child = await openTracked({
      ...common,
      key: 'child',
      storage,
      writerRunId: 'child-run',
      ids: defaultIds(),
      existing: forked,
    })
    await child.log.append([
      { ...base, type: 'user/message', data: { content: [{ type: 'text', text: 'child-only' }] } },
    ])
    expect(parent.surface.nodes()).toHaveLength(200)
    expect(child.surface.nodes()).toHaveLength(201)
    await child.log.close()
    await parent.log.close()
  })
})
