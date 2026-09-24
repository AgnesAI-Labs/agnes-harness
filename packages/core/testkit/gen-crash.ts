// Generates `fixtures/crash/*.jsonl`: prefixes of real, fully-run sessions cut at the exact seq of
// an `op.state` write, so each file is what a killed process's ledger looks like at that instant.
// Nothing here simulates a process dying — every transition a session makes commits durably and in
// order the moment it is awaited, so a session run to a normal completion already carries, on its
// own ledger, every intermediate program-counter state a real crash could have been cut at. Slicing
// the finished log at each of those states is indistinguishable, to a reader who only sees the
// prefix, from a process that stopped existing right there.
//
// `resume-matrix.test.ts` reads these back through `MemoryStorage.fromEvents` and calls
// `session.resume()` / `session.resume({ mode: 'close' })` against each one - the two entry points
// this task adds real behaviour to.
//
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Type } from '@sinclair/typebox'
import { scanAll } from '../src/log/scan-pages.js'
import { foldEvents } from '../src/reduce/reducer.js'
import { effectTree } from '../src/reduce/state.js'
import { ToolRegistry } from '../src/registry/tools.js'
import type { CompactionPort } from '../src/step/session.js'
import type { Event, IdMinter } from '../src/types.js'
import { fakeProvider, type Script, sent, textTurn, toolTurn, usage } from '../test/helpers/fake-provider.js'
import { actor, openSession, readTool, shellTool } from '../test/helpers/open-session.js'

const outDir = fileURLToPath(new URL('../fixtures/crash/', import.meta.url))

/** Stable ids keep checked-in crash fixtures reproducible byte-for-byte across generator runs. */
const fixtureIds = (): IdMinter => {
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

/**
 * A tool whose own execution makes a nested call, so it leaves a child effect under its own. Named
 * away from `run_code`: that name is disclosure-reserved (`discloseTools`, request/derive) and is
 * filtered out of a standard-disclosure request, so a call to it would never reach execution here.
 */
const nestedTool = () =>
  ({
    name: 'do_batch',
    description: 'runs a compound step; invokes `read` as a nested call along the way',
    parameters: Type.Object({}),
    meta: toolMeta,
    execute: async (
      _args: unknown,
      ctx: { tools: { invoke(name: string, args: unknown): Promise<unknown> } },
    ) => {
      await ctx.tools.invoke('read', { p: 1 })
      return { content: [{ type: 'text' as const, text: 'code ok' }] }
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
        idempotencyKey: 'fixture-job',
        payload: { kind: 'shell', command: 'printf fixture', cwd: '/w' },
      })
      // Core consumes this structurally until extension-api publishes ToolResult.deferred. Keeping
      // the cast at the fixture boundary makes that external type gap visible instead of spreading.
      return { content: [{ type: 'text' as const, text: 'queued' }], deferred: { jobId } }
    },
  }) as never

const registry = (): ToolRegistry => {
  const r = new ToolRegistry()
  r.add(readTool(), { source: 's', trust: 'builtin' })
  r.add(shellTool(), { source: 's', trust: 'builtin' })
  r.add(nestedTool(), { source: 's', trust: 'builtin' })
  r.add(deferredTool(), { source: 's', trust: 'builtin' })
  return r
}

const turnEnd = () => ({ until: 'turn-end' as const, signal: new AbortController().signal })

/** Plain text turn, then a two-call batch (a safe read and a never-replayed shell), then text. */
async function scenarioBasic(): Promise<Event[]> {
  const batch: Script = [
    sent(),
    { type: 'toolcall_end', call: { toolUseId: '', name: 'read', args: {}, ordinal: 0 }, via: 'native' },
    {
      type: 'toolcall_end',
      call: { toolUseId: '', name: 'shell', args: { cmd: 'ls' }, ordinal: 1 },
      via: 'native',
    },
    usage(),
    { type: 'done', reason: 'toolUse' },
  ]
  const { session, log } = await openSession({
    provider: fakeProvider([textTurn('hello'), batch, textTurn('after tools')]),
    registry: registry(),
    ids: fixtureIds(),
  })
  await session.enqueue('next-turn', { content: [{ type: 'text', text: 't1' }], actor })
  await session.run(turnEnd())
  await session.enqueue('next-turn', { content: [{ type: 'text', text: 't2' }], actor })
  await session.run(turnEnd())
  return scanAll((q) => log.scan(q), { fromSeq: 1, toSeq: log.lastSeq })
}

