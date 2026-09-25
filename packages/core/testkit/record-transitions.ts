// Records, commit by commit, what a set of scripted sessions writes: the batch of rows, the
// program-counter value each batch carries, every register cell after the commit and the UI
// summary of the running operation. The checked-in recordings under `fixtures/op-state-golden/`
// were made by the build that still wrote the program counter as a ledger row; they are frozen, and
// `expectedFromGolden` says what the current format must commit in their place.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { InferenceEvent, Provider } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { scanAll } from '../src/log/scan-pages.js'
import type { SessionLogImpl } from '../src/log/session-log.js'
import type { CommitTx, OpWrite, StorageAdapter } from '../src/log/storage.js'
import type { UIProjectionCell } from '../src/project/ui.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { type OpStateObj, opMarkData } from '../src/step/op-state.js'
import type { CompactionPort } from '../src/step/session.js'
import type { Event, IdMinter } from '../src/types.js'
import {
  fakeProvider,
  type Script,
  sent,
  sentFor,
  textTurn,
  toolTurn,
  usage,
} from '../test/helpers/fake-provider.js'
import { fakeSeams } from '../test/helpers/fake-seams.js'
import { actor, openSession, readTool, shellTool } from '../test/helpers/open-session.js'

type Cell = { register: string; key: string; seq: number; data: unknown }

export type RecordedCommit = {
  /** Every committed row, without the per-row timestamp and id. */
  events: unknown[]
  /** The program-counter value this commit wrote, per lane. */
  op: Array<{ lane: string; data: unknown }>
  /** The program-counter cells after the commit, by lane. */
  opCells: Array<{ key: string; seq: number; data: unknown }>
  /** Every other register cell after the commit, in a stable order. */
  registers: Cell[]
  /** The UI summary of the running operation at the head right after the commit. */
  uiOpState: unknown
}

/**
 * One commit of the checked-in reference, recorded by the build that still wrote the program
 * counter as an `op.state` row after the commit's other rows. `events` leaves that row out.
 */
export type GoldenCommit = {
  events: unknown[]
  op: Array<{ lane: string; data: unknown }>
  registers: Cell[]
  uiOpState: unknown
}

const goldenDir = new URL('../fixtures/op-state-golden/', import.meta.url)

