import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { requireChildControl } from '../src/child/store.js'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import type { ScanQuery, StorageAdapter } from '../src/log/storage.js'
import { presetDefaults } from '../src/step/preset.js'
import { SessionImpl } from '../src/step/session.js'
import type { Event, IdMinter, Seq } from '../src/types.js'
import { type FakeProvider, fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, readTool, testFsOps } from './helpers/open-session.js'

const CLOCK = 1_757_203_200_000
const signal = () => new AbortController().signal
const sessionOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w' }
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
const model = (): ModelRecord => ({
  id: 'm1',
  name: 'm1',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})
const fixedIds = (): IdMinter => {
  let n = 0
  const next = () => String(++n).padStart(32, '0')
  return {
    ulid: () => next().slice(-26),
    effectId: () => `e-${next()}`,
    toolUseId: (o) => `t${o}-${next()}`,
    requestId: () => `r-${next()}`,
    nonce: () => next(),
  }
}

type CreateOpts = Parameters<NonNullable<SessionImpl['d']['children']['createWithKind']>>[1]
/** The kernel's own child factory, the entry the subagent tools use. */
function createChild(from: SessionImpl, kind: 'fork' | 'spawn', opts: CreateOpts) {
  const create = from.d.children.createWithKind
  if (!create) throw new Error('this child factory cannot create by kind')
  return create.call(from.d.children, kind, opts)
}

function kernel(storage: StorageAdapter, provider: FakeProvider) {
  Object.assign(provider, { models: () => [model()] })
  const k = Kernel.create({
    storage,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits: 1_000, generationLimit: 3, maxFanOut: 8 },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => CLOCK,
    ids: fixedIds(),
  })
  k.tools.add(readTool(), { source: 'agnes/base', trust: 'builtin' })
  return k
}

type Books = { books: Map<string, { events: Event[] }> }
/** Rewrites one stored row in place of storage, the way another process editing the file would. */
function tamper(storage: MemoryStorage, key: string, seq: Seq, edit: (e: Event) => Event): void {
  const events = (storage as unknown as Books).books.get(key)?.events ?? []
  const i = events.findIndex((e) => e.seq === seq)
  if (i < 0) throw new Error(`no row ${seq} in ${key}`)
  events[i] = edit(structuredClone(events[i] as Event))
}

/** A parent that read two files, then accepted a turn to delegate from. */
async function parentReady(storage: StorageAdapter, provider: FakeProvider, pastTrigger = false) {
  const k = kernel(storage, provider)
  const parent = await k.session('parent', { ...sessionOpts, writerRunId: 'r1' })
  await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'read' }], actor })
  expect((await parent.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
  await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'delegate' }], actor })
  await parent.acceptInput()
  const c = (parent.d.log.latest('op.state', 'main') as { meta: { triggerSeq: Seq } }).meta.triggerSeq
  // The accepted turn ends on its turn/start; one more row gives a boundary after the trigger and
  // before the head.
  if (pastTrigger) await parent.diag('contribute-conflict', {})
  return { k, parent, c }
}

const script = () =>
  fakeProvider([
    toolTurn('read', { path: 'a' }),
    toolTurn('read', { path: 'b' }),
    textTurn('parent done'),
    textTurn('child'),
    textTurn('parent again'),
  ])

describe('what creating a delegated child still detects', () => {
  it('a rewritten parent row between the fork point and the boundary: no child rows, attempt cancelled', async () => {
    const storage = new MemoryStorage({ clock: () => CLOCK })
    const { k, parent, c } = await parentReady(storage, script(), true)
    const b = parent.lastSeq - 1
    expect(c).toBeLessThan(b)
    tamper(storage, 'parent', c + 1, (e) => ({ ...e, data: { ...(e.data as object), turn: 99 } }))
    await expect(
      createChild(parent, 'spawn', { parent: parent.key, cwd: '/w', input: 'x', forkAt: b }),
    ).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    const records = await requireChildControl(storage).listByParent('parent')
    expect(records).toHaveLength(1)
    expect(records[0]?.creationPhase).toBe('cancelled')
    const childKey = records[0]?.childKey as string
    expect(await storage.scan(childKey, { fromSeq: b + 1, toSeq: b + 10, limit: 10 })).toEqual([])
    expect(parent.d.log.faulted).toBe(false)
    await k.close()
  })

  it('a child ledger whose ancestry is not the live parent at the boundary', async () => {
    const storage = new MemoryStorage({ clock: () => CLOCK })
    const lying: StorageAdapter = Object.create(storage, {
      open: {
        value: async (key: string, claim: { writerRunId: string; ttlMs: number }) => {
          const opened = await storage.open(key, claim)
          return opened.parent
            ? { ...opened, parent: { ...opened.parent, boundarySeq: opened.parent.boundarySeq - 1 } }
            : opened
        },
      },
    })
    const { k, parent } = await parentReady(lying, script())
    await expect(
      createChild(parent, 'fork', { parent: parent.key, cwd: '/w', input: 'x' }),
    ).rejects.toMatchObject({ code: 'E_STORAGE_FAULT', message: expect.stringContaining('ancestry') })
    await k.close()
  })
})

