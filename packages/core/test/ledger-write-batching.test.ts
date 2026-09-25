// Where a tool call's commits fall. The transitions before dispatch — approved, intent written,
// dispatched — commit as one append, and so do the result and its settlement; this file counts those
// commits, checks the reopened state and the recovery decision at each side of every merged commit,
// and covers the paths that keep their own commits.
import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { scanAll } from '../src/log/scan-pages.js'
import type { CommitTx, RegisterRow } from '../src/log/storage.js'
import { openTracked } from '../src/reduce/tracker.js'
import { ToolRegistry } from '../src/registry/tools.js'
import type { OpStateObj, ToolCallState } from '../src/step/op-state.js'
import {
  expectedFromGolden,
  readGolden,
  recordTransitions,
  TRANSITION_SCENARIOS,
} from '../testkit/record-transitions.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { actor, openSession, openWorldTool, readTool, shellTool } from './helpers/open-session.js'

type Tx = { key: string; tx: CommitTx }
type Opened = Awaited<ReturnType<typeof openSession>>

/**
 * A MemoryStorage that records every commit and, when `fail` says so, throws an ordinary error from
 * that commit instead of writing it — a storage fault, which seals the session.
 */
function tapped(fail: (commit: Tx, index: number) => boolean = () => false, storage = new MemoryStorage()) {
  const commits: Tx[] = []
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown
      if (property === 'commit')
        return (key: string, tx: CommitTx) => {
          if (fail({ key, tx }, commits.length)) return Promise.reject(new Error('injected'))
          commits.push({ key, tx })
          return (value as MemoryStorage['commit']).call(target, key, tx)
        }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { storage, proxy: proxy as MemoryStorage, commits }
}

const callsOf = (data: unknown): ToolCallState[] => {
  const op = data as OpStateObj | null
  return op?.phase.kind === 'tools' ? op.phase.batch.calls : []
}
const callIn = (data: unknown, toolUseId?: string): ToolCallState | undefined =>
  callsOf(data).find((call) => toolUseId === undefined || call.toolUseId === toolUseId)

const isToolIntent = ({ tx }: Tx) =>
  tx.events.some((e) => e.type === 'effect/intent' && (e.data as { kind?: string }).kind === 'tool')
/** A tool's own result, not a synthetic closer. */
const hasToolResult = ({ tx }: Tx) =>
  tx.events.some((e) => e.type === 'tool/result' && (e.data as { code?: string }).code === undefined)

const go = { content: [{ type: 'text' as const, text: 'go' }], actor }
const turnEnd = () => ({ until: 'turn-end' as const, signal: new AbortController().signal })

const registryOf = (...tools: unknown[]) => {
  const registry = new ToolRegistry()
  for (const tool of tools) registry.add(tool as never, { source: 's', trust: 'builtin' })
  return registry
}

/** A tool that stays in flight until released, reporting when it starts. */
function held(kind: 'read' | 'shell' = 'read') {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const running = new Promise<void>((resolve) => {
    entered = resolve
  })
  const run = async () => {
    entered()
    await gate
    return { content: [{ type: 'text' as const, text: 'late' }] }
  }
  return { tool: kind === 'read' ? readTool(run) : shellTool(run), release: () => release(), running }
}

/** Every row and program-counter cell a live session holds, as a separate store a new writer can open. */
async function copyOf(h: Opened): Promise<MemoryStorage> {
  const rows = await scanAll((q) => h.log.scan(q), { fromSeq: 1, toSeq: h.log.lastSeq })
  const opCells: RegisterRow[] = structuredClone(
    h.log.allRegisters().filter((row) => row.register === 'op.state'),
  )
  return MemoryStorage.fromEvents('k', rows, { opCells })
}

/** Opens `storage` as a new writer with `tool` registered, as a restarted process would. */
function reopen(storage: MemoryStorage, ...tools: unknown[]) {
  return openSession({
    provider: fakeProvider([textTurn('after')]),
    registry: registryOf(...tools),
    storage,
    key: 'k',
    writerRunId: 'reopened',
  })
}

