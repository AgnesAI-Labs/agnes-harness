import type { InferenceEvent, Provider } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import type { SeamImplementations } from '../src/effects/seams.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import type { SessionLogImpl } from '../src/log/session-log.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { type ToolCallState, withPhase } from '../src/step/op-state.js'
import { type PresetView, presetDefaults } from '../src/step/preset.js'
import { fakeProvider, sentFor, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, readTool, shellTool } from './helpers/open-session.js'

/**
 * A model that says it sent the request and then never answers. The process is killed while this is
 * outstanding, so the ledger keeps what a SIGKILL leaves: `step/start`, `effect/intent`, the
 * pre-send `request/header`, the provider's `request/sent` receipt, and no settlement. It holds no
 * timer, so nothing about the test's own scheduling decides when the kill lands.
 */
const hangingModel = (): Provider => ({
  models: () => [],
  async *infer(req): AsyncIterable<InferenceEvent> {
    yield sentFor(req)
    await new Promise<void>(() => undefined)
  },
})

/** The same, after the model has streamed enough for the kernel to flush a chunk row. */
const hangingModelAfter = (text: string): Provider => ({
  models: () => [],
  async *infer(req): AsyncIterable<InferenceEvent> {
    yield sentFor(req)
    yield { type: 'text_delta', delta: text }
    await new Promise<void>(() => undefined)
  },
})

/** A tool that stops until the test lets it go, so the kill lands with the call in flight. */
function gatedTool(kind: 'read' | 'shell') {
  let release!: () => void
  const gate = new Promise<void>((res) => {
    release = res
  })
  const run = async () => {
    await gate
    return { content: [{ type: 'text' as const, text: 'ok' }] }
  }
  const registry = new ToolRegistry()
  registry.add(kind === 'read' ? readTool(run) : shellTool(run), { source: 's', trust: 'builtin' })
  return { registry, release: () => release() }
}

const retryOnce = (): PresetView => {
  const d = presetDefaults()
  return { ...d, model: { ...d.model, retry: { maxAttempts: 1, baseDelayMs: 1 } } }
}

const types = async (log: SessionLogImpl): Promise<string[]> =>
  (await log.scan({ fromSeq: 1, limit: 500 })).map((e) => e.type)

/**
 * A ledger whose tail is a tool call the process died inside. The steps are driven one at a time so
 * the kill lands in the tools phase and nowhere else, and the log is closed while the call is still
 * out - which is the point: nothing wrote `effect/settled`, and nothing wrote `step/end`.
 */
async function crashInToolCall(
  kind: 'read' | 'shell',
  reopened: {
    seams?: SeamImplementations
    run?: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
    tool?: Parameters<ToolRegistry['add']>[0]
  } = {},
) {
  const storage = new MemoryStorage()
  const first = gatedTool(kind)
  const a = await openSession({
    provider: fakeProvider([toolTurn(kind, { x: 1 }), textTurn('after')]),
    registry: first.registry,
    storage,
  })
  await a.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
  expect(await a.session.step()).toEqual({ phase: 'checkpoint' })
  expect(await a.session.step()).toEqual({ phase: 'inference' })
  expect(await a.session.step()).toEqual({ phase: 'tools' })
  const stuck = a.session.step().catch(() => undefined)
  await new Promise((r) => setTimeout(r, 10))
  await a.log.close()
  // Released only once the ledger is gone, so the call's own writes land nowhere - which is what a
  // killed process's in-flight work does. Awaited, so the abandoned step is finished with before the
  // next writer opens.
  first.release()
  await stuck
  const second = new ToolRegistry()
  second.add(reopened.tool ?? (kind === 'read' ? readTool(reopened.run) : shellTool(reopened.run)), {
    source: 's',
    trust: 'builtin',
  })
  return openSession({
    provider: fakeProvider([textTurn('after')]),
    registry: second,
    storage,
    key: 'k',
    ...(reopened.seams ? { seams: reopened.seams } : {}),
  })
}

