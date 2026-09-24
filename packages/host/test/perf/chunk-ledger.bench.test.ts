import { appendFileSync, copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { defaultIds, type IdMinter, Kernel, openTracked, presetDefaults, type SessionImpl } from '@agnes/core'
import {
  actor,
  fakeProvider,
  fakeSeams,
  fencedFs,
  noTimers,
  readTool,
  type Script,
  sent,
  testFsPolicy,
  toolTurn,
  usage,
} from '@agnes/core/testkit'
import type { InferenceEvent, ModelRecord, Provider } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'

// What streamed model output costs the ledger: rows, bytes, commits and cold-open time for a session
// whose answers stream the way a real model does (a 40-character delta every 25 ms). Skipped unless
// AGNES_BENCH=1; it makes no assertion about the numbers and prints what it measured. Each turn is one
// tool call and one streamed answer.
const TURNS = Number(process.env.AGNES_BENCH_TURNS ?? 60)
const DELTAS = Number(process.env.AGNES_BENCH_DELTAS ?? 160)
const DELTA_MS = Number(process.env.AGNES_BENCH_DELTA_MS ?? 25)
const RUNS = Number(process.env.AGNES_BENCH_RUNS ?? 10)

const model = (): ModelRecord => ({
  id: 'm',
  name: 'm',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000_000,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})
const counterIds = (): IdMinter => {
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
const answer = (turn: number): Script => [
  sent(),
  ...Array.from({ length: DELTAS }, (_, i) => ({
    type: 'text_delta' as const,
    delta: `t${turn}p${i} ${'lorem ipsum dolor sit '.slice(0, 34)}`.padEnd(40, '.'),
  })),
  usage(),
  { type: 'done', reason: 'stop' },
]
/** Scripted turns whose text deltas arrive at a model's pace rather than all at once. */
function pacedProvider(turns: number): Provider {
  const scripts: Script[] = []
  for (let turn = 0; turn < turns; turn++) {
    scripts.push(toolTurn('read', { path: `src/file-${turn}.ts` }))
    scripts.push(answer(turn))
  }
  const inner = Object.assign(fakeProvider(scripts), { models: () => [model()] })
  return {
    models: () => [model()],
    async *infer(req, opts): AsyncIterable<InferenceEvent> {
      for await (const event of inner.infer(req, opts)) {
        if (event.type === 'text_delta') await new Promise((resolve) => setTimeout(resolve, DELTA_MS))
        yield event
      }
      inner.requests.splice(0)
    },
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

function kernel(storage: ReturnType<typeof createSqliteStorage>, provider: Provider) {
  const k = Kernel.create({
    storage,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits: 1_000_000_000, generationLimit: 3, maxFanOut: 1_000 },
    fsOps,
    netFetch: async () => new Response(''),
    logger: quiet,
    timers: noTimers,
    clock: () => Date.now(),
    ids: counterIds(),
  })
  k.tools.add(
    readTool(async (args) => ({
      content: [{ type: 'text', text: `${JSON.stringify(args)}\nconst x = 1\n` }],
    })),
    { source: 'bench', trust: 'builtin' },
  )
  return k
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] as number
}
const round = (x: number) => Math.round(x * 10) / 10

describe.runIf(process.env.AGNES_BENCH === '1')('streamed output on the ledger', () => {
  it(
    'measures rows, bytes, commits and cold open',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agnes-chunk-ledger-bench-'))
      try {
        const file = join(dir, 'sessions.db')
        const storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
        let commits = 0
        const commit = storage.commit.bind(storage)
        storage.commit = (key, tx) => {
          commits += 1
          return commit(key, tx)
        }
        const k = kernel(storage, pacedProvider(TURNS))
        const session = (await k.session('bench', {
          actor,
          resolvedProfileHash: 'h1',
          cwd: '/w',
          writerRunId: 'build',
        })) as SessionImpl
        const started = performance.now()
        for (let turn = 0; turn < TURNS; turn++) {
          await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: `request ${turn}` }] })
          const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
          expect(outcome.reason).toBe('completed')
        }
        const buildMs = performance.now() - started
        const lastSeq = session.lastSeq
        await session.close()
        await k.close()
        await storage.close()

        const db = new DatabaseSync(file)
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        const byType = db
          .prepare(
            `SELECT type, COUNT(*) AS n, SUM(length(data)) AS data,
               SUM(length(data) + length(id) + length(actor) + length(session_key) + length(ts)
                   + COALESCE(length(integrity_prev), 0) + COALESCE(length(integrity_digest), 0)) AS row
             FROM events WHERE session_key = ? GROUP BY type ORDER BY row DESC`,
          )
          .all('bench') as Array<{ type: string; n: number; data: number; row: number }>
        const compact = join(dir, 'compact.db')
        db.exec(`VACUUM INTO '${compact}'`)
        db.close()
        const packed = new DatabaseSync(compact)
        const objects = packed
          .prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC')
          .all() as Array<{ name: string; bytes: number }>
        packed.close()

        const runDir = mkdtempSync(join(tmpdir(), 'agnes-chunk-ledger-open-'))
        const copy = join(runDir, 'sessions.db')
        copyFileSync(file, copy)
        const reader = createSqliteStorage({ file: copy, tablesDir: join(runDir, 'tables') })
        const open: number[] = []
        for (let run = 0; run <= RUNS; run++) {
          const t = performance.now()
          const opened = await openTracked({
            storage: reader,
            key: 'bench',
            writerRunId: `open-${run}`,
            ttlMs: 60_000,
            ids: defaultIds(),
            clock: () => Date.now(),
            timers: noTimers,
          })
          const elapsed = performance.now() - t
          expect(opened.log.lastSeq).toBe(lastSeq)
          await opened.log.close()
          if (run > 0) open.push(elapsed)
        }
        await reader.close()
        rmSync(runDir, { recursive: true, force: true })

        const rows = byType.reduce((sum, t) => sum + t.n, 0)
        const report = `[chunk-ledger bench] ${JSON.stringify({
          node: process.version,
          turns: TURNS,
          deltasPerAnswer: DELTAS,
          deltaMs: DELTA_MS,
          buildSeconds: round(buildMs / 1000),
          rows,
          commits,
          fileBytesAfterVacuum: existsSync(compact) ? statSync(compact).size : 0,
          objects,
          byType,
          coldOpenP50Ms: round(pct(open, 0.5)),
          coldOpenP95Ms: round(pct(open, 0.95)),
        })}`
        console.log(report)
        if (process.env.AGNES_BENCH_OUT) appendFileSync(process.env.AGNES_BENCH_OUT, `${report}\n`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30 * 60_000,
  )
})
