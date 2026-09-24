import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { forkBaseProviders } from '../src/log/fork-seed.js'
import { verifyLedger } from '../src/log/integrity.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import type { StorageAdapter } from '../src/log/storage.js'
import { presetDefaults } from '../src/step/preset.js'
import type { SessionImpl } from '../src/step/session.js'
import type { Event, IdMinter, PreparedEvent, Seq } from '../src/types.js'
import { type FakeProvider, fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, readTool, testFsOps } from './helpers/open-session.js'

const CLOCK = 1_757_203_200_000
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
function tamper(storage: MemoryStorage, key: string, seq: Seq, edit: (e: Event) => Event): void {
  const events = (storage as unknown as Books).books.get(key)?.events ?? []
  const i = events.findIndex((e) => e.seq === seq)
  if (i < 0) throw new Error(`no row ${seq} in ${key}`)
  events[i] = edit(structuredClone(events[i] as Event))
}

/** Rows written by an older build that kept no integrity metadata. */
async function legacyRows(storage: MemoryStorage, key: string, n: number): Promise<void> {
  await storage.open(key, { writerRunId: 'legacy', ttlMs: 1 })
  const events = Array.from(
    { length: n },
    (_, i): PreparedEvent => ({
      id: `legacy-${i}`,
      ts: '2026-09-01T00:00:00.000Z',
      actor,
      origin: 'principal',
      trust: 'trusted',
      lane: 'main',
      v: 1,
      type: 'user/message',
      data: { content: [{ type: 'text', text: `old ${i}` }] },
    }),
  )
  await storage.commit(key, { events, expectedWriterRunId: 'legacy' })
  await storage.release(key, 'legacy')
}

const delegateLine = (text: string) => ({ content: [{ type: 'text' as const, text }], actor })

/**
 * Creates a delegated child (and, for `grandchild`, a child of that child) on a live parent whose
 * history starts with `legacy` unprotected rows, and returns what the deepest child wrote and folded.
 */
async function build(o: {
  legacy: number
  kind: 'fork' | 'spawn'
  grandchild: boolean
  path: 'fast' | 'cold'
}) {
  const storage = new MemoryStorage({ clock: () => CLOCK })
  if (o.legacy) await legacyRows(storage, 'parent', o.legacy)
  const k = kernel(storage, fakeProvider([textTurn('a'), textTurn('b'), textTurn('c')]))
  let owner = await k.session('parent', { ...sessionOpts, writerRunId: 'r1' })
  const turns = o.kind === 'fork' ? 1 : 0
  for (let i = 0; i < turns; i++) {
    await owner.enqueue('next-turn', delegateLine('delegate'))
    await owner.acceptInput()
  }
  const make = async (from: SessionImpl) => {
    if (o.path === 'cold') forkBaseProviders.delete(from.d.log)
    const handle = await createChild(from, o.kind, { parent: from.key, cwd: '/w', input: 'x' })
    return k.get(handle.key) as SessionImpl
  }
  let child = await make(owner)
  if (o.grandchild) {
    owner = child
    if (o.kind === 'fork') {
      await owner.enqueue('next-turn', delegateLine('delegate again'))
      await owner.acceptInput()
    }
    child = await make(owner)
  }
  const b = child.d.log.parent?.boundarySeq as Seq
  const rows = await storage.scanIntegrity(child.key, { fromSeq: b + 1, toSeq: child.lastSeq, limit: 500 })
  const prefix = await verifyLedger(storage, child.key, b)
  const whole = await verifyLedger(storage, child.key, child.lastSeq)
  await k.close()
  return { rows: JSON.stringify(rows), prefix, whole, b }
}

describe('the chain state a live parent hands its child equals a full verification of the prefix', () => {
  it.each([
    { legacy: 3, kind: 'spawn', grandchild: false },
    { legacy: 3, kind: 'fork', grandchild: false },
    { legacy: 0, kind: 'fork', grandchild: false },
    { legacy: 0, kind: 'fork', grandchild: true },
    { legacy: 0, kind: 'spawn', grandchild: true },
    { legacy: 3, kind: 'fork', grandchild: true },
  ] as const)('legacy rows $legacy, $kind, grandchild $grandchild', async (o) => {
    const fast = await build({ ...o, path: 'fast' })
    const cold = await build({ ...o, path: 'cold' })
    expect(fast.b).toBe(cold.b)
    expect(fast.rows).toBe(cold.rows)
    expect(fast.whole).toEqual(cold.whole)
    const first = JSON.parse(fast.rows)[0] as { integrity: { mode: string; previousDigest: string | null } }
    // The child's first row chains (or anchors) on exactly the prefix head a cold verification finds.
    expect(first.integrity.previousDigest).toBe(fast.prefix.headDigest)
    // Rows an older build wrote without integrity stay counted as such in the handed-over state.
    expect(fast.prefix.legacyThroughSeq).toBe(o.legacy)
  })
})

describe('reopening a delegated child on its live parent', () => {
  it("verifies the child's own rows from the parent's chain state and refuses a rewritten one", async () => {
    const storage = new MemoryStorage({ clock: () => CLOCK })
    const k = kernel(storage, fakeProvider([textTurn('a'), textTurn('b')]))
    const parent = await k.session('parent', { ...sessionOpts, writerRunId: 'r1' })
    await parent.enqueue('next-turn', delegateLine('delegate'))
    await parent.acceptInput()
    const handle = await createChild(parent, 'fork', {
      parent: parent.key,
      cwd: '/w',
      input: 'x',
    })
    const child = k.get(handle.key) as SessionImpl
    const b = child.d.log.parent?.boundarySeq as Seq
    const [start] = await child.scan({ fromSeq: b + 1, toSeq: b + 1, limit: 1 })
    type Delegation = NonNullable<Parameters<typeof k.session>[1]['delegation']>
    const delegation = (start?.data as { delegation?: Delegation } | undefined)?.delegation
    if (!delegation) throw new Error('child start carries no delegation')
    const lastSeq = child.lastSeq
    const state = JSON.stringify(child.surface().map((n) => n.seq))
    await child.close()
    const reopen = (writerRunId: string) =>
      k.session(child.key, {
        ...sessionOpts,
        writerRunId,
        parent: { key: 'parent', boundarySeq: b },
        delegation,
      })
    const again = await reopen('r2')
    expect(again.lastSeq).toBe(lastSeq)
    expect(JSON.stringify(again.surface().map((n) => n.seq))).toBe(state)
    await again.close()
    tamper(storage, child.key, b + 2, (e) => ({ ...e, ts: '2000-01-01T00:00:00.000Z' }))
    await expect(reopen('r3')).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    await k.close()
  })
})