/** A counting tool whose calls record the program counter's state for their own call. */
function counted(kind: 'read' | 'shell', session: () => Opened['session'] | undefined) {
  const seen: Array<ToolCallState | undefined> = []
  const run = async () => {
    seen.push(callIn(session()?.op()))
    return { content: [{ type: 'text' as const, text: 'ran' }] }
  }
  return { tool: kind === 'read' ? readTool(run) : shellTool(run), seen }
}

describe('commits of one tool call', () => {
  it('commits a workspace call once before it runs, with its intent, already dispatched', async () => {
    const { proxy, commits } = tapped()
    let opened: Opened | undefined
    const runs = counted('read', () => opened?.session)
    opened = await openSession({
      provider: fakeProvider([toolTurn('read', {}), textTurn('done')]),
      registry: registryOf(runs.tool),
      storage: proxy,
    })
    await opened.session.enqueue('next-turn', go)
    await opened.session.run(turnEnd())
    // The commit that carried the intent is the only one between the batch opening and the call
    // running; the call was already dispatched in it.
    const planned = commits.findIndex((c) => callIn(c.tx.opState?.data)?.status === 'planned')
    const intent = commits.findIndex(isToolIntent)
    expect(intent).toBe(planned + 1)
    expect(commits[intent]?.tx.events.map((e) => e.type)).toEqual(['effect/intent'])
    expect(callIn(commits[intent]?.tx.opState?.data)).toMatchObject({
      status: 'dispatched',
      dispatchPhase: 'may_have_sent',
      dispatchAttempt: 1,
    })
    expect(runs.seen).toEqual([expect.objectContaining({ status: 'dispatched', dispatchAttempt: 1 })])
    // The result, its settlement and the completed call are the other commit, and the last.
    const result = commits.findIndex(hasToolResult)
    expect(commits[result]?.tx.events.map((e) => e.type)).toEqual([
      'tool/result',
      'effect/settled',
      'verifier/signal',
    ])
    expect(callIn(commits[result]?.tx.opState?.data)).toMatchObject({
      status: 'completed',
      dispatchPhase: 'responded',
      dispatchAttempt: 1,
    })
    const moved = commits.filter((c, i) => {
      const call = callIn(c.tx.opState?.data)
      const was = callIn(commits.slice(0, i).findLast((p) => p.tx.opState)?.tx.opState?.data)
      return call !== undefined && was !== undefined && call.status !== was.status
    })
    expect(moved).toHaveLength(2)
    // Nothing on the ledger stands for the in-between statuses.
    const marks = await opened.log.scan({ type: 'x/core/op-mark', limit: 50 })
    expect(marks.filter((row) => (row.data as { calls?: unknown[] }).calls?.length)).toEqual([])
  })

  it.each([
    ['batch-k1', 19, 2],
    ['batch-k4', 25, 2],
    ['batch-k8', 33, 2],
    ['nested-m6', 37, 2],
  ])('%s commits %i times, %i of them op-marks', async (name, total, marks) => {
    const recorded = await recordTransitions(name, new MemoryStorage())
    expect(recorded.length).toBe(total)
    const rows = recorded.flatMap((commit) => commit.events as Array<{ type: string }>)
    expect(rows.filter((row) => row.type === 'x/core/op-mark')).toHaveLength(marks)
    // Every row but the op-marks the merged commits no longer need is still written.
    const reference = expectedFromGolden(readGolden(name)).flatMap(
      (commit) => commit.events as Array<{ type: string }>,
    )
    const count = (list: Array<{ type: string }>) => {
      const by: Record<string, number> = {}
      for (const row of list) if (row.type !== 'x/core/op-mark') by[row.type] = (by[row.type] ?? 0) + 1
      return by
    }
    expect(count(rows)).toEqual(count(reference))
  })

  it.each(TRANSITION_SCENARIOS)('%s never stores a call as responded', async (name) => {
    for (const commit of await recordTransitions(name, new MemoryStorage()))
      for (const write of commit.op)
        expect(callsOf(write.data).map((call) => call.status)).not.toContain('responded')
  })

  it('writes an open-world result with the counter it had, and the next commit carries the taint', async () => {
    let opened: Opened | undefined
    const at: Array<{ counter: boolean | undefined; lane: boolean | undefined }> = []
    const { proxy, commits } = tapped(({ tx }) => {
      // Just before the commit after the result's: what a reader of the program counter sees then.
      if (commits.at(-1)?.tx.events.some((e) => e.type === 'tool/result') && tx.opState)
        at.push({ counter: opened?.session.op()?.taint, lane: opened?.session.laneTaint() })
      return false
    })
    opened = await openSession({
      provider: fakeProvider([toolTurn('fetch_page', {}), textTurn('done')]),
      registry: registryOf(openWorldTool()),
      storage: proxy,
    })
    await opened.session.enqueue('next-turn', go)
    await opened.session.run(turnEnd())
    const result = commits.findIndex(hasToolResult)
    expect(commits[result]?.tx.events[0]?.trust).toBe('untrusted')
    expect((commits[result]?.tx.opState?.data as OpStateObj | undefined)?.taint).toBe(false)
    // Every reader takes the counter's copy or the fold's answer, and the fold already has the row.
    expect(at[0]).toEqual({ counter: false, lane: true })
    expect((commits[result + 1]?.tx.opState?.data as OpStateObj | undefined)?.taint).toBe(true)
  })
})

