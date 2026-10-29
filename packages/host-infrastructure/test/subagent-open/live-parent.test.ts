import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type Event,
  type IdMinter,
  Kernel,
  presetDefaults,
  type ScanQuery,
  type Seq,
  type SessionImpl,
  type StorageAdapter,
  verifyLedger,
} from '@agnes/core'
import {
  actor,
  defaultLoops,
  type FakeProvider,
  fakeProvider,
  fakeSeams,
  fencedFs,
  noTimers,
  readTool,
  testFsPolicy,
  textTurn,
  toolTurn,
} from '@agnes/core/testkit'
import type { ModelRecord } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStorage, type SqliteStorage } from '../../src/adapters/storage-sqlite.js'

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
const fsOps = fencedFs(
  {
    read: async () => new Uint8Array(),
    write: async () => undefined,
    list: async () => [],
    stat: async () => ({ kind: 'file' as const, size: 0, mtimeMs: 0 }),
  },
  testFsPolicy('/w'),
)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function ledger() {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-live-parent-'))
  dirs.push(dir)
  const file = join(dir, 'sessions.db')
  return { file, open: () => createSqliteStorage({ file, tablesDir: join(dir, 'tables') }) }
}

function kernel(storage: StorageAdapter, provider: FakeProvider) {
  Object.assign(provider, { models: () => [model()] })
  const k = Kernel.create({
    loops: defaultLoops(),
    storage,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits: 1_000, generationLimit: 3, maxFanOut: 8 },
    fsOps,
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => CLOCK,
    ids: fixedIds(),
  })
  k.tools.add(readTool(), { source: 'agnes/base', trust: 'builtin' })
  return k
}

type CreateOpts = Parameters<NonNullable<SessionImpl['d']['children']['createWithKind']>>[1]
function createChild(from: SessionImpl, kind: 'fork' | 'spawn', opts: CreateOpts) {
  const create = from.d.children.createWithKind
  if (!create) throw new Error('this child factory cannot create by kind')
  return create.call(from.d.children, kind, opts)
}

/** Another process rewriting one stored row, the way `DatabaseSync` against the same file can. */
function rewrite(file: string, key: string, seq: Seq, edit: (data: unknown) => unknown): void {
  const db = new DatabaseSync(file)
  try {
    const row = db.prepare('SELECT data FROM events WHERE session_key = ? AND seq = ?').get(key, seq) as {
      data: string
    }
    db.prepare('UPDATE events SET data = ? WHERE session_key = ? AND seq = ?').run(
      JSON.stringify(edit(JSON.parse(row.data))),
      key,
      seq,
    )
  } finally {
    db.close()
  }
}

async function parentReady(storage: SqliteStorage, provider: FakeProvider) {
  const k = kernel(storage, provider)
  const parent = await k.session('parent', { ...sessionOpts, writerRunId: 'r1' })
  await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'read' }], actor })
  expect((await parent.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
  await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'delegate' }], actor })
  await parent.acceptInput()
  const c = (parent.d.log.latest('op.state', 'main') as { meta: { triggerSeq: Seq } }).meta.triggerSeq
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

describe('delegated child creation on SQLite: what is still detected', () => {
  it('a parent row rewritten between the fork point and the boundary', async () => {
    const l = ledger()
    const storage = l.open()
    const { k, parent, c } = await parentReady(storage, script())
    // The accepted turn ends on its turn/start; one more row gives a boundary after the trigger and
    // before the head.
    await parent.diag('contribute-conflict', {})
    const b = parent.lastSeq - 1
    expect(b).toBeGreaterThan(c)
    rewrite(l.file, 'parent', c + 1, (data) => ({ ...(data as object), turn: 99 }))
    await expect(
      createChild(parent, 'spawn', { parent: parent.key, cwd: '/w', input: 'x', forkAt: b }),
    ).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    expect(parent.d.log.faulted).toBe(false)
    await k.close()
    await storage.close()
  })
})

