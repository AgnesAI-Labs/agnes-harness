// Records, commit by commit, what a set of scripted sessions writes: the batch of rows, the
// program-counter value each batch carries, every register cell after the commit and the UI
// summary of the running operation. The checked-in recordings under `fixtures/op-state-golden/`
// are the reference any change to how the program counter is stored is compared against.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { InferenceEvent, Provider } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { scanAll } from '../src/log/scan-pages.js'
import type { SessionLogImpl } from '../src/log/session-log.js'
import type { StorageAdapter } from '../src/log/storage.js'
import type { UIProjectionCell } from '../src/project/ui.js'
import { ToolRegistry } from '../src/registry/tools.js'
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

export type RecordedCommit = {
  /** The committed rows other than the program counter's, without the per-row timestamp and id. */
  events: unknown[]
  /** The program-counter value this commit wrote, per lane. */
  op: Array<{ lane: string; data: unknown }>
  /** Every register cell after the commit other than the program counter's, in a stable order. */
  registers: Array<{ register: string; key: string; seq: number; data: unknown }>
  /** The UI summary of the running operation at the head right after the commit. */
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

/** The names of the recorded scenarios, in a stable order. */
export const TRANSITION_SCENARIOS: readonly string[] = Object.keys(SCENARIOS)

/**
 * Runs one scenario against `storage` and returns one entry per commit made after the session
 * opened. Two runs of a scenario against equivalent storage return identical recordings.
 */
export async function recordTransitions(name: string, storage: StorageAdapter): Promise<RecordedCommit[]> {
  const scenario = SCENARIOS[name]
  if (!scenario) throw new Error(`unknown transition scenario ${name}`)
  const commits: RecordedCommit[] = []
  const entry = (log: SessionLogImpl, events: Event[], ui: UIProjectionCell | undefined): RecordedCommit => ({
    events: events
      .filter((event) => event.type !== 'op.state')
      .map(({ ts: _ts, id: _id, ...row }) => stable(row)),
    op: events
      .filter((event) => event.type === 'op.state')
      .map((event) => ({ lane: event.lane ?? 'main', data: stable(event.data) })),
    registers: log
      .allRegisters()
      .filter((row) => row.register !== 'op.state')
      .map((row) => ({ register: row.register, key: row.key, seq: row.seq, data: stable(row.data) }))
      .sort((a, b) => `${a.register}\u0000${a.key}`.localeCompare(`${b.register}\u0000${b.key}`)),
    uiOpState: stable(ui?.journalPatch(ui.upto)?.opState ?? null),
  })
  const open: Open = async (over) => {
    const h = await openSession({ ...over, storage: storage as never, ids: stableIds() })
    h.log.observeCommitted('*', (events: Event[]) => {
      commits.push(entry(h.log, events, h.ui))
    })
    return h
  }
  await scenario(open, (log, events) => commits.push(entry(log, events, undefined)))
  return commits
}

/** The checked-in recording of one scenario. */
export function readGolden(name: string): RecordedCommit[] {
  return readFileSync(fileURLToPath(new URL(`${name}.jsonl`, goldenDir)), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as RecordedCommit)
}

/** Where the checked-in recordings live, for the generator. */
export const GOLDEN_DIR = fileURLToPath(goldenDir)