/** The same kill, one phase earlier: inside the model request, with no answer of any kind. */
async function crashInInference(o: { preset?: PresetView; abortFirst?: boolean; extra?: object } = {}) {
  const storage = new MemoryStorage()
  const a = await openSession({
    provider: hangingModel(),
    storage,
    ...(o.preset ? { preset: o.preset } : {}),
  })
  await a.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
  expect(await a.session.step()).toEqual({ phase: 'checkpoint' })
  expect(await a.session.step()).toEqual({ phase: 'inference' })
  if (o.extra) await a.session.append([a.session.ev('effect/intent', o.extra)])
  void a.session.step().catch(() => undefined)
  await new Promise((r) => setTimeout(r, 10))
  // A cancellation recorded before the process dies is the state a Ctrl-C followed by a kill leaves.
  if (o.abortFirst) await a.session.abort(actor)
  await a.log.close()
  return { storage, first: a }
}

const reopen = (storage: MemoryStorage, preset?: PresetView) =>
  openSession({
    provider: fakeProvider([textTurn('ok')]),
    storage,
    key: 'k',
    ...(preset ? { preset } : {}),
  })

describe('resume', () => {
  it('an idle session resumes to idle', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    expect(await session.resume()).toEqual({ state: 'idle', actions: [] })
  })

  // The acceptance case for the whole task, in the phase the defect was found in. Before this, a
  // fresh process calling resume() then run() got E_RELATION: step already open, and the turn was
  // repaired away instead of continued.
  it('a session killed mid-inference resumes and finishes the turn it was in', async () => {
    const { storage } = await crashInInference()
    const { session, log } = await reopen(storage)
    expect((await session.resume()).actions[0]?.action).toBe('retry')
    expect(session.op()?.phase).toMatchObject({ kind: 'inference', gen: { status: 'ready', attempt: 1 } })
    const out = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(out.reason).toBe('completed')
    const ends = await log.scan({ type: 'turn/end', limit: 5 })
    expect(ends).toHaveLength(1)
    expect(ends[0]?.data).toMatchObject({ reason: 'completed' })
    // The step the killed process left open is closed by the retry transaction. Without that close,
    // runInference writes a second step/start into a lane that still holds one, relations refuses it,
    // and the turn is abandoned rather than resumed - so the counts and the order are asserted, not
    // only the outcome.
    const t = await types(log)
    expect(t.filter((x) => x === 'step/start')).toHaveLength(2)
    expect(t.filter((x) => x === 'step/end')).toHaveLength(2)
    expect(t.indexOf('step/end')).toBeLessThan(t.lastIndexOf('step/start'))
    // Re-derivation preserves the original header identity while each actual dispatch gets its own
    // provider receipt. Both receipts remain causally after the durable header, and the resumed
    // dispatch's receipt lands before its first visible output.
    expect(t.filter((x) => x === 'request/header')).toHaveLength(1)
    expect(t.filter((x) => x === 'request/sent')).toHaveLength(2)
    const headerAt = t.indexOf('request/header')
    const receipts = t.flatMap((type, index) => (type === 'request/sent' ? [index] : []))
    expect(receipts.every((index) => headerAt < index)).toBe(true)
    expect(receipts.at(-1)).toBeLessThan(t.indexOf('assistant/output'))
    // No invariant row: the turn was resumed, not lost and repaired.
    expect(t).not.toContain('x/core/invariant')
    // The tokens the dead request had already burned are charged, and marked as unfinished.
    const costs = await log.scan({ type: 'cost/ledger', limit: 10 })
    expect(costs[0]?.data).toMatchObject({ interrupted: true, model: 'primary' })
  })

  // The other phase. The defect hid in one and not the other, so the tools phase gets its own
  // end-to-end case rather than being assumed to follow.
  it('a session killed mid-tool-call resumes and finishes the turn it was in', async () => {
    const { session, log } = await crashInToolCall('read')
    const resumed = await session.resume()
    expect(resumed.actions).toEqual([{ effectId: expect.any(String), action: 'rerun' }])
    // Attempt two retains the exact effect whose first dispatch became ambiguous. Minting a new
    // effect would reset the retry budget after another crash and allow an unbounded replay loop.
    const phase = session.op()?.phase as { batch: { calls: Array<Record<string, unknown>> } } | undefined
    const replanned = phase?.batch.calls ?? []
    expect(replanned).toHaveLength(1)
    expect(replanned[0]).toMatchObject({
      status: 'dispatch_pending',
      effectId: resumed.actions[0]?.effectId,
      dispatchAttempt: 2,
    })
    expect(replanned[0]).not.toHaveProperty('dispatchPhase')
    // And the step stays open: it owns the call, and the tools phase closes it when the batch is
    // done. Closing it here would leave the re-run writing its result into no step at all.
    expect(session.state.openStep.get('main')).toMatchObject({ turn: 1, step: 1 })
    const out = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(out.reason).toBe('completed')
    // Run once, recorded once: the call the dead process started left no result, and the re-run's is
    // the only one.
    expect(await log.scan({ type: 'tool/result', limit: 10 })).toHaveLength(1)
    // inference, the one durable tool effect reused by attempt two, and the second inference.
    expect(await log.scan({ type: 'effect/intent', limit: 10 })).toHaveLength(3)
    // A re-run stays inside the step it was killed in - that step still owns the call - so the resume
    // must NOT close it. Two steps and two closes, both written by the phases themselves.
    const t = await types(log)
    expect(t.filter((x) => x === 'step/start')).toHaveLength(2)
    expect(t.filter((x) => x === 'step/end')).toHaveLength(2)
    expect(await log.scan({ type: 'turn/end', limit: 5 })).toHaveLength(1)
  })

  it('does not grant a third safe-read dispatch after attempt two also crashes', async () => {
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let attemptTwoExecutions = 0
    const second = await crashInToolCall('read', {
      run: async () => {
        attemptTwoExecutions++
        entered()
        await gate
        return { content: [{ type: 'text', text: 'attempt two returned after the crash' }] }
      },
    })
    expect((await second.session.resume()).actions).toEqual([
      { effectId: expect.any(String), action: 'rerun' },
    ])
    const running = second.session.runToolsPhase().catch(() => undefined)
    await started
    expect(second.session.op()?.phase).toMatchObject({
      kind: 'tools',
      batch: {
        calls: [
          expect.objectContaining({
            status: 'dispatched',
            dispatchAttempt: 2,
            dispatchPhase: 'may_have_sent',
          }),
        ],
      },
    })
    await second.log.close()
    release()
    await running

    let forbiddenAttemptThree = 0
    const registry = new ToolRegistry()
    registry.add(
      readTool(async () => {
        forbiddenAttemptThree++
        return { content: [{ type: 'text', text: 'must not run' }] }
      }),
      { source: 's', trust: 'builtin' },
    )
    const third = await openSession({
      provider: fakeProvider([]),
      registry,
      storage: second.storage,
      key: 'k',
      writerRunId: 'third-process',
    })
    expect((await third.session.resume()).actions).toEqual([
      { effectId: expect.any(String), action: 'unknown' },
    ])
    expect(attemptTwoExecutions).toBe(1)
    expect(forbiddenAttemptThree).toBe(0)
    expect((await third.log.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.data).toMatchObject({
      code: 'TOOL_OUTCOME_UNKNOWN',
    })
    expect(
      (await third.log.scan({ type: 'effect/intent', limit: 20 })).filter(
        (row) => (row.data as { kind?: unknown }).kind === 'tool',
      ),
    ).toHaveLength(1)
  })

  it('settles an interrupted guardian and falls back to human approval without rerunning it', async () => {
    const storage = new MemoryStorage()
    const registry = new ToolRegistry()
    let executions = 0
    registry.add(
      shellTool(async () => {
        executions++
        return { content: [{ type: 'text', text: 'executed after human approval' }] }
      }),
      { source: 's', trust: 'builtin' },
    )
    let guardianEntered!: () => void
    let releaseGuardian!: () => void
    const entered = new Promise<void>((resolve) => {
      guardianEntered = resolve
    })
    const blocked = new Promise<never>((_resolve, reject) => {
      releaseGuardian = () => reject(new Error('old process killed'))
    })
    const first = await openSession({
      provider: fakeProvider([toolTurn('shell', { command: 'x' })]),
      registry,
      storage,
      approvalMode: 'smart',
      seams: fakeSeams({
        approval: {
          guard: async () => {
            guardianEntered()
            return blocked
          },
        },
      }),
    })
    await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await first.session.acceptInput()
    await first.session.runInference()
    const abandoned = first.session.runToolsPhase().catch(() => undefined)
    await entered
    expect(first.session.pendingEffects()).toEqual([
      expect.objectContaining({
        kind: 'approval-guardian',
        tool: expect.objectContaining({ name: 'shell' }),
      }),
    ])
    await first.log.close()
    releaseGuardian()
    await abandoned

    let resumedGuardianCalls = 0
    let humanAsks = 0
    const reopened = await openSession({
      provider: fakeProvider([]),
      registry,
      storage,
      key: 'k',
      writerRunId: 'guardian-reopen',
      approvalMode: 'smart',
      seams: fakeSeams({
        approval: {
          guard: async () => {
            resumedGuardianCalls++
            return { decision: 'allow-once', ruleVersion: 'must-not-run', reasons: [] }
          },
          ask: async (request) => {
            humanAsks++
            return { ticket: 'guardian-fallback', expiresAt: request.deadline }
          },
        },
      }),
    })
    const report = await reopened.session.resume()
    expect(report.actions).toEqual([{ effectId: expect.any(String), action: 'error' }])
    expect(
      (await reopened.log.scan({ type: 'effect/settled', order: 'desc', limit: 1 }))[0]?.data,
    ).toMatchObject({
      outcome: 'error',
    })
    expect(
      await reopened.log.scan({ type: 'x/core/approval-guardian-failed', order: 'desc', limit: 1 }),
    ).toHaveLength(1)
    expect(await reopened.session.runToolsPhase()).toEqual({ phase: 'terminal', reason: 'parked' })
    expect({ resumedGuardianCalls, humanAsks, executions }).toEqual({
      resumedGuardianCalls: 0,
      humanAsks: 1,
      executions: 0,
    })
    expect(
      (await reopened.log.scan({ type: 'approval/asked', order: 'desc', limit: 1 }))[0]?.data,
    ).toMatchObject({
      pending: { ticket: 'guardian-fallback' },
    })
  })

  it('settles a durable responded result without dispatching the tool again', async () => {
    const originalRegistry = new ToolRegistry()
    originalRegistry.add(readTool(), { source: 's', trust: 'builtin' })
    const original = await openSession({
      provider: fakeProvider([toolTurn('read', {})]),
      registry: originalRegistry,
    })
    await original.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await original.session.acceptInput()
    await original.session.runInference()
    await original.session.runToolsPhase()
    const rows = await original.log.scan({ fromSeq: 1, toSeq: original.log.lastSeq, limit: 10_000 })
    const responded = original.opWrites().find((write) => {
      const data = write.data as {
        phase?: { kind?: string; batch?: { calls?: Array<{ status?: string }> } }
      } | null
      return data?.phase?.kind === 'tools' && data.phase.batch?.calls?.[0]?.status === 'responded'
    })
    const respondedAt = rows.findIndex((row) => row.seq === responded?.seq)
    expect(respondedAt).toBeGreaterThan(0)

    let redispatches = 0
    const reopenedRegistry = new ToolRegistry()
    reopenedRegistry.add(
      readTool(async () => {
        redispatches++
        return { content: [{ type: 'text', text: 'must not run' }] }
      }),
      { source: 's', trust: 'builtin' },
    )
    const reopened = await openSession({
      provider: fakeProvider([]),
      registry: reopenedRegistry,
      storage: MemoryStorage.fromEvents('k', rows.slice(0, respondedAt + 1), {
        opCells: original.opCellsBefore((responded?.seq ?? 0) + 1),
      }),
      key: 'k',
      writerRunId: 'responded-reopen',
    })
    expect((await reopened.session.resume()).actions).toEqual([
      { effectId: expect.any(String), action: 'settle' },
    ])
    expect(redispatches).toBe(0)
    expect(await reopened.log.scan({ type: 'tool/result', limit: 10 })).toHaveLength(1)
    expect(
      (await reopened.log.scan({ type: 'effect/settled', order: 'desc', limit: 1 }))[0]?.data,
    ).toMatchObject({ outcome: 'ok' })
  })

  it('close mode distinguishes approved from dispatched calls', async () => {
    const beforeDispatch = await openSession({
      provider: fakeProvider([toolTurn('read', {})]),
      registry: (() => {
        const tools = new ToolRegistry()
        tools.add(readTool(), { source: 's', trust: 'builtin' })
        return tools
      })(),
    })
    await beforeDispatch.session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'go' }],
      actor,
    })
    await beforeDispatch.session.acceptInput()
    await beforeDispatch.session.runInference()
    const op = beforeDispatch.session.op()
    if (op?.phase.kind !== 'tools') throw new Error('expected tools phase')
    await beforeDispatch.session.transition(
      [],
      withPhase(op, {
        ...op.phase,
        batch: {
          ...op.phase.batch,
          calls: op.phase.batch.calls.map((call) => ({ ...call, status: 'approved' }) as ToolCallState),
        },
      }),
    )
    await beforeDispatch.session.resume({ mode: 'close' })
    expect(
      (await beforeDispatch.log.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.data,
    ).toMatchObject({ code: 'TOOL_NOT_STARTED' })

    const afterDispatch = await crashInToolCall('shell')
    await afterDispatch.session.resume({ mode: 'close' })
    expect(
      (await afterDispatch.log.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.data,
    ).toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' })
    expect(
      (await afterDispatch.log.scan({ type: 'effect/settled', order: 'desc', limit: 1 }))[0]?.data,
    ).toMatchObject({ outcome: 'unknown' })
  })

  it('cancels an approved call without invoking the result hook', async () => {
    const registry = new ToolRegistry()
    registry.add(readTool(), { source: 's', trust: 'builtin' })
    const opened = await openSession({
      provider: fakeProvider([toolTurn('read', {})]),
      registry,
    })
    await opened.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await opened.session.acceptInput()
    await opened.session.runInference()
    const op = opened.session.op()
    if (op?.phase.kind !== 'tools') throw new Error('expected tools phase')
    await opened.session.transition(
      [],
      withPhase(op, {
        ...op.phase,
        batch: {
          ...op.phase.batch,
          calls: op.phase.batch.calls.map((call) => ({ ...call, status: 'approved' }) as ToolCallState),
        },
      }),
    )
    let resultHooks = 0
    opened.session.hooks = {
      ...opened.session.hooks,
      toolResult: async (input) => {
        resultHooks++
        return { result: input.result }
      },
    }
    await opened.session.abort(actor)
    expect(await opened.session.step()).toEqual({ phase: 'terminal', reason: 'aborted' })
    expect(resultHooks).toBe(0)
    expect((await opened.log.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.data).toMatchObject({
      code: 'CANCELLED',
    })
  })

  it('a tool that must not be replayed becomes TOOL_OUTCOME_UNKNOWN and parks the turn', async () => {
    const { session, log } = await crashInToolCall('shell')
    expect((await session.resume()).actions[0]?.action).toBe('unknown')
    const result = (await log.scan({ type: 'tool/result', limit: 10 }))[0]
    expect(result?.data).toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN', isError: true })
    // It names the call it closes. Relations accepts a synthetic closer only when it does.
    expect(result?.sourceEventSeqs).toHaveLength(1)
    expect((await log.scan({ type: 'approval/asked', limit: 10 })).at(-1)?.data).toMatchObject({
      kind: 'unknown-outcome',
    })
    expect(session.op()).toBeNull()
    expect((await log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({ reason: 'parked' })
    // The turn is parked, so the step it was in is closed with it: a turn/end beside an open step is
    // refused, and this is a path where one is still open.
    expect((await types(log)).filter((x) => x === 'step/end')).toHaveLength(1)
  })

  it.each(['allowed-once', 'rejected'] as const)(
    'requires a human callback to resolve unknown as %s without replay',
    async (verdict) => {
      let executions = 0
      let receipt: { requestId: string; bindingHash: string; expiresAt: string } | undefined
      const seams = fakeSeams({
        approval: {
          ask: async (request) => {
            receipt = {
              requestId: request.requestId,
              bindingHash: request.bindingHash,
              expiresAt: request.deadline,
            }
            return { ticket: 'unknown-ticket', expiresAt: request.deadline }
          },
          resume: async () => receipt ?? null,
        },
      })
      const { session, log } = await crashInToolCall('shell', {
        seams,
        run: async () => {
          executions++
          return { content: [{ type: 'text', text: 'deliberate retry' }] }
        },
      })

      expect((await session.resume()).actions[0]?.action).toBe('unknown')
      expect(executions).toBe(0)
      expect((await log.scan({ type: 'approval/asked', limit: 10 })).at(-1)?.data).toMatchObject({
        kind: 'unknown-outcome',
        pending: { ticket: 'unknown-ticket' },
      })
      await session.resumeApproval('unknown-ticket', verdict, { ...actor, id: 'human-approver' })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      expect(executions).toBe(0)
      expect(await log.scan({ type: 'approval/decided', limit: 10 })).toContainEqual(
        expect.objectContaining({ data: expect.objectContaining({ verdict, via: 'callback' }) }),
      )
    },
  )

  // askUnknownOutcome's approvalAsk call fires the same approval_request hook as the tool-approval
  // path in tools.ts, the park path in gate.ts, and quoteBudget in calibrate.ts — the design's ruling
  // that the hook describes "any request for human approval", not "only a tool approval". This ask
  // has no tool call behind it, so `tool` names the approval's own kind, and its risk ('unknown') has
  // no member in extension-api's ApprovalRequest risk enum, so it maps to 'always' in the hook payload.
  it('fires approval_request from askUnknownOutcome on resume, and an override reaches the ledger', async () => {
    const { session, log } = await crashInToolCall('shell')
    let seenRequest: unknown
    session.hooks = {
      ...session.hooks,
      approvalRequest: async (p) => {
        seenRequest = p.request
        return { request: { summary: 'escalated by extension' } }
      },
    }
    expect((await session.resume()).actions[0]?.action).toBe('unknown')
    expect(seenRequest).toMatchObject({
      tool: 'unknown-outcome',
      argv: null,
      risk: 'always',
      actor: expect.objectContaining({ id: 'u' }),
      summary: expect.stringContaining('did shell happen?'),
    })
    expect((await log.scan({ type: 'approval/asked', limit: 10 })).at(-1)?.data).toMatchObject({
      kind: 'unknown-outcome',
      summary: 'escalated by extension',
    })
  })

  // Persisted policy is authoritative; a newly registered definition is compared through its
  // registration-time fingerprint rather than by re-reading mutable meta or reclassifying args.
  it('a tool whose definition fingerprint changed while the process was down is not replayed', async () => {
    const changed: Parameters<ToolRegistry['add']>[0] = readTool()
    changed.meta = { ...changed.meta, isOpenWorld: true }
    const { session } = await crashInToolCall('read', { tool: changed })
    expect((await session.resume()).actions[0]?.action).toBe('unknown')
  })

  it('an interrupted inference with no attempts left drains to an error instead of retrying', async () => {
    const preset = retryOnce()
    const { storage } = await crashInInference({ preset })
    const { session, log } = await reopen(storage, preset)
    expect((await session.resume()).actions[0]?.action).toBe('error')
    expect(session.op()?.phase).toMatchObject({ kind: 'failure_drain', error: { code: 'INTERRUPTED' } })
    // The step is closed by the resume, not left for the next writer. A drain that leaves it open
    // still ends the turn - by having its turn/end refused, the run loop giving up and the repair
    // path closing both - so the counts alone cannot tell the two apart. The open-step map can.
    expect(session.state.openStep.get('main')).toBeUndefined()
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'error',
    )
    const t = await types(log)
    expect(t.filter((x) => x === 'step/start')).toHaveLength(1)
    expect(t.filter((x) => x === 'step/end')).toHaveLength(1)
    // The turn ends on the interruption it drained on, not on a repair of a refused close.
    expect(t).not.toContain('x/core/invariant')
    expect((await log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({
      error: { code: 'INTERRUPTED' },
    })
  })

  it('an inference interrupted after a cancellation settles as aborted, not as a retry', async () => {
    const { storage } = await crashInInference({ abortFirst: true })
    const { session, log } = await reopen(storage)
    expect((await session.resume()).actions[0]?.action).toBe('aborted')
    expect(session.state.openStep.get('main')).toBeUndefined()
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'aborted',
    )
    expect((await types(log)).filter((x) => x === 'step/end')).toHaveLength(1)
  })

  // The path every session takes between two turns, which is also the path that worked before this
  // task and has to keep working. A kill here leaves no open turn, so there is nothing to rebuild and
  // nothing to close - and a resume that wrote a step/end or reopened the finished turn would be
  // caught by the equality below.
  it('a kill between turns resumes to idle and the next turn runs untouched', async () => {
    const storage = new MemoryStorage()
    const a = await openSession({ provider: fakeProvider([textTurn('one')]), storage })
    await a.session.enqueue('next-turn', { content: [{ type: 'text', text: 'first' }], actor })
    expect((await a.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    const before = await types(a.log)
    await a.log.close()
    const { session, log } = await openSession({
      provider: fakeProvider([textTurn('two')]),
      storage,
      key: 'k',
    })
    expect(await session.resume()).toEqual({ state: 'idle', actions: [] })
    expect(await types(log)).toEqual(before)
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'second' }], actor })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(
      (await log.scan({ type: 'turn/start', limit: 5 })).map((e) => (e.data as { turn: number }).turn),
    ).toEqual([1, 2])
    const t = await types(log)
    expect(t.filter((x) => x === 'step/start')).toHaveLength(2)
    expect(t.filter((x) => x === 'step/end')).toHaveLength(2)
    expect(t).not.toContain('x/core/invariant')
  })

  // What the interrupted request cost is estimated from the words that actually arrived, not from
  // nothing and not from the whole answer that never came. Charging zero for a stream that had
  // already run would let a route that dies late be retried for free.
  it('an interrupted inference is charged for the output that had already arrived', async () => {
    const storage = new MemoryStorage()
    const a = await openSession({ provider: hangingModelAfter('x'.repeat(600)), storage })
    await a.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await a.session.step()
    await a.session.step()
    void a.session.step().catch(() => undefined)
    await new Promise((r) => setTimeout(r, 10))
    await a.log.close()
    const { session, log } = await reopen(storage)
    // The output count the dying process had already written is the only evidence of what was
    // produced: the text itself was never a ledger row.
    expect(await log.scan({ type: 'assistant/output', limit: 5 })).toHaveLength(1)
    expect((await session.resume()).actions[0]?.action).toBe('retry')
    expect((await log.scan({ type: 'cost/ledger', limit: 5 }))[0]?.data).toMatchObject({
      interrupted: true,
      tokens: { input: 0, output: 150, cacheRead: 0, cacheWrite: 0 },
    })
  })

  it('an interrupted compaction is settled as failed and the phase it was to resume into is kept', async () => {
    const { storage } = await crashInInference({
      extra: { effectId: 'cmp-1', kind: 'compaction', replay: 'never' },
    })
    const { session, log } = await reopen(storage)
    expect((await session.resume()).actions.map((x) => x.action)).toEqual(['error', 'retry'])
    expect(
      (await log.scan({ type: 'x/core/compaction-failed', limit: 5 })).map(
        (e) => (e.data as { effectId: string }).effectId,
      ),
    ).toEqual(['cmp-1'])
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
  })

  // The branch nothing else here reaches: an effect whose kind the resume has no replay rule for is
  // reported for polling and left outstanding. Settling it would tell the ledger a job finished that
  // nobody watched.
  it('a job effect in flight is reported for polling and is left unsettled', async () => {
    const { storage } = await crashInInference({
      extra: { effectId: 'job-1', kind: 'job', replay: 'safe' },
    })
    const { session } = await reopen(storage)
    expect((await session.resume()).actions).toEqual([
      { effectId: 'job-1', action: 'poll' },
      { effectId: expect.any(String), action: 'retry' },
    ])
    expect(session.pendingEffects().map((e) => e.effectId)).toEqual(['job-1'])
  })

  it('an interrupted media effect becomes unknown without retry or fabricated inference cost', async () => {
    const { storage } = await crashInInference({
      extra: { effectId: 'media-1', kind: 'media', replay: 'never', slot: 'image' },
    })
    const { session, log } = await reopen(storage)
    expect((await session.resume()).actions).toEqual([
      { effectId: 'media-1', action: 'unknown' },
      { effectId: expect.any(String), action: 'retry' },
    ])
    expect(
      (await log.scan({ type: 'effect/settled', limit: 10 })).find(
        (event) => (event.data as { effectId?: string }).effectId === 'media-1',
      )?.data,
    ).toMatchObject({ effectId: 'media-1', outcome: 'unknown' })
    expect(
      (await log.scan({ type: 'cost/ledger', limit: 10 })).some(
        (event) => (event.data as { effectId?: string }).effectId === 'media-1',
      ),
    ).toBe(false)
  })

  it('close mode also preserves an interrupted media effect as unknown', async () => {
    const { storage } = await crashInInference({
      extra: { effectId: 'media-close', kind: 'media', replay: 'never', slot: 'image' },
    })
    const { session } = await reopen(storage)
    expect((await session.resume({ mode: 'close' })).actions).toEqual([
      { effectId: 'media-close', action: 'unknown' },
      { effectId: expect.any(String), action: 'error' },
    ])
  })

  // The slot fallback, walked rather than reasoned about. An inference effect that names no slot
  // cannot be attributed, and charging it to the primary slot writes a fact into the ledger that
  // nobody established.
  it('an inference effect naming no slot is charged to no slot rather than to the primary one', async () => {
    const { storage } = await crashInInference({
      extra: { effectId: 'inf-x', kind: 'inference', replay: 'never' },
    })
    const { session, log } = await reopen(storage)
    expect((await session.resume()).actions.map((x) => x.action)).toEqual(['retry', 'error'])
    expect(
      (await log.scan({ type: 'cost/ledger', limit: 10 })).map((e) => (e.data as { model: string }).model),
    ).toEqual(['unknown', 'primary'])
  })

  // The corrupt-counter branch: a pending inference effect under a phase that is not an inference.
  // Defaulting the attempt to 0 there would reset the retry budget and let a wedged route be retried
  // for ever, so the gap is recorded and the budget is treated as spent.
  it('a pending inference under a non-inference phase is recorded and treated as out of attempts', async () => {
    const { storage } = await crashInInference()
    const { session, log } = await reopen(storage)
    const cur = session.op()
    if (!cur) throw new Error('the reopened ledger lost the turn')
    await session.transition(
      [],
      withPhase(cur, { kind: 'checkpoint', continuation: 'need_assistant', triggerSeq: cur.meta.triggerSeq }),
    )
    expect((await session.resume()).actions[0]?.action).toBe('error')
    expect(
      (await log.scan({ type: 'x/core/invariant', limit: 5 })).map((e) => (e.data as { kind: string }).kind),
    ).toEqual(['resume-attempt-unknown'])
  })
})

