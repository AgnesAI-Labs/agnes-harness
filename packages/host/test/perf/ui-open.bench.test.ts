import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
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
import type { ModelRecord, Provider } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'

// Cold-open cost of a long session on SQLite, before and after a change to how the UI projection is
// rebuilt. Skipped unless AGNES_BENCH=1; it makes no timing assertion and prints what it measured.
// Sessions are produced by real turns (two tool calls and a streamed answer per turn) so every row
// kind a UI projection folds is present. Text is ASCII only.
const RUNS = Number(process.env.AGNES_BENCH_RUNS ?? 20)
const SIZES = (process.env.AGNES_BENCH_SIZES ?? '3000,30000,100000').split(',').map(Number)
// Tool-heavy sessions: ten tool calls per turn and a short streamed answer, built up to this many calls.
const TOOL_CALLS = (process.env.AGNES_BENCH_TOOL_CALLS ?? '2000,4000').split(',').map(Number)
type Shape = { toolsPerTurn: number; answerParts: number }
const MIXED: Shape = { toolsPerTurn: 2, answerParts: 6 }
const TOOL_HEAVY: Shape = { toolsPerTurn: 10, answerParts: 2 }

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
const answer = (turn: number, parts: number): Script => [
  sent(),
  ...Array.from({ length: parts }, (_, i) => ({
    type: 'text_delta' as const,
    delta: `turn ${turn} part ${i} ${'lorem ipsum dolor sit amet '.repeat(24)}`,
  })),
  usage(),
  { type: 'done', reason: 'stop' },
]
/** `shape.toolsPerTurn` tool calls, then a streamed answer, for each of `turns` turns. */
function scriptedProvider(turns: number, shape: Shape): Provider {
  const scripts: Script[] = []
  for (let turn = 0; turn < turns; turn++) {
    for (let call = 0; call < shape.toolsPerTurn; call++)
      scripts.push(toolTurn('read', { path: `src/file-${turn}-${call}.ts`, lines: 200 }))
    scripts.push(answer(turn, shape.answerParts))
  }
  return Object.assign(fakeProvider(scripts), { models: () => [model()] })
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

function kernel(storage: ReturnType<typeof createSqliteStorage>, provider = scriptedProvider(0, MIXED)) {
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
      content: [{ type: 'text', text: `${JSON.stringify(args)}\n${'const x = 1\n'.repeat(60)}` }],
    })),
    { source: 'bench', trust: 'builtin' },
  )
  return k
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] as number
}
const ms = (x: number) => Math.round(x * 10) / 10
const fileBytes = (file: string) =>
  (existsSync(file) ? statSync(file).size : 0) +
  (existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0)
const gc = (globalThis as { gc?: () => void }).gc

async function build(dir: string, stop: { rows?: number; toolCalls?: number }, shape: Shape) {
  const file = join(dir, 'sessions.db')
  const storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
  const turns = stop.toolCalls
    ? Math.ceil(stop.toolCalls / shape.toolsPerTurn)
    : Math.ceil((stop.rows ?? 0) / 10) + 10
  const provider = scriptedProvider(turns, shape)
  const k = kernel(storage, provider)
  const session = (await k.session('bench', {
    actor,
    resolvedProfileHash: 'h1',
    cwd: '/w',
    writerRunId: 'build',
  })) as SessionImpl
  let turn = 0
  const growth: number[] = []
  let mark = { seq: session.lastSeq, bytes: fileBytes(file) }
  while (stop.toolCalls ? turn * shape.toolsPerTurn < stop.toolCalls : session.lastSeq < (stop.rows ?? 0)) {
    await session.enqueue('next-turn', {
      actor,
      content: [{ type: 'text', text: `request ${turn} ${'please look at the code '.repeat(8)}` }],
    })
    const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    // The test provider keeps every request body it was sent; drop them so a long build fits in memory.
    ;(provider as { requests?: unknown[] }).requests?.splice(0)
    expect(outcome.reason).toBe('completed')
    turn += 1
    if (session.lastSeq - mark.seq >= 1_000) {
      const bytes = fileBytes(file)
      growth.push(((bytes - mark.bytes) / (session.lastSeq - mark.seq)) * 1_000)
      mark = { seq: session.lastSeq, bytes }
    }
  }
  const lastSeq = session.lastSeq
  // Close writes whatever durable projection state the implementation keeps, so the measured opens
  // start from the freshest state it can have.
  await session.close()
  await k.close()
  await storage.close()
  const db = new DatabaseSync(file)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const tables = db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table') as {
    name: string
  }[]
  const uiCacheBytes = tables.some((t) => t.name === 'ui_projection_cache')
    ? ((
        db
          .prepare(
            'SELECT COALESCE(SUM(length(payload)), 0) AS n FROM ui_projection_cache WHERE session_key = ?',
          )
          .get('bench') as { n: number }
      ).n ?? 0)
    : 0
  db.close()
  return {
    file,
    lastSeq,
    turns: turn,
    toolCalls: turn * shape.toolsPerTurn,
    growthPer1000: pct(growth, 0.5),
    uiCacheBytes,
  }
}

