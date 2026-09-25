// Measures what the ledger writes per tool call on the SQLite adapter: storage commits, rows by type,
// program-counter cell upserts and their bytes, table and index pages, the bytes the WAL took, and
// how long each commit and a whole four-call turn take. Prints counts, bytes and timings only, one
// JSON line per scenario, and runs unchanged before and after a change to where commits fall, so two
// outputs compare workload for workload.
//
//   tsx tools/bench-ledger-write.ts [--scenario <name>]... [--quick]
//
// The WAL is measured in segments: every SEGMENT commits, or sooner once it holds CUT_FRAMES frames,
// its size is read and a second connection truncates it, so the file never reaches the adapter's own
// auto-checkpoint. Each segment checks that it stayed under that threshold, and the run fails if one
// did not.
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import type { ModelRecord } from '@agnes/protocol'
import type { HostToolDispatchPort } from '../packages/core/src/effects/tool-dispatch.js'
import { defaultIds, openTracked, type StorageAdapter } from '../packages/core/src/index.js'
import { scanAll } from '../packages/core/src/log/scan-pages.js'
import type { CommitTx } from '../packages/core/src/log/storage.js'
import { ToolRegistry } from '../packages/core/src/registry/tools.js'
import type { EventInput } from '../packages/core/src/types.js'
import {
  actor,
  fakeProvider,
  MemoryStorage,
  openSession,
  readTool,
  type Script,
  sent,
  shellTool,
  textTurn,
  toolTurn,
  usage,
} from '../packages/core/testkit/index.js'
import { createSqliteStorage } from '../packages/host/src/index.js'

const quick = process.argv.includes('--quick')
const only = process.argv.flatMap((arg, index) =>
  arg === '--scenario' ? [process.argv[index + 1] as string] : [],
)

const SEGMENT = 100
const CUT_FRAMES = 500
/** SQLite's default auto-checkpoint threshold, in WAL frames. */
const AUTO_CHECKPOINT_FRAMES = 1000

const say = (text: string) => ({ content: [{ type: 'text' as const, text }], actor })
const turnEnd = () => ({ until: 'turn-end' as const, signal: new AbortController().signal })
const clock = () => 1_757_203_200_000

const batchTurn = (k: number): Script => [
  sent(),
  ...Array.from({ length: k }, (_, ordinal) => ({
    type: 'toolcall_end' as const,
    call: { toolUseId: '', name: 'read', args: { p: ordinal }, ordinal },
    via: 'native' as const,
  })),
  usage(),
  { type: 'done', reason: 'toolUse' },
]

const registryOf = (...tools: unknown[]): ToolRegistry => {
  const registry = new ToolRegistry()
  for (const tool of tools) registry.add(tool as never, { source: 's', trust: 'builtin' })
  return registry
}

/** Makes `count` nested `read` calls from inside its own execution, as code mode does. */
const nested = (count: number) => ({
  ...(readTool() as object),
  name: 'do_batch',
  execute: async (
    _args: unknown,
    ctx: { tools: { invoke(name: string, args: unknown): Promise<unknown> } },
  ) => {
    for (let i = 0; i < count; i++) await ctx.tools.invoke('read', { p: i })
    return { content: [{ type: 'text' as const, text: 'batch ok' }] }
  },
})

/** A model that accepts images, which a computer-use tool needs before it is offered. */
const imageModel: ModelRecord = {
  id: 'default',
  name: 'default',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
  slot: 'primary',
}

const computerTool = {
  name: 'computer_use',
  description: 'computer use',
  // The schema object of a tool that takes no arguments, borrowed so this file needs no schema library.
  parameters: (readTool() as unknown as { parameters: unknown }).parameters,
  meta: {
    isReadOnly: false,
    isDestructive: true,
    isConcurrencySafe: false,
    isOpenWorld: false,
    replay: 'never' as const,
    costHint: undefined,
    deferLoading: undefined,
    requiresApproval: 'never' as const,
  },
  execute: async () => ({ content: [{ type: 'text' as const, text: 'clicked' }] }),
}