describe('a stop around the pre-dispatch commit', () => {
  it('before it: the call is approved and refused as today, with no effect', async () => {
    let opened: Opened | undefined
    const runs = counted('shell', () => opened?.session)
    // The stop arrives while the approval's answer is being written, so it is seen before dispatch.
    const { proxy } = tapped(({ tx }) => {
      if (tx.events.some((e) => e.type === 'approval/decided')) opened?.session.ac.abort()
      return false
    })
    opened = await openSession({
      provider: fakeProvider([toolTurn('shell', {})]),
      registry: registryOf(runs.tool),
      storage: proxy,
    })
    await opened.session.enqueue('next-turn', go)
    await opened.session.acceptInput()
    await opened.session.runInference()
    await opened.session.runToolsPhase()
    const rows = await opened.log.scan({ fromSeq: 1, toSeq: opened.log.lastSeq })
    const decided = rows.findIndex((row) => row.type === 'approval/decided')
    expect(rows.slice(decided + 1, decided + 3).map((row) => row.type)).toEqual([
      'x/core/op-mark',
      'tool/result',
    ])
    expect(rows[decided + 1]?.data).toMatchObject({ calls: [{ status: 'approved' }] })
    expect(rows[decided + 2]?.data).toMatchObject({ code: 'CANCELLED', isError: true })
    expect(rows.filter(isToolIntentRow)).toEqual([])
    expect(runs.seen).toEqual([])
  })

  it('during it: the intent is settled as aborted and nothing is dispatched', async () => {
    let opened: Opened | undefined
    const runs = counted('read', () => opened?.session)
    const { proxy, commits } = tapped((commit) => {
      // The stop arrives while the pre-dispatch commit is being written.
      if (isToolIntent(commit)) opened?.session.ac.abort()
      return false
    })
    opened = await openSession({
      provider: fakeProvider([toolTurn('read', {})]),
      registry: registryOf(runs.tool),
      storage: proxy,
    })
    await opened.session.enqueue('next-turn', go)
    await opened.session.acceptInput()
    await opened.session.runInference()
    await opened.session.runToolsPhase()
    expect(runs.seen).toEqual([])
    const intent = commits.findIndex(isToolIntent)
    expect(callIn(commits[intent]?.tx.opState?.data)).toMatchObject({ status: 'dispatched' })
    const settled = commits[intent + 1]
    expect(settled?.tx.events.map((e) => e.type)).toEqual(['tool/result', 'effect/settled'])
    expect(settled?.tx.events[0]?.data).toMatchObject({ code: 'CANCELLED' })
    expect(settled?.tx.events[1]?.data).toMatchObject({ outcome: 'aborted' })
    expect(callIn(settled?.tx.opState?.data)).toMatchObject({
      status: 'completed',
      dispatchPhase: 'not_sent',
      dispatchAttempt: 1,
    })
  })
})

