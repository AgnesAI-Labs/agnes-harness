// M0 for the program counter leaving the ledger rows. Runs a set of scripted sessions against the
// SQLite adapter and prints only counts, bytes and timings: program-counter rows and op-mark rows,
// event table and index pages, the WAL high-water size, the bytes the program counter's register
// cell took per upsert, and the verify / cold-fold time of a long session. Runs unchanged on the
// build before the switch, so the two outputs compare workload for workload.
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { defaultIds, openTracked, type StorageAdapter, verifyLedger } from '../packages/core/src/index.js'
import { ToolRegistry } from '../packages/core/src/registry/tools.js'
import {
  actor,
  fakeProvider,
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

type Open = Parameters<typeof openSession>[0]
type Scenario = (open: (over: Omit<Open, 'storage'>) => ReturnType<typeof openSession>) => Promise<void>

const SCENARIOS: Record<string, Scenario> = {
  async 'batch-k1'(open) {
    const h = await open({
      provider: fakeProvider([batchTurn(1), textTurn('done')]),
      registry: registryOf(readTool()),
    })
    await h.session.enqueue('next-turn', say('one call'))
    await h.session.run(turnEnd())
  },
  async 'batch-k4'(open) {
    const h = await open({
      provider: fakeProvider([batchTurn(4), textTurn('done')]),
      registry: registryOf(readTool()),
    })
    await h.session.enqueue('next-turn', say('four calls'))
    await h.session.run(turnEnd())
  },
  async 'batch-k16'(open) {
    const h = await open({
      provider: fakeProvider([batchTurn(16), textTurn('done')]),
      registry: registryOf(readTool()),
    })
    await h.session.enqueue('next-turn', say('sixteen calls'))
    await h.session.run(turnEnd())
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
  },
}

type Measured = {
  rows: number
  rowBytes: number
  opStateRows: number
  opStateBytes: number
  opStateRowBytes: number
  opMarkRows: number
  opMarkBytes: number
  opMarkRowBytes: number
  pages: Record<string, number>
  walBytes: number
  opCellUpserts: number
  opCellBytes: number
}

/** Every column of every row, as SQLite stores it. */
const ROW_BYTES = `COALESCE(LENGTH(session_key),0)+8+LENGTH(ts)+LENGTH(id)+LENGTH(type)+LENGTH(lane)+8+LENGTH(actor)+
  LENGTH(origin)+LENGTH(trust)+COALESCE(LENGTH(register),0)+COALESCE(LENGTH(surface_op),0)+
  COALESCE(LENGTH(source_event_seqs),0)+LENGTH(data)+COALESCE(LENGTH(integrity_mode),0)+
  COALESCE(LENGTH(integrity_prev),0)+COALESCE(LENGTH(integrity_digest),0)`

async function measure(scenario: Scenario): Promise<Measured> {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-bench-op-'))
  const file = join(dir, 'sessions.db')
  try {
    const storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
    let opCellUpserts = 0
    let opCellBytes = 0
    // The program counter's register cell: written from a row before the switch, beside it after.
    const counted = new Proxy(storage, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown
        if (property === 'commit')
          return (key: string, tx: Parameters<StorageAdapter['commit']>[1]) => {
            const written = [
              ...(tx.events ?? []).filter((e) => e.register === 'op.state').map((e) => e.data),
              ...('opState' in tx && tx.opState ? [(tx.opState as { data: unknown }).data] : []),
            ]
            for (const data of written) {
              opCellUpserts++
              opCellBytes += JSON.stringify(data).length
            }
            return (value as StorageAdapter['commit']).call(target, key, tx)
          }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await scenario((over) => openSession({ ...over, storage: counted as never, clock }))
    const walBytes = statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0
    await storage.close()
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const by = (type: string) =>
        db
          .prepare(
            `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)),0) AS b, COALESCE(SUM(${ROW_BYTES}),0) AS r FROM events WHERE type = ?`,
          )
          .get(type) as { n: number; b: number; r: number }
      const all = db
        .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(${ROW_BYTES}),0) AS b FROM events`)
        .get() as {
        n: number
        b: number
      }
      const pages: Record<string, number> = {}
      for (const row of db
        .prepare(
          "SELECT name, COUNT(*) AS n FROM dbstat WHERE name IN ('events', 'sqlite_autoindex_events_1', 'events_type') GROUP BY name",
        )
        .all() as Array<{ name: string; n: number }>)
        pages[row.name] = row.n
      const opState = by('op.state')
      const opMark = by('x/core/op-mark')
      return {
        rows: all.n,
        rowBytes: all.b,
        opStateRows: opState.n,
        opStateBytes: opState.b,
        opStateRowBytes: opState.r,
        opMarkRows: opMark.n,
        opMarkBytes: opMark.b,
        opMarkRowBytes: opMark.r,
        pages,
        walBytes,
        opCellUpserts,
        opCellBytes,
      }
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A session of `turns` one-call turns; the verify and the cold fold of its whole ledger, best of three. */
async function longSession(turns: number) {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-bench-op-long-'))
  const file = join(dir, 'sessions.db')
  try {
    const storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
    const script = Array.from({ length: turns }, () => [toolTurn('read', { p: 1 }), textTurn('ok')]).flat()
    const h = await openSession({
      provider: fakeProvider(script),
      registry: registryOf(readTool()),
      storage: storage as never,
      clock,
    })
    for (let t = 0; t < turns; t++) {
      await h.session.enqueue('next-turn', say(`turn ${t}`))
      await h.session.run(turnEnd())
    }
    const rows = h.log.lastSeq
    await h.session.close()
    const cold = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'foldCache') return undefined
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as StorageAdapter
    let verifyMs = Number.POSITIVE_INFINITY
    let coldOpenMs = Number.POSITIVE_INFINITY
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now()
      await verifyLedger(storage, 'k', rows)
      verifyMs = Math.min(verifyMs, performance.now() - t0)
      const t1 = performance.now()
      const opened = await openTracked({
        storage: cold,
        key: 'k',
        writerRunId: `bench-${run}`,
        ttlMs: 60_000,
        ids: defaultIds(clock),
        clock,
        timers: { setTimeout: () => 0, clearTimeout: () => undefined },
      })
      coldOpenMs = Math.min(coldOpenMs, performance.now() - t1)
      await opened.log.close()
    }
    await storage.close()
    return { turns, rows, verifyMs: Math.round(verifyMs), coldOpenMs: Math.round(coldOpenMs) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const turnsIndex = process.argv.indexOf('--long-turns')
const longTurns = turnsIndex < 0 ? 400 : Number(process.argv[turnsIndex + 1])
for (const [name, scenario] of Object.entries(SCENARIOS))
  console.log(JSON.stringify({ scenario: name, ...(await measure(scenario)) }))
console.log(JSON.stringify({ scenario: 'long', ...(await longSession(longTurns)) }))