describe('what creating a delegated child no longer detects (approved)', () => {
  it('a rewritten tool call at or before the fork point: the child starts, reads it like its parent, and any cold open refuses it', async () => {
    const storage = new MemoryStorage({ clock: () => CLOCK })
    const provider = script()
    const { k, parent, c } = await parentReady(storage, provider)
    const call = (await storage.scan('parent', { type: 'tool/call', toSeq: c, limit: 1 }))[0] as Event
    tamper(storage, 'parent', call.seq, (e) => ({
      ...e,
      data: { ...(e.data as object), args: { path: 'tampered' } },
    }))
    const handle = await createChild(parent, 'fork', {
      parent: parent.key,
      cwd: '/w',
      input: 'x',
    })
    const child = k.get(handle.key) as SessionImpl
    // The seeded, in-memory surface is the parent's own and still says what was written.
    const seededCall: ReadonlyMap<string, unknown> | undefined = child.d.tracker.state.toolCalls
    expect(JSON.stringify([...(seededCall?.values() ?? [])])).not.toContain('tampered')
    const before = provider.requests.length
    await handle.run('x')
    expect(JSON.stringify(provider.requests.slice(before))).toContain('tampered')
    // The parent's own next request reads the same stored row.
    expect((await parent.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    expect(JSON.stringify(provider.requests.at(-1))).toContain('tampered')
    const childKey = child.key
    await k.close()
    const again = kernel(storage, fakeProvider([]))
    await expect(again.session('parent', { ...sessionOpts, writerRunId: 'r3' })).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
    await expect(again.session(childKey, { ...sessionOpts, writerRunId: 'r4' })).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
    await again.close()
  })

  it('a rewritten parent row after the boundary: outside the child, as before', async () => {
    const storage = new MemoryStorage({ clock: () => CLOCK })
    const { k, parent, c } = await parentReady(storage, script())
    tamper(storage, 'parent', c + 1, (e) => ({ ...e, data: { ...(e.data as object), turn: 99 } }))
    const handle = await createChild(parent, 'fork', {
      parent: parent.key,
      cwd: '/w',
      input: 'x',
    })
    expect(k.get(handle.key)?.d.log.parent).toEqual({ key: 'parent', boundarySeq: c })
    await k.close()
  })
})

describe('creating a delegated child reads nothing of the parent up to the fork point', () => {
  type Read = { key: string; seq: Seq }
  /** Every row storage hands back while the probe is on, by key and seq. */
  function counted(storage: MemoryStorage) {
    const reads: Read[] = []
    let on = false
    const note = (key: string, seqs: Seq[]) => {
      if (on) for (const seq of seqs) reads.push({ key, seq })
    }
    const wrapped: StorageAdapter = Object.create(storage, {
      scan: {
        value: async (key: string, q: ScanQuery) => {
          const rows = await storage.scan(key, q)
          note(
            key,
            rows.map((r) => r.seq),
          )
          return rows
        },
      },
      scanIntegrity: {
        value: async (key: string, q: { fromSeq: Seq; toSeq: Seq; limit: number }) => {
          const rows = await storage.scanIntegrity(key, q)
          note(
            key,
            rows.map((r) => r.event.seq),
          )
          return rows
        },
      },
    })
    return { wrapped, reads, start: () => (on = true), stop: () => (on = false) }
  }

  it.each([
    ['fork', false],
    ['spawn', false],
    ['spawn', true],
  ] as const)('%s, boundary before head: %s', async (kind, beforeHead) => {
    const storage = new MemoryStorage({ clock: () => CLOCK })
    const probe = counted(storage)
    const { k, parent, c } = await parentReady(probe.wrapped, script())
    probe.start()
    const handle = await createChild(parent, kind, {
      parent: parent.key,
      cwd: '/w',
      input: 'x',
      ...(beforeHead ? { forkAt: parent.lastSeq - 1 } : {}),
    })
    probe.stop()
    const b = k.get(handle.key)?.d.log.parent?.boundarySeq as Seq
    // Nothing the parent already had in hand is read back. At the head nothing is read at all; from a
    // trigger point, only the parent's rows after it up to the boundary, each once.
    const atHead = kind === 'spawn' && !beforeHead
    expect(probe.reads).toEqual(
      atHead ? [] : Array.from({ length: b - c }, (_, i) => ({ key: 'parent', seq: c + 1 + i })),
    )
    await k.close()
  })
})

describe('rows storage hands back for a range are held to the key and range asked for', () => {
  it("a sibling child's rows returned for the parent's range after the fork point are refused", async () => {
    const storage = new MemoryStorage({ clock: () => CLOCK })
    let swapTo: string | undefined
    const swapping: StorageAdapter = Object.create(storage, {
      scanIntegrity: {
        value: async (key: string, q: { fromSeq: Seq; toSeq: Seq; limit: number }) =>
          storage.scanIntegrity(swapTo && key === 'parent' ? swapTo : key, q),
      },
    })
    const { k, parent, c } = await parentReady(swapping, script(), true)
    // A sibling forked at the same trigger chains its own rows from the same digest.
    const sibling = await createChild(parent, 'fork', { parent: parent.key, cwd: '/w', input: 'sibling' })
    const b = parent.lastSeq - 1
    expect(b).toBeGreaterThan(c)
    swapTo = sibling.key
    await expect(
      createChild(parent, 'spawn', { parent: parent.key, cwd: '/w', input: 'x', forkAt: b }),
    ).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    swapTo = undefined
    await k.close()
  })

  it("rows past the boundary returned for the parent's range are refused before the child is made", async () => {
    const storage = new MemoryStorage({ clock: () => CLOCK })
    let overshoot = false
    const loose: StorageAdapter = Object.create(storage, {
      scanIntegrity: {
        value: async (key: string, q: { fromSeq: Seq; toSeq: Seq; limit: number }) =>
          storage.scanIntegrity(key, overshoot ? { ...q, toSeq: q.toSeq + 5 } : q),
      },
    })
    const { k, parent } = await parentReady(loose, script(), true)
    const b = parent.lastSeq - 1
    overshoot = true
    await expect(
      createChild(parent, 'spawn', { parent: parent.key, cwd: '/w', input: 'x', forkAt: b }),
    ).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY', message: expect.stringContaining('exceeds') })
    overshoot = false
    await k.close()
  })

  it('a child ledger that names a different parent key', async () => {
    const storage = new MemoryStorage({ clock: () => CLOCK })
    const lying: StorageAdapter = Object.create(storage, {
      open: {
        value: async (key: string, claim: { writerRunId: string; ttlMs: number }) => {
          const opened = await storage.open(key, claim)
          return opened.parent ? { ...opened, parent: { ...opened.parent, key: 'someone-else' } } : opened
        },
      },
    })
    const { k, parent } = await parentReady(lying, script())
    await expect(
      createChild(parent, 'fork', { parent: parent.key, cwd: '/w', input: 'x' }),
    ).rejects.toMatchObject({ code: 'E_STORAGE_FAULT', message: expect.stringContaining('ancestry') })
    await k.close()
  })
})

describe('a child on another lane than the parent surface', () => {
  it("is opened cold, with its own lane's surface", async () => {
    const storage = new MemoryStorage({ clock: () => CLOCK })
    const { k, c } = await parentReady(storage, script())
    const child = await k.session('parent/side-child', {
      ...sessionOpts,
      writerRunId: 'r-side',
      lane: 'side',
      parent: { key: 'parent', boundarySeq: c },
      delegation: { kind: 'fork', creationId: 'side', rootTaskId: 'parent', generationDepth: 1 },
    })
    // Nothing of the parent's main-lane surface belongs on a side-lane child.
    expect(child.surface()).toEqual([])
    await k.close()
  })
})

describe('a partial UI cell', () => {
  it('sends every projection down the replay path, without computing head usage', async () => {
    const storage = new MemoryStorage({ clock: () => CLOCK })
    const { k, parent } = await parentReady(storage, script())
    const handle = await createChild(parent, 'fork', {
      parent: parent.key,
      cwd: '/w',
      input: 'x',
    })
    const child = k.get(handle.key) as SessionImpl
    expect(child.d.ui.complete).toBe(false)
    const usage = vi.spyOn(
      SessionImpl.prototype as unknown as { headProjectionUsage: () => unknown },
      'headProjectionUsage',
    )
    try {
      const opening = await child.projectUIOpening()
      expect(usage).not.toHaveBeenCalled()
      expect(opening.timeline.nodes.length).toBeGreaterThan(0)
    } finally {
      usage.mockRestore()
    }
    await k.close()
  })
})

describe('shared parent objects', () => {
  it('are not modified by a child that starts from them', async () => {
    const storage = new MemoryStorage({ clock: () => CLOCK })
    const { k, parent } = await parentReady(storage, script())
    const freeze = (value: unknown): void => {
      if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
      Object.freeze(value)
      for (const v of Object.values(value)) freeze(v)
    }
    for (const node of parent.surface()) freeze(node)
    const handle = await createChild(parent, 'fork', {
      parent: parent.key,
      cwd: '/w',
      input: 'x',
    })
    await expect(handle.run('x')).resolves.toBeDefined()
    await k.close()
  })
})