/** A host port that always delivers the call and returns its result. */
const hostPort: HostToolDispatchPort = {
  dispatch: async (input) => ({ phase: 'responded', result: await input.invoke() }),
}

type Open = Parameters<typeof openSession>[0]
type Opener = (over: Omit<Open, 'storage'>) => ReturnType<typeof openSession>
/** A scenario may report its own timings, which are then printed with its counts. */
type Scenario = (
  open: Opener,
  storage: StorageAdapter,
  /** Starts counting commits, for a scenario that writes without opening a session through `open`. */
  count: () => void,
) => Promise<Record<string, unknown> | undefined>

const oneTurn =
  (k: number, text: string): Scenario =>
  async (open) => {
    const h = await open({
      provider: fakeProvider([batchTurn(k), textTurn('done')]),
      registry: registryOf(readTool()),
    })
    await h.session.enqueue('next-turn', say(text))
    await h.session.run(turnEnd())
    return undefined
  }

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number
}

const round = (ms: number) => Math.round(ms * 1000) / 1000

/** A session of `turns` one-call turns, as a long interactive session writes it. */
async function singleCallTurns(open: Opener, turns: number) {
  const script = Array.from({ length: turns }, () => [toolTurn('read', { p: 1 }), textTurn('ok')]).flat()
  const h = await open({ provider: fakeProvider(script), registry: registryOf(readTool()) })
  for (let t = 0; t < turns; t++) {
    await h.session.enqueue('next-turn', say(`turn ${t}`))
    await h.session.run(turnEnd())
  }
  return h
}

const SCENARIOS: Record<string, Scenario> = {
  k1: oneTurn(1, 'one call'),
  k4: oneTurn(4, 'four calls'),
  k16: oneTurn(16, 'sixteen calls'),
  async 'host-computer-use'(open) {
    const provider = fakeProvider([toolTurn('computer_use', {}), textTurn('done')])
    Object.assign(provider, { models: () => [imageModel] })
    const registry = new ToolRegistry()
    registry.add(computerTool as never, {
      source: 'agnes/computer-use',
      trust: 'builtin',
      packageIdentity: '@agnes/base',
      packageVersion: '1.0.0-bench',
      executionDomain: 'host-computer-use',
    })
    const h = await open({ provider, registry, hostToolDispatch: hostPort })
    await h.session.enqueue('next-turn', say('one host call'))
    await h.session.run(turnEnd())
    return undefined
  },
  // Code mode: fifty nested calls in one batch, then a call that asks for approval, then a stop
  // requested while a call runs.
  async 'nested-m50+approval+abort'(open) {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    let holding = false
    const h = await open({
      provider: fakeProvider([
        toolTurn('do_batch', {}),
        textTurn('nested done'),
        toolTurn('shell', { cmd: 'ls' }),
        textTurn('approved done'),
        batchTurn(2),
        textTurn('never'),
      ]),
      registry: registryOf(
        readTool(async (args) => {
          if (holding) {
            started()
            await held
          }
          return { content: [{ type: 'text' as const, text: `read:${JSON.stringify(args)}` }] }
        }),
        nested(50),
        shellTool(),
      ),
    })
    await h.session.enqueue('next-turn', say('code mode'))
    await h.session.run(turnEnd())
    await h.session.enqueue('next-turn', say('asks and is allowed'))
    await h.session.run(turnEnd())
    holding = true
    await h.session.enqueue('next-turn', say('stopped while a call runs'))
    const run = h.session.run(turnEnd())
    await running
    await h.session.abort(actor)
    release()
    await run
    return undefined
  },
  async 'long-270'(open) {
    await singleCallTurns(open, quick ? 20 : 270)
    return undefined
  },
  // Four-call turns back to back: the end-to-end time of each turn.
  async 'turn-k4'(open) {
    const turns = quick ? 5 : 40
    const script = Array.from({ length: turns }, () => [batchTurn(4), textTurn('done')]).flat()
    const h = await open({ provider: fakeProvider(script), registry: registryOf(readTool()) })
    const times: number[] = []
    for (let t = 0; t < turns; t++) {
      const t0 = performance.now()
      await h.session.enqueue('next-turn', say(`turn ${t}`))
      await h.session.run(turnEnd())
      times.push(performance.now() - t0)
    }
    return {
      turns,
      turnMs: { p50: round(percentile(times, 0.5)), p95: round(percentile(times, 0.95)) },
    }
  },
  // A native ledger of fifty one-call turns appended to a fresh session the way an import writes it:
  // whole turns, up to five hundred rows a batch. Only the write volume is of interest.
  async 'import-50'(_open, storage, count) {
    const source = new MemoryStorage()
    const h = await openSession({
      provider: fakeProvider(
        Array.from({ length: 50 }, () => [toolTurn('read', { p: 1 }), textTurn('ok')]).flat(),
      ),
      registry: registryOf(readTool()),
      storage: source,
      clock,
    })
    for (let t = 0; t < 50; t++) {
      await h.session.enqueue('next-turn', say(`turn ${t}`))
      await h.session.run(turnEnd())
    }
    const [start, ...rows] = await scanAll((q) => h.log.scan(q), { fromSeq: 1, toSeq: h.log.lastSeq })
    await h.session.close()
    const body = rows.map(({ seq: _seq, ...row }) => row as EventInput)
    const target = await openTracked({
      storage,
      key: 'imported',
      writerRunId: 'import',
      ttlMs: 60_000,
      ids: defaultIds(clock),
      clock,
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    })
    // The target holds only its own session start before the body lands, as an import target must.
    const { seq: _startSeq, ...opening } = start as NonNullable<typeof start>
    await target.log.append([opening as EventInput])
    count()
    const batches: EventInput[][] = []
    let batch: EventInput[] = []
    let turn: EventInput[] = []
    for (const row of body) {
      turn.push(row)
      if (row.type !== 'turn/end') continue
      if (batch.length > 0 && batch.length + turn.length > 500) {
        batches.push(batch)
        batch = []
      }
      batch.push(...turn)
      turn = []
    }
    if (batch.length + turn.length > 0) batches.push([...batch, ...turn])
    for (const b of batches) await target.log.append(b)
    await target.log.close()
    return { importedRows: body.length, importBatches: batches.length }
  },
}