const isToolIntentRow = (row: { type: string; data: unknown }) =>
  row.type === 'effect/intent' && (row.data as { kind?: string }).kind === 'tool'

/** The store a session leaves when the first commit `at` picks out fails and seals it. */
async function failedAt(kind: 'read' | 'shell', at: (commit: Tx) => boolean) {
  const { storage, proxy } = tapped(at)
  const h = await openSession({
    provider: fakeProvider([toolTurn(kind, {})]),
    registry: registryOf(kind === 'read' ? readTool() : shellTool()),
    storage: proxy,
  })
  await h.session.enqueue('next-turn', go)
  await h.session.acceptInput()
  await h.session.runInference()
  await expect(h.session.runToolsPhase()).rejects.toThrow('injected')
  await h.log.close().catch(() => undefined)
  return storage
}

describe('a crash at the pre-dispatch commit', () => {
  const failedBeforeDispatch = (kind: 'read' | 'shell') => failedAt(kind, isToolIntent)

  it('before it: the call reopens planned and runs exactly once on resume', async () => {
    const storage = await failedBeforeDispatch('read')
    let opened: Opened | undefined
    const runs = counted('read', () => opened?.session)
    opened = await reopen(storage, runs.tool)
    expect(callIn(opened.session.op())?.status).toBe('planned')
    expect((await opened.session.resume()).actions).toEqual([])
    expect((await opened.session.run(turnEnd())).reason).toBe('completed')
    expect(runs.seen).toHaveLength(1)
    expect(await opened.log.scan({ type: 'tool/result', limit: 10 })).toHaveLength(1)
  })

  it('before it: closing reports the call as not started', async () => {
    const storage = await failedBeforeDispatch('shell')
    const runs = counted('shell', () => undefined)
    const opened = await reopen(storage, runs.tool)
    await opened.session.resume({ mode: 'close' })
    expect((await opened.log.scan({ type: 'tool/result', limit: 10 }))[0]?.data).toMatchObject({
      code: 'TOOL_NOT_STARTED',
    })
    expect(await opened.log.scan({ type: 'effect/intent', limit: 10 })).toHaveLength(1)
    expect(runs.seen).toEqual([])
  })

  it('before it: a stop cancels the call without an effect', async () => {
    const storage = await failedBeforeDispatch('shell')
    const runs = counted('shell', () => undefined)
    const opened = await reopen(storage, runs.tool)
    await opened.session.abort(actor)
    await opened.session.run(turnEnd())
    expect((await opened.log.scan({ type: 'tool/result', limit: 10 }))[0]?.data).toMatchObject({
      code: 'CANCELLED',
      partial: false,
    })
    expect((await opened.log.scan({ type: 'effect/intent', limit: 10 })).filter(isToolIntentRow)).toEqual([])
    expect(runs.seen).toEqual([])
  })
})

