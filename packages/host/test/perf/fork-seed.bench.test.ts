import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { type IdMinter, Kernel, presetDefaults, type Seq, type SessionImpl } from '@agnes/core'
import {
  actor,
  fakeProvider,
  fakeSeams,
  fencedFs,
  noTimers,
  testFsPolicy,
  textTurn,
} from '@agnes/core/testkit'
import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'

// Delegated child creation against large parents on SQLite. Skipped unless AGNES_BENCH=1; it makes no
// timing assertion and only prints what it measured. Parents are built from ignorable extension rows,
// "large" rows standing in for tool-heavy history (about 800 bytes each) and "small" ones for
// chunk-heavy history, so a parent of any length can be written quickly.
const RUNS = Number(process.env.AGNES_BENCH_RUNS ?? 5)
const SIZES = (process.env.AGNES_BENCH_SIZES ?? '10000,30000,60000,100000').split(',').map(Number)
const TURN_ROWS = [0, 500, 2_000]

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
const ids = (): IdMinter => {
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
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

function kernel(storage: ReturnType<typeof createSqliteStorage>) {
  const provider = Object.assign(fakeProvider([textTurn('x')]), { models: () => [model()] })
  return Kernel.create({
    storage,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits: 1_000_000, generationLimit: 3, maxFanOut: 1_000 },
    fsOps,
    netFetch: async () => new Response(''),
    logger: quiet,
    timers: noTimers,
    clock: () => Date.now(),
    ids: ids(),
  })
}

type CreateOpts = Parameters<NonNullable<SessionImpl['d']['children']['createWithKind']>>[1]
function createChild(from: SessionImpl, kind: 'fork' | 'spawn', opts: CreateOpts) {
  const create = from.d.children.createWithKind
  if (!create) throw new Error('this child factory cannot create by kind')
  return create.call(from.d.children, kind, opts)
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] as number
}
const ms = (x: number) => Math.round(x * 10) / 10

async function measured<T>(fn: () => Promise<T>) {
  const delay = monitorEventLoopDelay({ resolution: 1 })
  const rss = process.memoryUsage().rss
  delay.enable()
  const start = performance.now()
  const value = await fn()
  const elapsed = performance.now() - start
  delay.disable()
  return {
    value,
    elapsed,
    loopMax: delay.max / 1e6,
    loopP99: delay.percentile(99) / 1e6,
    rssMb: (process.memoryUsage().rss - rss) / 2 ** 20,
  }
}

describe.runIf(process.env.AGNES_BENCH === '1')('delegated child creation against large parents', () => {
  for (const size of SIZES)
    for (const load of ['large', 'small'] as const)
      for (const turnRows of TURN_ROWS)
        it(`parent ${size} ${load} rows, ${turnRows} rows in the open turn`, async () => {
          const dir = mkdtempSync(join(tmpdir(), 'agnes-fork-bench-'))
          const storage = createSqliteStorage({
            file: join(dir, 'sessions.db'),
            tablesDir: join(dir, 'tables'),
          })
          try {
            const k = kernel(storage)
            const parent = await k.session('parent', {
              actor,
              resolvedProfileHash: 'h1',
              cwd: '/w',
              writerRunId: 'r',
            })
            const pad = load === 'large' ? 'x'.repeat(800) : 'x'
            const fill = async (n: number) => {
              for (let i = 0; i < n; i += 1_000)
                await parent.append(
                  Array.from({ length: Math.min(1_000, n - i) }, (_, j) =>
                    parent.ev('x/agnes/bench/row', { n: i + j, pad }, { ignorable: true }),
                  ),
                )
            }
            await fill(size)
            await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'delegate' }], actor })
            await parent.acceptInput()
            await fill(turnRows)
            const results: Record<string, number[][]> = { fork: [], spawn: [] }
            for (const kind of ['fork', 'spawn'] as const)
              for (let run = 0; run <= RUNS; run++) {
                // spawn forks one row before the head, so the rows after the fork point are read.
                const m = await measured(() =>
                  createChild(parent, kind, {
                    parent: parent.key,
                    cwd: '/w',
                    input: `${kind} ${run}`,
                    ...(kind === 'spawn' ? { forkAt: parent.lastSeq - 1 } : {}),
                  }),
                )
                const child = k.get(m.value.key)
                await child?.close()
                if (run > 0) results[kind]?.push([m.elapsed, m.loopMax, m.loopP99, m.rssMb])
              }
            // The cost the old path paid: the same delegated child opened cold, with full verification.
            const cold: number[] = []
            if (turnRows === 0) {
              const childKey = parent.key
              for (let run = 0; run <= Math.min(RUNS, 2); run++) {
                const handle = await createChild(parent, 'fork', {
                  parent: childKey,
                  cwd: '/w',
                  input: `cold ${run}`,
                })
                const live = k.get(handle.key) as SessionImpl
                const b = live.d.log.parent?.boundarySeq as Seq
                await live.close()
                const m = await measured(() =>
                  k.session(handle.key, {
                    actor,
                    resolvedProfileHash: 'h1',
                    cwd: '/w',
                    writerRunId: `cold-${run}`,
                  }),
                )
                expect(m.value.d.log.parent?.boundarySeq).toBe(b)
                await m.value.close()
                if (run > 0) cold.push(m.elapsed)
              }
            }
            const line = (kind: 'fork' | 'spawn') => {
              const rows = results[kind] ?? []
              const col = (i: number) => rows.map((r) => r[i] as number)
              return `${kind}: median ${ms(pct(col(0), 0.5))} ms, p95 ${ms(pct(col(0), 0.95))} ms, loop max ${ms(Math.max(...col(1)))} ms, loop p99 ${ms(pct(col(2), 0.99))} ms, rss +${ms(pct(col(3), 0.5))} MB`
            }
            console.log(
              `[fork-seed bench] parent=${size} load=${load} turnRows=${turnRows} lastSeq=${parent.lastSeq} | ${line('fork')} | ${line('spawn')}${cold.length ? ` | cold open median ${ms(pct(cold, 0.5))} ms` : ''}`,
            )
            await k.close()
          } finally {
            await storage.close().catch(() => undefined)
            rmSync(dir, { recursive: true, force: true })
          }
        }, 600_000)
})