type Op = { phase: { kind: string; batch?: { calls: Array<Record<string, unknown>> } } } | null
const TRACKED = ['status', 'dispatchPhase', 'dispatchAttempt'] as const

/** Which calls of a tools phase a commit moved: status or dispatch bookkeeping changed. */
function movedCalls(prev: Op, next: Op): string[] {
  if (prev?.phase.kind !== 'tools' || next?.phase.kind !== 'tools') return []
  const before = new Map((prev.phase.batch?.calls ?? []).map((call) => [call.toolUseId, call]))
  return (next.phase.batch?.calls ?? [])
    .filter((call) => {
      const was = before.get(call.toolUseId)
      return !was || TRACKED.some((field) => was[field] !== call[field])
    })
    .map((call) => String(call.toolUseId))
}

/** Every column of every row, as SQLite stores it. */
const ROW_BYTES = `COALESCE(LENGTH(session_key),0)+8+LENGTH(ts)+LENGTH(id)+LENGTH(type)+LENGTH(lane)+8+LENGTH(actor)+
  LENGTH(origin)+LENGTH(trust)+COALESCE(LENGTH(register),0)+COALESCE(LENGTH(surface_op),0)+
  COALESCE(LENGTH(source_event_seqs),0)+LENGTH(data)+COALESCE(LENGTH(integrity_mode),0)+
  COALESCE(LENGTH(integrity_prev),0)+COALESCE(LENGTH(integrity_digest),0)`