/** Stable ids, so two runs of one scenario record the same bytes. */
const stableIds = (): IdMinter => {
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

/** Durations are wall-clock measurements and the only row content that differs between runs. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'durationMs')
        .map(([key, inner]) => [key, stable(inner)]),
    )
  return value
}

const toolMeta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe' as const,
  costHint: undefined,
  deferLoading: undefined,
  requiresApproval: undefined,
}

/** Makes `count` nested `read` calls from inside its own execution, as code mode does. */
const nestedTool = (count: number) =>
  ({
    name: 'do_batch',
    description: 'runs a compound step; invokes `read` as nested calls along the way',
    parameters: Type.Object({}),
    meta: toolMeta,
    execute: async (
      _args: unknown,
      ctx: { tools: { invoke(name: string, args: unknown): Promise<unknown> } },
    ) => {
      for (let i = 0; i < count; i++) await ctx.tools.invoke('read', { p: i })
      return { content: [{ type: 'text' as const, text: 'batch ok' }] }
    },
  }) as never

const deferredTool = () =>
  ({
    name: 'export_job',
    description: 'submits an artifact job and returns before that job is complete',
    parameters: Type.Object({}),
    meta: { ...toolMeta, replay: 'idempotent' as const },
    execute: async (_args: unknown, ctx: { artifacts: { submitJob(spec: unknown): Promise<string> } }) => {
      const jobId = await ctx.artifacts.submitJob({
        idempotencyKey: 'golden-job',
        payload: { kind: 'shell', command: 'printf golden', cwd: '/w' },
      })
      return { content: [{ type: 'text' as const, text: 'queued' }], deferred: { jobId } }
    },
  }) as never

/** A tool that stays in flight until released, so a stop request lands while it runs. */
function heldRead() {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  const tool = readTool(async () => {
    started()
    await held
    return { content: [{ type: 'text' as const, text: 'late' }] }
  })
  return { tool, release: () => release(), running }
}

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

const turnEnd = () => ({ until: 'turn-end' as const, signal: new AbortController().signal })
const say = (text: string) => ({ content: [{ type: 'text' as const, text }], actor })

type Opened = Awaited<ReturnType<typeof openSession>>
type Open = (over: Omit<Parameters<typeof openSession>[0], 'storage' | 'ids'>) => Promise<Opened>
/** Records one batch that was committed where no observer could see it, such as a fork's first. */
type Record_ = (log: SessionLogImpl, events: Event[]) => void

/** A model that says it sent the request and never answers, so the turn stays in inference. */
const hanging = (): Provider => ({
  models: () => [],
  async *infer(req): AsyncIterable<InferenceEvent> {
    yield sentFor(req)
    await new Promise<void>(() => undefined)
  },
})

const opener = (writerRunId: string) => ({
  actor,
  agnesVersion: '0.0.1',
  preset: 'standard',
  resolvedProfileHash: null,
  writerRunId,
  lane: 'main',
})

/** Forks a child at the parent's head, mid-turn, and records the child's first batch. */
async function forkMidTurn(open: Open, record: Record_, delegated: boolean): Promise<void> {
  const h = await open({ provider: hanging(), registry: registryOf(readTool()) })
  await h.session.enqueue('next-turn', say('forked while the model is thinking'))
  await h.session.step()
  await h.session.step()
  const boundary = h.log.lastSeq
  const child = await h.log.forkInto(boundary, 'child', {
    ...opener('child-run'),
    ...(delegated
      ? { delegation: { kind: 'spawn' as const, creationId: 'c1', rootTaskId: 'root', generationDepth: 1 } }
      : {}),
  })
  record(child, await scanAll((q) => child.scan(q), { fromSeq: boundary + 1, toSeq: child.lastSeq }))
  await child.close()
}

const registryOf = (...tools: unknown[]): ToolRegistry => {
  const registry = new ToolRegistry()
  for (const tool of tools) registry.add(tool as never, { source: 's', trust: 'builtin' })
  return registry
}

const SCENARIOS: Record<string, (open: Open, record: Record_) => Promise<void>> = {
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
  async 'batch-k8'(open) {
    const h = await open({
      provider: fakeProvider([batchTurn(8), textTurn('done')]),
      registry: registryOf(readTool()),
    })
    await h.session.enqueue('next-turn', say('eight calls'))
    await h.session.run(turnEnd())
  },
  async 'nested-m6'(open) {
    const h = await open({
      provider: fakeProvider([toolTurn('do_batch', {}), textTurn('done')]),
      registry: registryOf(readTool(), nestedTool(6)),
    })
    await h.session.enqueue('next-turn', say('code mode'))
    await h.session.run(turnEnd())
  },
  async 'approval-sync'(open) {
    const h = await open({
      provider: fakeProvider([toolTurn('shell', { cmd: 'ls' }), textTurn('done')]),
      registry: registryOf(shellTool()),
    })
    await h.session.enqueue('next-turn', say('asks and is allowed at once'))
    await h.session.run(turnEnd())
  },
  async 'approval-parked'(open) {
    const receipts = new Map<string, { requestId: string; bindingHash: string; expiresAt: string }>()
    const expiresAt = new Date(1_757_203_200_000 + 60_000).toISOString()
    const seams = fakeSeams({
      approval: {
        ask: async (req) => {
          receipts.set('golden-ticket', { requestId: req.requestId, bindingHash: req.bindingHash, expiresAt })
          return { ticket: 'golden-ticket', expiresAt }
        },
        resume: async (ticket) => receipts.get(ticket) ?? null,
      },
    })
    const h = await open({
      provider: fakeProvider([toolTurn('shell', { cmd: 'ls' }), textTurn('done')]),
      registry: registryOf(shellTool()),
      seams,
    })
    await h.session.enqueue('next-turn', say('parks for approval'))
    await h.session.run(turnEnd())
    await h.session.resumeApproval('golden-ticket', 'allowed-once', { ...actor, id: 'approver' })
    await h.session.run(turnEnd())
  },
  async 'abort-with-pending'(open) {
    const held = heldRead()
    const h = await open({
      provider: fakeProvider([batchTurn(2), textTurn('never')]),
      registry: registryOf(held.tool),
    })
    await h.session.enqueue('next-turn', say('stopped while a call runs'))
    const running = h.session.run(turnEnd())
    await held.running
    await h.session.abort(actor)
    held.release()
    await running
  },
  async 'abort-without-pending'(open) {
    const h = await open({ provider: fakeProvider([textTurn('never')]), registry: registryOf(readTool()) })
    await h.session.enqueue('next-turn', say('stopped before anything runs'))
    await h.session.step()
    await h.session.abort(actor)
    await h.session.run(turnEnd())
  },
  async 'compaction-threshold'(open) {
    const compaction: CompactionPort = { shouldCompact: () => true, onOverflow: () => 'failure' }
    const h = await open({
      provider: fakeProvider([textTurn('after compaction')]),
      registry: registryOf(readTool()),
      compaction,
    })
    await h.session.enqueue('next-turn', say('compacts first'))
    await h.session.run(turnEnd())
  },
  async deferred(open) {
    const timers = {
      setTimeout: (fn: () => void, ms: number) => {
        // Only the deferred wait fires; the much longer writer-lease renewal stays dormant.
        if (ms === 2_000) queueMicrotask(fn)
        return 0
      },
      clearTimeout: () => undefined,
    }
    const h = await open({
      provider: fakeProvider([toolTurn('export_job', {}), textTurn('after job')]),
      registry: registryOf(deferredTool()),
      timers,
    })
    await h.session.enqueue('next-turn', say('waits for an external job'))
    await h.session.run(turnEnd())
  },
  async 'fork-child'(open, record) {
    await forkMidTurn(open, record, false)
  },
  async 'subagent-child'(open, record) {
    await forkMidTurn(open, record, true)
  },
  async 'compaction-manual'(open) {
    const h = await open({
      provider: fakeProvider([textTurn('before'), textTurn('after')]),
      registry: registryOf(readTool()),
    })
    await h.session.enqueue('next-turn', say('something to compact'))
    await h.session.run(turnEnd())
    await h.session.requestCompaction({ actor, admissionId: 'golden-compaction' })
    await h.session.run(turnEnd())
  },
  async 'side-lane'(open) {
    const h = await open({
      provider: fakeProvider([batchTurn(2), textTurn('done')]),
      registry: registryOf(readTool()),
      lane: 'side',
    })
    await h.session.enqueue('next-turn', say('on another lane'))
    await h.session.run(turnEnd())
  },
  async 'inference-retry'(open) {
    let now = 1_757_203_200_000
    const h = await open({
      provider: fakeProvider([
        [sent(), { type: 'error', reason: 'error', code: 'RATE_LIMIT', message: 'slow', retryable: true }],
        textTurn('ok'),
      ]),
      registry: registryOf(readTool()),
      clock: () => now,
      timers: {
        // The backoff wait fires at once and moves the clock past it; the much longer writer-lease
        // renewal stays dormant.
        setTimeout: (fn: () => void, ms: number) => {
          if (ms <= 10_000) {
            now += ms
            queueMicrotask(fn)
          }
          return 0
        },
        clearTimeout: () => undefined,
      },
    })
    await h.session.enqueue('next-turn', say('retried once'))
    await h.session.run(turnEnd())
  },
  async 'failure-drain'(open) {
    const h = await open({
      provider: fakeProvider([
        [sent(), { type: 'error', reason: 'error', code: 'AUTH', message: 'no', retryable: false }],
      ]),
      registry: registryOf(readTool()),
    })
    await h.session.enqueue('next-turn', say('drains on a fatal error'))
    await h.session.run(turnEnd())
  },
}

/** The recorded scenarios whose calls run side by side, so their commits interleave. */
export const CONCURRENT_SCENARIOS: ReadonlySet<string> = new Set([
  'batch-k4',
  'batch-k8',
  'side-lane',
  'abort-with-pending',
])

/** Statuses a tool call passes through inside one commit, which no program-counter write shows. */
export const MERGED_STATUSES: readonly string[] = ['approved', 'dispatch_pending']

/** The names of the recorded scenarios, in a stable order. */
export const TRANSITION_SCENARIOS: readonly string[] = Object.keys(SCENARIOS)

/**
 * Runs one scenario against `storage` and returns one entry per commit made after the session
 * opened. Two runs of a scenario against equivalent storage return identical recordings.
 */
export async function recordTransitions(name: string, storage: StorageAdapter): Promise<RecordedCommit[]> {
  const scenario = SCENARIOS[name]
  if (!scenario) throw new Error(`unknown transition scenario ${name}`)
  // The op write a commit carried is read off the commit itself, by session.
  const written = new Map<string, OpWrite | undefined>()
  const tapped = new Proxy(storage, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown
      if (property === 'commit')
        // Hands back the adapter's own promise: an extra await here would reorder concurrent calls.
        return (key: string, tx: CommitTx) => {
          written.set(key, tx.opState)
          return (value as StorageAdapter['commit']).call(target, key, tx)
        }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const commits: RecordedCommit[] = []
  const entry = (log: SessionLogImpl, events: Event[], ui: UIProjectionCell | undefined): RecordedCommit => {
    const op = written.get(log.key)
    written.delete(log.key)
    const cells = log.allRegisters()
    return {
      events: events.map(({ ts: _ts, id: _id, ...row }) => stable(row)),
      op: op ? [{ lane: op.lane, data: stable(op.data) }] : [],
      opCells: cells
        .filter((row) => row.register === 'op.state')
        .map((row) => ({ key: row.key, seq: row.seq, data: stable(row.data) }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      registers: cells
        .filter((row) => row.register !== 'op.state')
        .map((row) => ({ register: row.register, key: row.key, seq: row.seq, data: stable(row.data) }))
        .sort((a, b) => `${a.register}\u0000${a.key}`.localeCompare(`${b.register}\u0000${b.key}`)),
      uiOpState: stable(ui?.journalPatch(ui.upto)?.opState ?? null),
    }
  }
  const open: Open = async (over) => {
    const h = await openSession({ ...over, storage: tapped as never, ids: stableIds() })
    h.log.observeCommitted('*', (events: Event[]) => {
      commits.push(entry(h.log, events, h.ui))
    })
    return h
  }
  await scenario(open, (log, events) => commits.push(entry(log, events, undefined)))
  return commits
}

/** The checked-in recording of one scenario, as the build before the format switch wrote it. */
export function readGolden(name: string): GoldenCommit[] {
  return readFileSync(fileURLToPath(new URL(`${name}.jsonl`, goldenDir)), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as GoldenCommit)
}

/**
 * Replaces every id the recorder's stable minter handed out with its order of first appearance.
 * The minter numbers ids, effect ids, call ids, request ids and nonces off one counter, so a build
 * that writes fewer rows hands the same objects different numbers; which object is which does not
 * change.
 */
const BOUND_HASHES = new Set(['derived_hash', 'bindingHash'])

export function withMintedIdsInOrder<T>(value: T): T {
  const seen = new Map<string, string>()
  const minted = /^(e-|r-|t\d+-)?\d{26}(\d{6})?$/
  const walk = (inner: unknown, key?: string): unknown => {
    // These hashes cover minted ids or seqs (a request's messages carry call ids, an approval binds
    // the call, a job effect id is derived from the call), so only which values are equal compares.
    if (
      typeof inner === 'string' &&
      ((key !== undefined && BOUND_HASHES.has(key)) || /^job-[0-9a-f]{64}$/.test(inner))
    ) {
      let label = seen.get(inner)
      if (!label) {
        label = `hash#${seen.size + 1}`
        seen.set(inner, label)
      }
      return label
    }
    if (typeof inner === 'string') {
      const match = minted.exec(inner)
      if (!match) return inner
      let label = seen.get(inner)
      if (!label) {
        label = `${match[1] ?? ''}#${seen.size + 1}`
        seen.set(inner, label)
      }
      return label
    }
    if (Array.isArray(inner)) return inner.map((item) => walk(item))
    if (inner && typeof inner === 'object')
      return Object.fromEntries(
        Object.entries(inner as Record<string, unknown>).map(([k, v]) => [k, walk(v, k)]),
      )
    return inner
  }
  return walk(value) as T
}

/** Keys whose number, or array of numbers, names a ledger seq. */
const SEQ_KEYS = new Set([
  'seq',
  'argsSeq',
  'assistantSeq',
  'boundarySeq',
  'callSeq',
  'lastAssistantSeq',
  'latestAssistantSeq',
  'requestSeq',
  'sourceEventSeqs',
  'thresholdCheckedSeq',
  'triggerSeq',
])

type Row = Record<string, unknown> & { seq: number }

/**
 * Rewrites every seq a value names — a key in SEQ_KEYS, or a surface range's start and end — through
 * `to`, leaving everything else as it is.
 */
export function renumberSeqs(value: unknown, to: (seq: number, key: string) => number): unknown {
  const move = (inner: unknown, key?: string): unknown => {
    if (Array.isArray(inner))
      return key !== undefined && SEQ_KEYS.has(key)
        ? inner.map((seq) => move(seq, 'seq'))
        : inner.map((item) => move(item))
    if (inner && typeof inner === 'object')
      return Object.fromEntries(
        Object.entries(inner as Record<string, unknown>).map(([k, v]) => [
          k,
          k === 'surfaceOp' && v && typeof v === 'object'
            ? move(v, 'surfaceOp')
            : move(v, key === 'surfaceOp' && (k === 'start' || k === 'end') ? 'seq' : k),
        ]),
      )
    if (typeof inner === 'number' && key !== undefined && SEQ_KEYS.has(key)) return to(inner, key)
    return inner
  }
  return move(value)
}

/** A seq map as a `renumberSeqs` target that refuses a seq the map does not have. */
const lookup =
  (map: ReadonlyMap<number, number>, what: string) =>
  (seq: number, key: string): number => {
    const to = map.get(seq)
    if (to === undefined) throw new Error(`${what} names seq ${seq} under ${key}, which no row has`)
    return to
  }

/**
 * What the current format commits for a checked-in reference: the same rows without the
 * program-counter row, an `x/core/op-mark` row for each commit that had no other row, the program
 * counter as a cell at the seq of the commit's last row, and every seq a value names moved to where
 * that row now lands. Throws when a value names a seq no row of the recording has.
 */
export function expectedFromGolden(golden: GoldenCommit[]): RecordedCommit[] {
  // Old seq to new seq, built over the whole recording before any value is moved.
  const moved = new Map<number, number>()
  // Rows written before the recording started (the session's own start) keep their seqs.
  const start = ((golden[0]?.events[0] as Row | undefined)?.seq ?? 1) - 1
  for (let seq = 1; seq <= start; seq++) moved.set(seq, seq)
  let oldHead = start
  let newHead = start
  const heads: Array<{ first: number; last: number; marked: boolean }> = []
  for (const commit of golden) {
    const rows = commit.events as Row[]
    const first = newHead + 1
    // The old program-counter row sat at the end of its batch, except in a fork's first batch.
    let opSeq: number | undefined
    for (const row of rows) {
      if (row.seq === oldHead + 2 && commit.op.length > 0 && opSeq === undefined) opSeq = ++oldHead
      if (row.seq !== oldHead + 1) throw new Error(`reference seq ${row.seq} does not follow ${oldHead}`)
      oldHead = row.seq
      moved.set(row.seq, ++newHead)
    }
    const marked = rows.length === 0
    if (marked) newHead++
    if (commit.op.length > 0) moved.set(opSeq ?? ++oldHead, newHead)
    heads.push({ first, last: newHead, marked })
  }
  const move = (value: unknown): unknown => renumberSeqs(value, lookup(moved, 'reference'))
  const out: RecordedCommit[] = []
  let cells = new Map<string, { seq: number; data: unknown }>()
  golden.forEach((commit, index) => {
    const rows = (commit.events as Row[]).map((row) => move(row) as Row)
    const head = heads[index] as { first: number; last: number; marked: boolean }
    // A delegated or forked child starts with no program counter of its own.
    if (rows.some((row) => row.type === 'session/start' && (row.data as { parent?: unknown }).parent))
      cells = new Map()
    // The old first batch of a fork tombstoned a cell the child never had; there is nothing to write.
    const writes = commit.op
      .filter((write) => write.data !== null || cells.has(write.lane))
      .map((write) => ({ lane: write.lane, data: move(write.data) }))
    if (head.marked) {
      const write = writes[0]
      if (!write) throw new Error(`reference commit ${index} has neither rows nor a program counter`)
      const actor = (golden.flatMap((c) => c.events as Row[])[0] as Row).actor
      rows.push({
        lane: write.lane,
        v: 1,
        type: 'x/core/op-mark',
        origin: 'system',
        trust: 'trusted',
        actor,
        ignorable: true,
        data: stable(
          opMarkData(
            (cells.get(write.lane)?.data ?? null) as OpStateObj | null,
            write.data as OpStateObj | null,
          ),
        ),
        seq: head.last,
      })
    }
    for (const write of writes)
      if (write.data === null) cells.delete(write.lane)
      else cells.set(write.lane, { seq: head.last, data: write.data })
    out.push({
      events: rows,
      op: writes,
      opCells: [...cells]
        .map(([key, cell]) => ({ key, seq: cell.seq, data: cell.data }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      registers: move(commit.registers) as Cell[],
      uiOpState: move(commit.uiOpState),
    })
  })
  return out
}

type Call = { toolUseId: string; status: string; dispatchPhase?: string; dispatchAttempt?: number }
type OpValue = { taint?: boolean; phase: { kind: string; batch?: { calls: Call[] } } } | null
type MarkData = { calls?: Call[] }

const onlyMark = (commit: RecordedCommit | undefined): MarkData | undefined => {
  const [row, ...rest] = (commit?.events ?? []) as Array<{ type: string; data: MarkData }>
  return row?.type === 'x/core/op-mark' && rest.length === 0 ? row.data : undefined
}

/** The one call an op-mark row names, when it names exactly one and gives it `status`. */
const markedCall = (commit: RecordedCommit | undefined, status: string): Call | undefined => {
  const calls = onlyMark(commit)?.calls
  return calls?.length === 1 && calls[0]?.status === status ? calls[0] : undefined
}

const opCall = (commit: RecordedCommit | undefined, toolUseId: string): Call | undefined =>
  (commit?.op[0]?.data as OpValue)?.phase.batch?.calls.find((call) => call.toolUseId === toolUseId)

const hasRow = (commit: RecordedCommit | undefined, test: (row: Row) => boolean): boolean =>
  ((commit?.events ?? []) as Row[]).some(test)

const data = (row: Row): Record<string, unknown> => (row.data ?? {}) as Record<string, unknown>

/** How many commits, starting at `index`, form one of the runs a tool call now commits as one. */
function mergedRun(commits: RecordedCommit[], index: number): number {
  const approved = markedCall(commits[index], 'approved')
  if (approved) {
    const id = approved.toolUseId
    // Approved, then the tool's effect/intent with the call dispatch_pending, then — for a workspace
    // call — the attempt-one `dispatched` mark.
    const intent = commits[index + 1]
    if (
      !hasRow(intent, (row) => row.type === 'effect/intent' && (data(row).tool as Call)?.toolUseId === id) ||
      opCall(intent, id)?.status !== 'dispatch_pending'
    )
      return 1
    const dispatched = markedCall(commits[index + 2], 'dispatched')
    return dispatched?.toolUseId === id && dispatched.dispatchAttempt === 1 ? 3 : 2
  }
  return 1
}

/**
 * What a recording made before a tool call's adjacent transitions were committed together becomes
 * once they are: each run `mergedRun` finds is one commit whose rows are the run's rows without its
 * op-marks and whose program counter, cells and UI summary are the run's last — except the counter's
 * `taint`, which is the run's first, since nothing is folded between the steps of one commit. A
 * second pass moves every seq to where its row now lands and throws on a value that names a dropped
 * op-mark. Only adjacent runs are merged; a concurrent batch interleaves its calls and is compared
 * with `statusProjectionProblems` and `callEventProblems` instead.
 */
export function mergeLedgerWriteCommits(commits: RecordedCommit[]): RecordedCommit[] {
  const dropped = new Set<number>()
  // A cell's seq is its commit's last row; where that row was a dropped op-mark, the cell now sits
  // at the merged commit's last row. Only a cell's own seq may point there.
  const headOf = new Map<number, number>()
  const merged: RecordedCommit[] = []
  for (let index = 0; index < commits.length; ) {
    const run = commits.slice(index, index + mergedRun(commits, index))
    index += run.length
    const last = run.at(-1) as RecordedCommit
    if (run.length === 1) {
      merged.push(last)
      continue
    }
    const rows = run.flatMap((commit) => commit.events as Row[])
    const kept = rows.filter((row) => row.type !== 'x/core/op-mark')
    for (const row of rows)
      if (row.type === 'x/core/op-mark') {
        dropped.add(row.seq)
        headOf.set(row.seq, (kept.at(-1) as Row).seq)
      }
    const taint = (run[0]?.op[0]?.data as OpValue)?.taint
    const withTaint = (value: unknown) =>
      value && typeof value === 'object' ? { ...(value as object), taint } : value
    merged.push({
      events: kept,
      op: last.op.map((write) => ({ lane: write.lane, data: withTaint(write.data) })),
      opCells: last.opCells.map((cell) =>
        cell.key === last.op[0]?.lane ? { ...cell, data: withTaint(cell.data) } : cell,
      ),
      registers: last.registers,
      uiOpState: last.uiOpState,
    })
  }
  const head = Math.max(0, ...commits.flatMap((commit) => (commit.events as Row[]).map((row) => row.seq)))
  const moved = new Map<number, number>()
  let gone = 0
  for (let seq = 1; seq <= head; seq++)
    if (dropped.has(seq)) gone++
    else moved.set(seq, seq - gone)
  const to = lookup(moved, 'merged recording')
  return merged.map((commit) => ({
    events: renumberSeqs(commit.events, to) as unknown[],
    op: renumberSeqs(commit.op, to) as RecordedCommit['op'],
    opCells: commit.opCells.map(({ key, seq, data }) => ({
      key,
      seq: to(headOf.get(seq) ?? seq, 'seq'),
      data: renumberSeqs(data, to),
    })),
    registers: renumberSeqs(commit.registers, to) as Cell[],
    uiOpState: renumberSeqs(commit.uiOpState, to),
  }))
}

/** Each call's status in every program-counter write of a recording, repeats in a row folded. */
function statusRuns(commits: RecordedCommit[]): Map<string, string[]> {
  const runs = new Map<string, string[]>()
  for (const commit of withMintedIdsInOrder(commits))
    for (const write of commit.op)
      for (const call of (write.data as OpValue)?.phase.batch?.calls ?? []) {
        const run = runs.get(call.toolUseId) ?? []
        if (run.at(-1) !== call.status) run.push(call.status)
        runs.set(call.toolUseId, run)
      }
  return runs
}

/**
 * Every call whose statuses, as the program-counter writes of `recorded` show them one after
 * another, are not the statuses `expected` shows with only `droppable` ones left out. Empty when the
 * recording skipped nothing but the statuses its merged commits no longer store.
 */
export function statusProjectionProblems(
  recorded: RecordedCommit[],
  expected: RecordedCommit[],
  droppable: readonly string[],
): string[] {
  const problems: string[] = []
  const got = statusRuns(recorded)
  const want = statusRuns(expected)
  for (const id of new Set([...got.keys(), ...want.keys()])) {
    const seen = got.get(id) ?? []
    const full = want.get(id) ?? []
    let at = 0
    for (const status of full)
      if (seen[at] === status) at++
      else if (!droppable.includes(status)) {
        problems.push(`${id}: [${seen}] skips ${status} of [${full}]`)
        break
      }
    if (at < seen.length) problems.push(`${id}: [${seen}] is not within [${full}]`)
  }
  return problems
}

const blank = (value: unknown) => renumberSeqs(value, () => 0)

/**
 * For a batch whose calls interleave: every call's own rows in order (op-marks aside, seqs blanked,
 * since they move with the rows around them), and the program-counter cells and UI summary each
 * time a tools phase closes, must be the same in both recordings.
 */
export function callEventProblems(recorded: RecordedCommit[], expected: RecordedCommit[]): string[] {
  const perCall = (commits: RecordedCommit[]) => {
    const calls = new Map<string, unknown[]>()
    const effects = new Map<string, string>()
    const closes: unknown[] = []
    let inTools = false
    for (const commit of withMintedIdsInOrder(commits)) {
      for (const row of commit.events as Row[]) {
        if (row.type === 'x/core/op-mark') continue
        const d = data(row)
        const tool = (d.tool as Call | undefined)?.toolUseId
        if (row.type === 'effect/intent' && tool) effects.set(String(d.effectId), tool)
        const id =
          (d.toolUseId as string | undefined) ?? tool ?? effects.get(String(d.effectId ?? '')) ?? undefined
        if (id !== undefined) calls.set(id, [...(calls.get(id) ?? []), blank(row)])
      }
      const kind = (commit.op[0]?.data as OpValue)?.phase.kind
      if (commit.op.length > 0) {
        if (inTools && kind !== 'tools') closes.push(blank({ cells: commit.opCells, ui: commit.uiOpState }))
        inTools = kind === 'tools'
      }
    }
    return { calls, closes }
  }
  const got = perCall(recorded)
  const want = perCall(expected)
  const problems: string[] = []
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  for (const id of new Set([...got.calls.keys(), ...want.calls.keys()]))
    if (!same(got.calls.get(id), want.calls.get(id))) problems.push(`${id}: rows differ`)
  if (!same(got.closes, want.closes))
    problems.push('program counter or UI summary differs where a batch closes')
  return problems
}