describe('a crash after the pre-dispatch commit, while the call runs', () => {
  async function crashedWhileRunning(kind: 'read' | 'shell') {
    const call = held(kind)
    const h = await openSession({
      provider: fakeProvider([toolTurn(kind, {})]),
      registry: registryOf(call.tool),
    })
    await h.session.enqueue('next-turn', go)
    await h.session.acceptInput()
    await h.session.runInference()
    const running = h.session.runToolsPhase().catch(() => undefined)
    await call.running
    const copy = await copyOf(h)
    call.release()
    await running
    return copy
  }

  it('a safe read reruns under the same effect at attempt two, once', async () => {
    const storage = await crashedWhileRunning('read')
    let opened: Opened | undefined
    const runs = counted('read', () => opened?.session)
    opened = await reopen(storage, runs.tool)
    const before = callIn(opened.session.op())
    expect(before).toMatchObject({ status: 'dispatched', dispatchPhase: 'may_have_sent', dispatchAttempt: 1 })
    expect((await opened.session.resume()).actions).toEqual([{ effectId: before?.effectId, action: 'rerun' }])
    expect((await opened.session.run(turnEnd())).reason).toBe('completed')
    expect(runs.seen).toEqual([
      expect.objectContaining({
        status: 'dispatched',
        effectId: before?.effectId,
        dispatchPhase: 'may_have_sent',
        dispatchAttempt: 2,
      }),
    ])
  })

  it('a recovered dispatch commits dispatched at attempt two before the call runs', async () => {
    const { proxy, commits } = tapped(() => false, await crashedWhileRunning('read'))
    let before: Tx[] = []
    const run = async () => {
      before = [...commits]
      return { content: [{ type: 'text' as const, text: 'ran' }] }
    }
    const opened = await reopen(proxy, readTool(run))
    await opened.session.resume()
    await opened.session.run(turnEnd())
    // The commit just before the call ran is the recovered dispatch's own, not the resume's retry.
    expect(callIn(before.at(-2)?.tx.opState?.data)).toMatchObject({
      status: 'dispatch_pending',
      dispatchAttempt: 2,
    })
    expect(before.at(-1)?.tx.events.map((e) => e.type)).toEqual(['x/core/op-mark'])
    expect(callIn(before.at(-1)?.tx.opState?.data)).toMatchObject({
      status: 'dispatched',
      dispatchPhase: 'may_have_sent',
      dispatchAttempt: 2,
    })
  })

  it('a call that must not be replayed is unknown and does not run', async () => {
    const storage = await crashedWhileRunning('shell')
    const runs = counted('shell', () => undefined)
    const opened = await reopen(storage, runs.tool)
    expect((await opened.session.resume()).actions[0]?.action).toBe('unknown')
    expect(runs.seen).toEqual([])
    expect((await opened.log.scan({ type: 'tool/result', limit: 10 }))[0]?.data).toMatchObject({
      code: 'TOOL_OUTCOME_UNKNOWN',
    })
  })

  it('a stop after reopening leaves a dispatched call unknown, not cancelled', async () => {
    const storage = await crashedWhileRunning('read')
    const runs = counted('read', () => undefined)
    const opened = await reopen(storage, runs.tool)
    await opened.session.abort(actor)
    // The stop fabricates no result for a call that may already have gone out.
    expect(await opened.log.scan({ type: 'tool/result', limit: 10 })).toEqual([])
    expect(opened.session.op()?.control.status).toBe('cancel_requested')
    expect((await opened.session.resume()).actions[0]?.action).toBe('unknown')
    expect(runs.seen).toEqual([])
  })
})

