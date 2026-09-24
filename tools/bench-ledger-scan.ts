import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  createAuxiliaryVisionEffectPort,
  type Event,
  type PreparedEvent,
  type ScanQuery,
  type Seq,
  scanAll,
} from '../packages/core/src/index.js'
import { surfaceToolCalls } from '../packages/core/src/step/inference.js'
import { actor, fakeProvider, openSession } from '../packages/core/testkit/index.js'
import { createSqliteStorage, type SqliteStorage } from '../packages/host/src/index.js'

// Ledger scan costs after the paging fix, on SQLite. Not a CI gate and no timing assertion: the
// numbers go into the execution record, including any that miss their target.
const readNumber = (flag: string, fallback: number): number => {
  const index = process.argv.indexOf(flag)
  const value = index < 0 ? fallback : Number(process.argv[index + 1])
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`)
  return value
}
const runs = readNumber('--runs', 5)

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] as number
}
async function time(fn: () => Promise<unknown>): Promise<number> {
  await fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const started = performance.now()
    await fn()
    samples.push(performance.now() - started)
  }
  return median(samples)
}

function sqlite(): { storage: SqliteStorage; cleanup: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-scan-bench-'))
  const storage = createSqliteStorage({
    file: join(dir, 'ledger.db'),
    tablesDir: join(dir, 'tables'),
    clock: () => 1_757_203_200_000,
  })
  return {
    storage,
    cleanup: async () => {
      await storage.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const row = (type: string, data: unknown, n: number): PreparedEvent => ({
  ts: '2026-09-24T00:00:00.000Z',
  id: `bench-${n}`,
  lane: 'main',
  v: 1,
  actor,
  origin: type === 'tool/call' ? 'model' : 'system',
  trust: 'trusted',
  type,
  data,
})

async function commitAll(storage: SqliteStorage, key: string, events: PreparedEvent[]): Promise<void> {
  for (let i = 0; i < events.length; i += 1_000)
    await storage.commit(key, { events: events.slice(i, i + 1_000), expectedWriterRunId: 'bench' })
}

/** The pre-fix attribution, run over complete inputs: two reads, then a scan of every owner per call. */
async function nestedOwners(read: (q: ScanQuery) => Promise<Event[]>, first: Seq, lastSeq: Seq) {
  const [messages, rows] = await Promise.all([
    scanAll(read, { fromSeq: first, toSeq: lastSeq, type: 'assistant/message', lane: 'main' }),
    scanAll(read, { fromSeq: first, toSeq: lastSeq, type: 'tool/call', lane: 'main' }),
  ])
  const owners = messages.map((e) => e.seq)
  let kept = 0
  for (const r of rows) {
    let owner: Seq | undefined
    for (const a of owners) if (a < r.seq) owner = a
    if (owner !== undefined) kept++
  }
  return kept
}

/** Metric 1: surfaceToolCalls at 500 / 2,000 / 5,000 calls, each on its own assistant message. */
async function toolCallSurface(): Promise<void> {
  for (const calls of [500, 2_000, 5_000]) {
    const { storage, cleanup } = sqlite()
    try {
      await storage.open('k', { writerRunId: 'bench', ttlMs: 3_600_000 })
      const events: PreparedEvent[] = []
      for (let i = 0; i < calls; i++) {
        events.push(row('assistant/message', { content: [], stopReason: 'tool_use' }, 3 * i))
        events.push(row('tool/call', { toolUseId: `t${i}`, name: 'read', args: {}, ordinal: i }, 3 * i + 1))
        events.push(row('tool/result', { toolUseId: `t${i}`, content: [] }, 3 * i + 2))
      }
      await commitAll(storage, 'k', events)
      const lastSeq = events.length
      const surface = Array.from({ length: calls }, (_, i) => ({ kind: 'assistant', seq: 3 * i + 1 }))
      const read = (q: ScanQuery) => storage.scan('k', q)
      const session = { lane: 'main', lastSeq, surface: () => surface, d: { log: { scan: read } } }
      let found = 0
      const merged = await time(async () => {
        found = (await surfaceToolCalls(session as never)).length
      })
      const nested = await time(() => nestedOwners(read, 1, lastSeq))
      console.log(
        `surfaceToolCalls calls=${calls} rows=${lastSeq} merged=${merged.toFixed(2)}ms nested=${nested.toFixed(2)}ms found=${found}`,
      )
    } finally {
      await cleanup()
    }
  }
}

/** Metric 2: a 500-row page, and a request-everything scan of exactly 500 rows (reads 501). */
async function pageOverhead(): Promise<void> {
  const { storage, cleanup } = sqlite()
  try {
    await storage.open('k', { writerRunId: 'bench', ttlMs: 3_600_000 })
    await commitAll(
      storage,
      'k',
      Array.from({ length: 5_000 }, (_, i) => row('user/message', { i }, i)),
    )
    const page = await time(async () => {
      for (let from = 1; from <= 5_000; from += 500) await storage.scan('k', { fromSeq: from, limit: 500 })
    })
    const bounded = await time(async () => {
      for (let from = 1; from <= 5_000; from += 500)
        await storage.scan('k', { fromSeq: from, toSeq: from + 499 })
    })
    console.log(
      `paging rows=5000 limit500=${page.toFixed(2)}ms toSeqOnly(+1 probe)=${bounded.toFixed(2)}ms delta=${(((bounded - page) / page) * 100).toFixed(1)}%`,
    )
  } finally {
    await cleanup()
  }
}

/** Extension event quota count (whole turn, under the phase lock) at 1k / 5k / 20k turn rows. */
async function extensionQuota(): Promise<void> {
  for (const rows of [1_000, 5_000, 20_000]) {
    const { storage, cleanup } = sqlite()
    try {
      const { session } = await openSession({ provider: fakeProvider([]), storage: storage as never })
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
      await session.acceptInput()
      const filler = Array.from({ length: rows }, (_, n) =>
        session.ev('x/agnes/bench/filler', { n }, { ignorable: true }),
      )
      for (let i = 0; i < filler.length; i += 1_000) await session.append(filler.slice(i, i + 1_000))
      const meta = { source: 'agnes/bench', trust: 'trusted' as const }
      let n = 0
      const ms = await time(() => session.appendExtensionEvent('x/agnes/bench/note', { n: n++ }, meta))
      console.log(`appendExtensionEvent turnRows=${rows} ${ms.toFixed(2)}ms`)
    } finally {
      await cleanup()
    }
  }
}

/** Auxiliary vision inspect over 1k / 5k / 20k earlier cost rows of other effects. */
async function auxiliaryInspect(): Promise<void> {
  for (const costs of [1_000, 5_000, 20_000]) {
    const { storage, cleanup } = sqlite()
    try {
      const { session } = await openSession({ provider: fakeProvider([]), storage: storage as never })
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
      await session.acceptInput()
      const tokens = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
      const rows = Array.from({ length: costs }, (_, n) =>
        session.ev('cost/ledger', {
          purpose: 'media',
          effectId: `aux:bench:${n}`,
          tokens,
          credits: 0,
          creditSource: 'estimated',
          model: 'vision-model',
          interrupted: false,
        }),
      )
      for (let i = 0; i < rows.length; i += 1_000) await session.append(rows.slice(i, i + 1_000))
      const port = createAuxiliaryVisionEffectPort(session as never)
      const hash = (d: string) => d.repeat(64)
      const binding = {
        effectId: 'aux:bench:target',
        sessionKey: session.key,
        lane: 'main',
        auditBindingHash: hash('a'),
        budgetBindingHash: hash('b'),
        mediaManifestHash: hash('c'),
        requestDerivedHash: hash('d'),
        model: 'vision-model',
      }
      await port.begin(binding)
      // begin() on an admitted effect is one inspect that finds it in progress.
      const ms = await time(() => port.begin(binding))
      console.log(`auxiliaryVision inspect costRows=${costs} ${ms.toFixed(2)}ms`)
    } finally {
      await cleanup()
    }
  }
}

console.log(`node ${process.version} runs=${runs} (median)`)
await toolCallSurface()
await pageOverhead()
await extensionQuota()
await auxiliaryInspect()