describe('independent verification of a delegated child on SQLite', () => {
  it('detects a rewritten inherited tool call and retains parent and child seals after cold reopen', async () => {
    const l = ledger()
    const storage = l.open()
    const { k, parent, c } = await parentReady(storage, script())
    const [call] = await storage.scan('parent', { type: 'tool/call', toSeq: c, limit: 1 })
    rewrite(l.file, 'parent', (call as Event).seq, (data) => ({
      ...(data as object),
      args: { path: 'tampered' },
    }))
    // Independent verification can seal the child before or after its handle is published.
    const creation = await createChild(parent, 'fork', { parent: parent.key, cwd: '/w', input: 'x' }).then(
      (handle) => ({ handle }),
      (error) => ({ error }),
    )
    const records = await storage.listByParent('parent')
    expect(records).toHaveLength(1)
    const childKey = records[0]!.childKey
    if ('handle' in creation) {
      const child = k.get(creation.handle.key) as SessionImpl
      await expect(child.d.log.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
      await expect(
        child.enqueue('next-turn', { content: [{ type: 'text', text: 'refused' }], actor }),
      ).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    } else expect(creation.error).toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    await expect(parent.auditHistory()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    await expect(
      parent.enqueue('next-turn', { content: [{ type: 'text', text: 'refused' }], actor }),
    ).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    await k.close()
    await storage.close()
    // Both independent seals survive two fresh adapter/kernel lifetimes.
    for (const run of [3, 5]) {
      const reopened = l.open()
      const again = kernel(reopened, fakeProvider([]))
      for (const [key, writerRunId] of [
        ['parent', `r${run}`],
        [childKey, `r${run + 1}`],
      ] as const)
        await expect(again.session(key, { ...sessionOpts, writerRunId })).rejects.toMatchObject({
          code: 'E_LEDGER_INTEGRITY',
        })
      await again.close()
      await reopened.close()
    }
  })
})

// A 20,000-row parent: creation reads back only what follows the fork point, and its cost does
// not follow the parent's length. The parent's history is mostly extension notes, so its surface
// stays small and the child's first turn does not stand in for the thing measured here.
describe('a 20,000-row parent on SQLite', () => {
  it.each(['fork', 'spawn'] as const)(
    '%s: creation reads nothing up to the fork point',
    async (kind) => {
      const l = ledger()
      const storage = l.open()
      const reads: Array<{ key: string; seq: Seq }> = []
      let counting = false
      const note = (key: string, seqs: Seq[]) => {
        if (counting) for (const seq of seqs) reads.push({ key, seq })
      }
      const probe: StorageAdapter = Object.create(storage, {
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
      const k = kernel(probe, fakeProvider([textTurn('child')]))
      const parent = await k.session('parent', { ...sessionOpts, writerRunId: 'r1' })
      for (let i = 0; i < 20_000; i += 1_000)
        await parent.append(
          Array.from({ length: 1_000 }, (_, j) =>
            parent.ev('x/agnes/bench/note', { n: i + j }, { ignorable: true }),
          ),
        )
      await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'delegate' }], actor })
      await parent.acceptInput()
      const c = (parent.d.log.latest('op.state', 'main') as { meta: { triggerSeq: Seq } }).meta.triggerSeq
      expect(c).toBeGreaterThan(20_000)
      counting = true
      const handle = await createChild(parent, kind, { parent: parent.key, cwd: '/w', input: 'x' })
      counting = false
      const child = k.get(handle.key) as SessionImpl
      const b = child.d.log.parent?.boundarySeq as Seq
      expect(reads.filter((r) => r.seq <= c)).toEqual([])
      expect(reads.length).toBeLessThanOrEqual(b - c)
      // The chain the child continues is the one a full verification of its prefix reaches.
      expect(await verifyLedger(storage, child.key, child.lastSeq)).toMatchObject({ lastSeq: child.lastSeq })
      await k.close()
      await storage.close()
    },
    120_000,
  )
})