async function measure(label: string, built: Awaited<ReturnType<typeof build>>) {
  const runDir = mkdtempSync(join(tmpdir(), 'agnes-ui-open-run-'))
  const file = join(runDir, 'sessions.db')
  copyFileSync(built.file, file)
  const storage = createSqliteStorage({ file, tablesDir: join(runDir, 'tables') })
  try {
    const open: number[] = []
    const reopen: number[] = []
    const firstScreen: number[] = []
    let heapMb = 0
    let uiAppliedOnOpen = -1
    // One untimed open first: it pays any one-off storage migration.
    for (let run = 0; run <= RUNS; run++) {
      gc?.()
      const heapBefore = process.memoryUsage().heapUsed
      const t = performance.now()
      const opened = await openTracked({
        storage,
        key: 'bench',
        writerRunId: `open-${run}`,
        ttlMs: 60_000,
        ids: defaultIds(),
        clock: () => Date.now(),
        timers: noTimers,
      })
      const elapsed = performance.now() - t
      expect(opened.log.lastSeq).toBe(built.lastSeq)
      heapMb = Math.max(heapMb, (process.memoryUsage().heapUsed - heapBefore) / 2 ** 20)
      uiAppliedOnOpen = opened.ui.diagnostics().applied
      await opened.log.close()
      if (run > 0) open.push(elapsed)
    }
    const k = kernel(storage)
    for (let run = 0; run <= Math.min(RUNS, 10); run++) {
      const t = performance.now()
      const session = (await k.session('bench', {
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: `wake-${run}`,
      })) as SessionImpl
      const woke = performance.now() - t
      const page = await session.projectUIOpening({ maxNodes: 500, maxBytes: 1024 * 1024 })
      const shown = performance.now() - t
      expect(page.timeline.nodes.length).toBeGreaterThan(0)
      await session.close()
      if (run > 0) {
        reopen.push(woke)
        firstScreen.push(shown)
      }
    }
    await k.close()
    console.log(
      `[ui-open bench] ${JSON.stringify({
        node: process.version,
        session: label,
        rows: built.lastSeq,
        toolCalls: built.toolCalls,
        turns: built.turns,
        dbMiB: ms(statSync(built.file).size / 2 ** 20),
        uiCacheKiB: ms(built.uiCacheBytes / 1024),
        uiAppliedOnOpen,
        growthBytesPer1000Events: Math.round(built.growthPer1000),
        openP50: ms(pct(open, 0.5)),
        openP95: ms(pct(open, 0.95)),
        kernelReopenP50: ms(pct(reopen, 0.5)),
        kernelReopenP95: ms(pct(reopen, 0.95)),
        firstScreenP50: ms(pct(firstScreen, 0.5)),
        firstScreenP95: ms(pct(firstScreen, 0.95)),
        openHeapMiB: gc ? ms(heapMb) : 'run with --expose-gc',
      })}`,
    )
  } finally {
    await storage.close().catch(() => undefined)
    rmSync(runDir, { recursive: true, force: true })
  }
}

describe.runIf(process.env.AGNES_BENCH === '1')('cold open of a long session', () => {
  for (const size of SIZES)
    it(`${size} rows`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agnes-ui-open-bench-'))
      try {
        await measure('mixed', await build(dir, { rows: size }, MIXED))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 3_600_000)
  for (const calls of TOOL_CALLS)
    it(`${calls} tool calls`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agnes-ui-open-bench-'))
      try {
        await measure('tool-heavy', await build(dir, { toolCalls: calls }, TOOL_HEAVY))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 3_600_000)
})