describe('resume and a run in progress exclude each other', () => {
  it('refuses to resume while a run is in progress', async () => {
    const { session } = await openSession({ provider: hangingModel() })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const ac = new AbortController()
    const running = session.run({ until: 'turn-end', signal: ac.signal })
    await new Promise((r) => setTimeout(r, 10))
    expect(session.op()).not.toBeNull()
    await expect(session.resume()).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
    ac.abort()
    await running.catch(() => undefined)
  })

  it('lets a run wait for a resume in progress and then finish the turn', async () => {
    const { storage } = await crashInInference()
    const { session, log } = await reopen(storage)
    const resumed = session.resume()
    const out = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect((await resumed).actions[0]?.action).toBe('retry')
    expect(out.reason).toBe('completed')
    expect(await types(log)).not.toContain('x/core/invariant')
  })

  it('does not restore a turn a second time once it has been restored', async () => {
    const { storage } = await crashInInference()
    const { session } = await reopen(storage)
    await session.resume()
    const restored = session.turn
    expect(restored).not.toBeNull()
    expect(await session.resume()).toMatchObject({ state: 'resumed', actions: [] })
    expect(session.turn).toBe(restored)
    const out = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(out.reason).toBe('completed')
  })
})

describe('a run waiting behind a resume', () => {
  it('does not step until the resume is done, and keeps a second resume out the whole time', async () => {
    const { storage } = await crashInInference()
    const { session } = await reopen(storage)
    let release!: () => void
    let held: Promise<void> | undefined = new Promise<void>((resolve) => {
      release = resolve
    })
    const scan = storage.scan.bind(storage)
    storage.scan = async (k, q) => {
      if (held) await held
      return scan(k, q)
    }
    const resumed = session.resume()
    let stepped = false
    const step = session.step.bind(session)
    session.step = () => {
      stepped = true
      return step()
    }
    const running = session.run({ until: 'turn-end', signal: new AbortController().signal })
    await new Promise((r) => setTimeout(r, 20))
    expect(stepped).toBe(false)
    await expect(session.resume()).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
    held = undefined
    release()
    await resumed
    // The resume is over but the run it held back has not started: a resume now would race it.
    await expect(session.resume()).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
    expect((await running).reason).toBe('completed')
    expect(stepped).toBe(true)
  })
})