describe('a crash at the result commit', () => {
  it('before it: a safe read reopens dispatched and reruns under the same effect at attempt two', async () => {
    const storage = await failedAt('read', hasToolResult)
    let opened: Opened | undefined
    const runs = counted('read', () => opened?.session)
    opened = await reopen(storage, runs.tool)
    const before = callIn(opened.session.op())
    expect(before).toMatchObject({ status: 'dispatched', dispatchPhase: 'may_have_sent', dispatchAttempt: 1 })
    expect((await opened.session.resume()).actions).toEqual([{ effectId: before?.effectId, action: 'rerun' }])
    expect((await opened.session.run(turnEnd())).reason).toBe('completed')
    expect(runs.seen).toEqual([
      expect.objectContaining({ status: 'dispatched', effectId: before?.effectId, dispatchAttempt: 2 }),
    ])
    expect(await opened.log.scan({ type: 'tool/result', limit: 10 })).toHaveLength(1)
  })

  it('before it: a call that must not be replayed is unknown, with one synthetic result', async () => {
    const storage = await failedAt('shell', hasToolResult)
    const runs = counted('shell', () => undefined)
    const opened = await reopen(storage, runs.tool)
    expect(callIn(opened.session.op())).toMatchObject({ status: 'dispatched', dispatchAttempt: 1 })
    expect((await opened.session.resume()).actions[0]?.action).toBe('unknown')
    expect(runs.seen).toEqual([])
    const results = await opened.log.scan({ type: 'tool/result', limit: 10 })
    expect(results.map((row) => (row.data as { code?: string }).code)).toEqual(['TOOL_OUTCOME_UNKNOWN'])
  })

  it('before it: closing reports the outcome as unknown', async () => {
    const storage = await failedAt('read', hasToolResult)
    const runs = counted('read', () => undefined)
    const opened = await reopen(storage, runs.tool)
    await opened.session.resume({ mode: 'close' })
    expect(runs.seen).toEqual([])
    expect((await opened.log.scan({ type: 'tool/result', limit: 10 }))[0]?.data).toMatchObject({
      code: 'TOOL_OUTCOME_UNKNOWN',
    })
    expect(
      (await opened.log.scan({ type: 'effect/settled', order: 'desc', limit: 5 })).map((r) => r.data),
    ).toContainEqual(expect.objectContaining({ outcome: 'unknown' }))
  })
})

// Every store a failed merged commit can leave behind, in every recorded scenario that dispatches a
// tool: a fresh writer opens it (the open-time program-counter checks pass) and finds the call the
// failed commit was for where it was before that commit — still planned when the pre-dispatch commit
// failed, still dispatched when the result's did.
describe('every merged commit point, failed', () => {
  const SCENARIOS = ['batch-k1', 'batch-k4', 'nested-m6', 'approval-sync', 'approval-parked', 'side-lane']
  const KINDS = [
    { name: 'pre-dispatch', at: isToolIntent, before: 'planned' },
    { name: 'result', at: hasToolResult, before: 'dispatched' },
  ] as const
  const callOfCommit = ({ tx }: Tx): string | undefined => {
    for (const e of tx.events) {
      const d = e.data as { toolUseId?: string; kind?: string; tool?: { toolUseId?: string } }
      if (e.type === 'effect/intent' && d.kind === 'tool') return d.tool?.toolUseId
      if (e.type === 'tool/result') return d.toolUseId
    }
    return undefined
  }
  it.each(SCENARIOS.flatMap((name) => KINDS.map((kind) => [name, kind.name] as const)))(
    '%s, %s',
    async (name, kindName) => {
      const kind = KINDS.find((k) => k.name === kindName) as (typeof KINDS)[number]
      const { proxy, commits } = tapped()
      await recordTransitions(name, proxy)
      const points = commits.map((commit, index) => (kind.at(commit) ? index : -1)).filter((i) => i >= 0)
      expect(points.length).toBeGreaterThan(0)
      for (const point of points) {
        let failed: Tx | undefined
        const { storage, proxy } = tapped((commit, index) => {
          if (index !== point) return false
          failed = commit
          return true
        })
        await recordTransitions(name, proxy).catch(() => undefined)
        const lane = failed?.tx.opState?.lane as string
        const opened = await openTracked({
          storage,
          key: failed?.key as string,
          // The writer the failed commit sealed; its lease is still on the store.
          writerRunId: 'r1',
          ttlMs: 60_000,
          ids: defaultIds(() => 0),
          clock: () => 0,
          timers: { setTimeout: () => 0, clearTimeout: () => undefined },
          lane,
        }).catch((error: unknown) => {
          throw new Error(`${name} point ${point}: ${String(error)}`)
        })
        const cell = opened.log.allRegisters().find((row) => row.register === 'op.state' && row.key === lane)
        expect(callIn(cell?.data, callOfCommit(failed as Tx))?.status, `${name} point ${point}`).toBe(
          kind.before,
        )
        await opened.log.close()
      }
    },
  )
})