/** A single `do_batch` call, which invokes `read` as a still-open child at the moment it starts. */
async function scenarioChild(): Promise<Event[]> {
  const { session, log } = await openSession({
    provider: fakeProvider([toolTurn('do_batch', {}), textTurn('done')]),
    registry: registry(),
    ids: fixtureIds(),
  })
  await session.enqueue('next-turn', { content: [{ type: 'text', text: 't1' }], actor })
  await session.run(turnEnd())
  return scanAll((q) => log.scan(q), { fromSeq: 1, toSeq: log.lastSeq })
}

/** A `shouldCompact` stub that fires exactly once, so the very first checkpoint enters compaction. */
async function scenarioCompaction(): Promise<Event[]> {
  const compaction: CompactionPort = { shouldCompact: () => true, onOverflow: () => 'failure' }
  const { session, log } = await openSession({
    provider: fakeProvider([textTurn('after compaction')]),
    registry: registry(),
    compaction,
    ids: fixtureIds(),
  })
  await session.enqueue('next-turn', { content: [{ type: 'text', text: 't1' }], actor })
  await session.run(turnEnd())
  return scanAll((q) => log.scan(q), { fromSeq: 1, toSeq: log.lastSeq })
}

/** An unretryable provider error, which drains straight to `failure_drain` on the first inference. */
async function scenarioFailureDrain(): Promise<Event[]> {
  const errorScript: Script = [
    sent(),
    { type: 'error', reason: 'error', code: 'AUTH', message: 'permanently unavailable', retryable: false },
  ]
  const { session, log } = await openSession({
    provider: fakeProvider([errorScript]),
    registry: registry(),
    ids: fixtureIds(),
  })
  await session.enqueue('next-turn', { content: [{ type: 'text', text: 't1' }], actor })
  await session.run(turnEnd())
  return scanAll((q) => log.scan(q), { fromSeq: 1, toSeq: log.lastSeq })
}

/** A returned external job, cut after tools has durably handed it to the deferred poller. */
async function scenarioDeferred(): Promise<Event[]> {
  const timers = {
    setTimeout: (fn: () => void, ms: number) => {
      // Let only the deferred wait fire; the much longer writer-lease renewal stays dormant.
      if (ms === 2_000) queueMicrotask(fn)
      return 0
    },
    clearTimeout: () => undefined,
  }
  const { session, log } = await openSession({
    provider: fakeProvider([toolTurn('export_job', {}), textTurn('after job')]),
    registry: registry(),
    timers,
    ids: fixtureIds(),
  })
  await session.enqueue('next-turn', { content: [{ type: 'text', text: 't1' }], actor })
  await session.run(turnEnd())
  return scanAll((q) => log.scan(q), { fromSeq: 1, toSeq: log.lastSeq })
}

type Phase = { kind: string } & Record<string, unknown>

/** The `<kind>-<sub>` half of a fixture's file name, read off the phase the way `op.state` shapes it. */
function subName(phase: Phase, prefix: Event[]): string {
  switch (phase.kind) {
    case 'checkpoint':
      return String(phase.continuation)
    case 'inference':
      return String((phase.gen as { status: string }).status)
    case 'compaction':
      return String(phase.reason)
    case 'failure_drain':
      return String((phase.provenance as { kind: string }).kind)
    case 'tools': {
      if (prefix.some((e) => e.type === 'x/core/deferred-job')) return 'deferred-ready'
      return effectTree(foldEvents(prefix)).some((r) => r.children.length > 0) ? 'child' : 'batch'
    }
    default:
      // `deferred` has no second discriminator in OpState, so `x` is its complete sub-name.
      return 'x'
  }
}

async function main(): Promise<void> {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const runs = [
    await scenarioBasic(),
    await scenarioChild(),
    await scenarioCompaction(),
    await scenarioDeferred(),
    await scenarioFailureDrain(),
  ]
  const seen = new Set<string>()
  let n = 0
  for (const events of runs)
    for (let i = 0; i < events.length; i++) {
      const e = events[i] as Event
      if (e.type !== 'op.state' || e.data === null) continue
      const phase = (e.data as { phase: Phase }).phase
      const prefix = events.slice(0, i + 1)
      const name = `${phase.kind}-${subName(phase, prefix)}`
      seen.add(name)
      n++
      writeFileSync(
        `${outDir}${String(n).padStart(2, '0')}-${name}.jsonl`,
        `${prefix.map((ev) => JSON.stringify(ev)).join('\n')}\n`,
      )
    }
  console.log(`wrote ${n} crash fixtures: ${[...seen].sort().join(', ')}`)
}

await main()
