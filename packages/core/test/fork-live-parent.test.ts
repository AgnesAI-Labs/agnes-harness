import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { forkBaseProviders } from '../src/log/fork-seed.js'
import { verifyLedger } from '../src/log/integrity.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { type OpenLogOptions, SessionLogImpl } from '../src/log/session-log.js'
import type { StorageAdapter } from '../src/log/storage.js'
import { encodeLedgerState } from '../src/project/cache.js'
import { canonicalJson } from '../src/request/hash.js'
import { CompactionRunner } from '../src/step/compaction.js'
import { presetDefaults } from '../src/step/preset.js'
import type { SessionImpl } from '../src/step/session.js'
import type { Event, IdMinter, Seq } from '../src/types.js'
import { type FakeProvider, fakeProvider, type Script, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, readTool, testFsOps } from './helpers/open-session.js'

const CLOCK = 1_757_203_200_000
const signal = () => new AbortController().signal
const sessionOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w' }

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

/** Same ids on every run, so a child made twice from the same history writes the same bytes. */
const fixedIds = (): IdMinter => {
  let n = 0
  const next = () => String(++n).padStart(32, '0')
  return {
    ulid: () => next().slice(-26),
    effectId: () => `e-${next()}`,
    toolUseId: (ordinal) => `t${ordinal}-${next()}`,
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

function kernel(storage: StorageAdapter, provider: FakeProvider, warnings: unknown[] = [], ids = fixedIds()) {
  Object.assign(provider, { models: () => [model()] })
  const k = Kernel.create({
    storage,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits: 1_000, generationLimit: 3, maxFanOut: 8 },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string, detail?: unknown) => warnings.push({ message, detail }),
      error: () => undefined,
    },
    timers: noTimers,
    clock: () => CLOCK,
    ids,
  })
  k.tools.add(readTool(), { source: 'agnes/base', trust: 'builtin' })
  return k
}

const reads = (n: number): Script[] => Array.from({ length: n }, (_, i) => toolTurn('read', { path: `${i}` }))

/** Runs one turn to completion. */
async function readTurn(s: SessionImpl, text: string): Promise<void> {
  await s.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
  expect((await s.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
}

async function compact(s: SessionImpl): Promise<void> {
  s.compaction = new CompactionRunner({
    plan: async (payload) => {
      const nodes = payload.getSurface()
      const first = nodes[0]
      const last = nodes.findLast((n) => n.type === 'tool/result')
      const kept = nodes[nodes.findIndex((n) => n.seq === last?.seq) + 1]
      if (!first || !last || !kept) throw new Error('nothing to compact')
      return {
        keepFromSeq: kept.seq,
        summarizeRange: [first.seq, last.seq],
        prompts: { system: 'S', history: 'summarize it' },
        maxTokens: 100,
        details: { readFiles: [], modifiedFiles: [] },
      }
    },
    onCompact: async () => undefined,
  })
  await s.requestCompaction({ actor, admissionId: `compaction-${s.lastSeq}` })
  expect((await s.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
  // A real mask on the parent surface, which the child inherits.
  expect(s.surface().some((n) => n.kind === 'summary')).toBe(true)
}

type ParentState = 'cold' | 'fold'
type Path = 'fast' | 'cold'
type Scenario = { parent: ParentState; kind: 'fork' | 'spawn'; beforeHead?: boolean; twice?: boolean }

/**
 * A parent with a compacted tool-heavy turn, a plain turn, and an accepted turn to delegate from;
 * optionally closed and reopened from its fold cache first. The child is made on the live parent,
 * by the live-parent path or (with the parent's fork point withheld) by a cold open.
 */
async function delegate(sc: Scenario, path: Path) {
  const storage = new MemoryStorage({ clock: () => CLOCK })
  const scripts = [
    ...reads(20),
    textTurn('parent done'),
    textTurn('S'),
    textTurn('second'),
    textTurn('child'),
  ]
  const warnings: unknown[] = []
  let provider = fakeProvider(scripts)
  let k = kernel(storage, provider, warnings)
  let parent = await k.session('parent', { ...sessionOpts, writerRunId: 'r1' })
  await readTurn(parent, 'read files')
  await compact(parent)
  if (sc.parent !== 'cold') {
    await k.close()
    provider = fakeProvider(scripts.slice(22))
    k = kernel(storage, provider, warnings, fixedIds())
    parent = await k.session('parent', { ...sessionOpts, writerRunId: 'r2' })
    expect(parent.d.log.restoredFold).toBeDefined()
  }
  await readTurn(parent, 'second')
  await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'delegate' }], actor })
  await parent.acceptInput()
  // The accepted turn ends on its turn/start; one more row gives a boundary after the trigger and
  // before the head.
  if (sc.beforeHead) await parent.diag('contribute-conflict', {})
  const c = (parent.d.log.latest('op.state', 'main') as { meta: { triggerSeq: Seq } }).meta.triggerSeq
  if (path === 'cold') forkBaseProviders.delete(parent.d.log)
  // A first child seeded from the same fork point must leave that point as it found it.
  if (sc.twice)
    await createChild(parent, sc.kind, {
      parent: parent.key,
      cwd: '/w',
      input: 'first child',
      ...(sc.beforeHead ? { forkAt: parent.lastSeq - 1 } : {}),
    })
  const handle = await createChild(parent, sc.kind, {
    parent: parent.key,
    cwd: '/w',
    input: 'child task',
    ...(sc.beforeHead ? { forkAt: parent.lastSeq - 1 } : {}),
  })
  const child = k.get(handle.key) as SessionImpl
  const b = child.d.log.parent?.boundarySeq as Seq
  const own = await storage.scanIntegrity(child.key, { fromSeq: b + 1, toSeq: child.lastSeq, limit: 500 })
  const view = {
    b,
    c,
    ledger: canonicalJson(own),
    state: canonicalJson(encodeLedgerState(child.d.tracker.state)),
    surface: canonicalJson(child.surface().map(normalizeNode)),
    byId: canonicalJson([...child.d.surface.eventsById().keys()]),
    replaceGeneration: child.d.surface.replaceGeneration,
    registers: canonicalJson(
      child.d.log
        .allRegisters()
        .sort((x, y) => `${x.register}/${x.key}`.localeCompare(`${y.register}/${y.key}`)),
    ),
    projections: canonicalJson({
      ui: await child.projectUI(),
      patch: await child.projectUIPatch(0),
      opening: await child.projectUIOpening(),
      history: await child.projectUIHistory(child.lastSeq, 0),
    }),
  }
  const requestsBefore = provider.requests.length
  await handle.run('child task')
  const firstRequest = canonicalJson(provider.requests.slice(requestsBefore))
  const verified = await verifyLedger(storage, child.key, child.lastSeq)
  await k.close()
  const coldOpens = warnings.filter(
    (w) => (w as { message: string }).message === 'delegated child opened cold',
  )
  return { storage, view, firstRequest, verified, warnings: coldOpens, childKey: child.key }
}