async function measure(name: string, scenario: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-bench-lw-'))
  const file = join(dir, 'sessions.db')
  try {
    const storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
    const side = new DatabaseSync(file)
    const pageSize = (side.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
    let counting = false
    let commits = 0
    let written = 0
    let walBytes = 0
    let walSegments = 0
    let walMaxFrames = 0
    let opCellUpserts = 0
    let opCellBytes = 0
    const commitMs: number[] = []
    const lastOp = new Map<string, Op>()
    const perCall = new Map<string, number>()
    const walSize = () => statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0
    const framesOf = (size: number) => (size > 32 ? Math.round((size - 32) / (pageSize + 24)) : 0)
    const cut = () => {
      const size = walSize()
      const frames = framesOf(size)
      walMaxFrames = Math.max(walMaxFrames, frames)
      walBytes += size
      walSegments++
      const r = side.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }
      if (r.busy !== 0) throw new Error(`${name}: WAL checkpoint was blocked`)
    }
    cut()
    walBytes = 0
    walSegments = 0
    const counted = new Proxy(storage, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown
        if (property === 'commit')
          return (key: string, tx: CommitTx) => {
            // The adapter commits synchronously inside the call; the promise only reports it.
            const t0 = performance.now()
            const result = (value as StorageAdapter['commit']).call(target, key, tx)
            const ms = performance.now() - t0
            if (counting) {
              commits++
              commitMs.push(ms)
              if (tx.opState) {
                opCellUpserts++
                opCellBytes += JSON.stringify(tx.opState.data).length
                const lane = `${key}\u0000${tx.opState.lane}`
                for (const id of movedCalls(lastOp.get(lane) ?? null, tx.opState.data as Op))
                  perCall.set(id, (perCall.get(id) ?? 0) + 1)
                lastOp.set(lane, tx.opState.data as Op)
              }
            }
            if (++written % SEGMENT === 0 || framesOf(walSize()) >= CUT_FRAMES) cut()
            return result
          }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const open: Opener = async (over) => {
      const h = await openSession({ ...over, storage: counted as never, clock })
      counting = true
      return h
    }
    const started = performance.now()
    const extra = await scenario(open, counted as StorageAdapter, () => {
      counting = true
    })
    const wallMs = performance.now() - started
    await storage.close()
    cut()
    side.close()
    if (walMaxFrames >= AUTO_CHECKPOINT_FRAMES)
      throw new Error(`${name}: a WAL segment reached ${walMaxFrames} frames; the measure is not exact`)
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const rowsByType: Record<string, number> = {}
      for (const row of db
        .prepare('SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY type')
        .all() as Array<{ type: string; n: number }>)
        rowsByType[row.type] = row.n
      const all = db
        .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(${ROW_BYTES}),0) AS b FROM events`)
        .get() as { n: number; b: number }
      const pages: Record<string, number> = {}
      for (const row of db
        .prepare(
          "SELECT name, COUNT(*) AS n FROM dbstat WHERE name IN ('events', 'sqlite_autoindex_events_1', 'events_type', 'registers', 'sqlite_autoindex_registers_1') GROUP BY name ORDER BY name",
        )
        .all() as Array<{ name: string; n: number }>)
        pages[row.name] = row.n
      const callCommits: Record<string, number> = {}
      for (const n of perCall.values()) callCommits[n] = (callCommits[n] ?? 0) + 1
      return {
        scenario: name,
        commits,
        rows: all.n,
        rowBytes: all.b,
        opMarkRows: rowsByType['x/core/op-mark'] ?? 0,
        rowsByType,
        opCellUpserts,
        opCellBytes,
        // Calls by how many commits moved them; a call no commit moved (a nested one) is not counted.
        callCommits,
        pages,
        walBytes,
        walSegments,
        walMaxFrames,
        commitMs: {
          p50: round(percentile(commitMs, 0.5)),
          p95: round(percentile(commitMs, 0.95)),
          max: round(Math.max(0, ...commitMs)),
        },
        wallMs: round(wallMs),
        ...(extra ?? {}),
      }
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const names = only.length > 0 ? only : Object.keys(SCENARIOS)
for (const name of names) {
  const scenario = SCENARIOS[name]
  if (!scenario) throw new Error(`unknown scenario ${name}; known: ${Object.keys(SCENARIOS).join(', ')}`)
  console.log(JSON.stringify(await measure(name, scenario)))
}