/** Parent rows reach the child as the parent prepared them; a replay reads them back from storage. */
function normalizeNode(n: { seq: Seq; kind: string; pinned: boolean; masked?: unknown; event: Event }) {
  return { ...n, event: JSON.parse(canonicalJson(n.event)) }
}

const scenarios: Scenario[] = [
  { parent: 'cold', kind: 'spawn' },
  { parent: 'cold', kind: 'fork' },
  { parent: 'cold', kind: 'spawn', beforeHead: true },
  { parent: 'cold', kind: 'spawn', beforeHead: true, twice: true },
  { parent: 'fold', kind: 'spawn' },
  { parent: 'fold', kind: 'fork' },
]

describe('a delegated child made on its live parent equals the same child made by a cold open', () => {
  it.each(scenarios)(
    'parent $parent, $kind, before head: $beforeHead, twice: $twice',
    async (sc) => {
      const fast = await delegate(sc, 'fast')
      const cold = await delegate(sc, 'cold')
      // Only the withheld fork point sends a delegated child down the cold path, and that is logged.
      expect(fast.warnings).toEqual([])
      expect(cold.warnings).toEqual(
        Array.from({ length: sc.twice ? 2 : 1 }, () => ({
          message: 'delegated child opened cold',
          detail: { path: 'cold-open', reason: 'no-tracker' },
        })),
      )
      expect(fast.view.b).toBe(cold.view.b)
      if (sc.kind === 'fork') expect(fast.view.b).toBe(fast.view.c)
      if (sc.beforeHead) expect(fast.view.c).toBeLessThan(fast.view.b)
      // Same bytes and digests for every child row, so the chain state at the boundary was the same.
      expect(fast.view.ledger).toBe(cold.view.ledger)
      expect(fast.verified).toEqual(cold.verified)
      expect(fast.view.state).toBe(cold.view.state)
      expect(fast.view.surface).toBe(cold.view.surface)
      expect(fast.view.registers).toBe(cold.view.registers)
      expect(fast.view.byId).toBe(cold.view.byId)
      expect(fast.view.replaceGeneration).toBe(cold.view.replaceGeneration)
      expect(fast.view.projections).toBe(cold.view.projections)
      expect(fast.firstRequest).toBe(cold.firstRequest)
      // The live-parent child's fold cache is written as usual.
      expect(await fast.storage.foldCache(fast.childKey)).toBeDefined()
    },
    60_000,
  )
})

describe('the chain state at the boundary', () => {
  it('is the one a full verification of the child prefix computes', async () => {
    for (const sc of scenarios.slice(0, 3)) {
      const run = await delegate(sc, 'fast')
      const prefix = await verifyLedger(run.storage, run.childKey, run.view.b)
      const own = await run.storage.scanIntegrity(run.childKey, {
        fromSeq: run.view.b + 1,
        toSeq: run.view.b + 1,
        limit: 1,
      })
      // The first own row chains onto exactly the boundary head a cold verification reaches.
      expect(own[0]?.integrity?.previousDigest ?? null).toBe(prefix.headDigest)
    }
  }, 60_000)
})

describe('the anchor cannot be supplied from outside', () => {
  it('adds no open option and exposes no seeding member on the root-exported log class', () => {
    const names = [
      ...Object.getOwnPropertyNames(SessionLogImpl),
      ...Object.getOwnPropertyNames(SessionLogImpl.prototype),
    ]
    expect(names.filter((n) => /seed|fromLiveParent|anchor/i.test(n))).toEqual([])
    const base: OpenLogOptions = {
      storage: new MemoryStorage(),
      key: 'k',
      writerRunId: 'w',
      ttlMs: 1,
      ids: fixedIds(),
      clock: () => 0,
    }
    const integrity = { lastSeq: 0, legacyThroughSeq: 0, headDigest: null }
    // @ts-expect-error no chain state can be handed to an open
    const withAnchor: OpenLogOptions = { ...base, integrity }
    expect(withAnchor).toBeDefined()
  })
})
