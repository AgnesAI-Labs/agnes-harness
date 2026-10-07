import type { InferenceEvent, Provider } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { CORE_CHECKS } from '../src/invariants/core-checks.js'
import { InvariantRegistry } from '../src/invariants/registry.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { foldEvents } from '../src/reduce/reducer.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { withPhase } from '../src/step/op-state.js'
import { type HookPort, noopHooks } from '../src/step/session.js'
import { CoreError } from '../src/types.js'
import {
  fakeProvider,
  type Script,
  sent,
  sentFor,
  textTurn,
  toolTurn,
  usage,
} from './helpers/fake-provider.js'
import { actor, openSession, shellTool } from './helpers/open-session.js'

/** Two calls of a tool that is not concurrency safe, so the second only starts after the first. */
const twoCalls: Script = [
  sent(),
  { type: 'toolcall_end', call: { toolUseId: '', name: 'slow', args: { i: 1 }, ordinal: 0 }, via: 'native' },
  { type: 'toolcall_end', call: { toolUseId: '', name: 'slow', args: { i: 2 }, ordinal: 1 }, via: 'native' },
  usage(),
  { type: 'done', reason: 'toolUse' },
] as Script

const slowTool = (fn: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>) =>
  ({
    name: 'slow',
    description: 'slow',
    parameters: Type.Object({}),
    meta: {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'safe' as const,
      costHint: undefined,
      deferLoading: undefined,
      requiresApproval: undefined,
    },
    execute: fn,
  }) as never

const wait = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))

function slowRegistry(started: string[]): ToolRegistry {
  const r = new ToolRegistry()
  r.add(
    slowTool(async (args) => {
      started.push(JSON.stringify(args))
      await wait(40)
      return { content: [{ type: 'text' as const, text: 'ran' }] }
    }),
    { source: 's', trust: 'builtin' },
  )
  return r
}

/** A provider that starts a stream and then hangs until the session's own signal cuts it. */
const hangingProvider = (): Provider => ({
  models: () => [],
  async *infer(req, o): AsyncIterable<InferenceEvent> {
    yield sentFor(req)
    yield { type: 'text_delta', delta: 'part' }
    await new Promise<void>((res) => o.signal.addEventListener('abort', () => res(), { once: true }))
    throw new Error('stream cut')
  },
})

const types = async (log: { scan: (q: never) => Promise<Array<{ type: string }>> }) =>
  (await log.scan({ fromSeq: 1, limit: 500 } as never)).map((e) => e.type)

describe('abort during the tools phase', () => {
  it('ends the turn on the ledger and answers the call it stopped', async () => {
    const started: string[] = []
    const ac = new AbortController()
    const { session, log } = await openSession({
      provider: fakeProvider([twoCalls]),
      registry: slowRegistry(started),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const run = session.run({ until: 'turn-end', signal: ac.signal })
    await wait(15)
    ac.abort()
    expect((await run).reason).toBe('aborted')

    // Only the first call ever ran; the second was stopped before it started.
    expect(started).toEqual(['{"i":1}'])
    const results = await log.scan({ type: 'tool/result', limit: 10 })
    expect(results).toHaveLength(2)
    const cancelled = results[1]?.data as { code?: string; cancelledBy?: { id: string } }
    expect(cancelled.code).toBe('CANCELLED')
    expect(cancelled.cancelledBy?.id).toBe('u')

    // The cancellation is on the counter before anything is settled off it.
    const t = await types(log as never)
    const cancelSeq = (await log.scan({ type: 'x/core/op-mark', limit: 100 })).findIndex(
      (e) => (e.data as { control?: string } | null)?.control === 'cancel_requested',
    )
    expect(cancelSeq).toBeGreaterThan(-1)

    // The terminal rows the next reader needs: the step closes, then the turn.
    expect(t.slice(-2)).toEqual(['step/end', 'turn/end'])
    expect((await log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({ reason: 'aborted' })
    expect(session.op()).toBeNull()
  })

  it('records a Stop on a running mutating call as cancelled, and the ledger stays consistent', async () => {
    let started!: () => void
    const running = new Promise<void>((res) => {
      started = res
    })
    const registry = new ToolRegistry()
    registry.add(
      shellTool(
        (_args, ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener(
              'abort',
              () => resolve({ content: [{ type: 'text', text: 'killed' }] }),
              { once: true },
            )
            started()
          }),
      ),
      { source: 's', trust: 'builtin' },
    )
    const ac = new AbortController()
    const { session, log } = await openSession({
      provider: fakeProvider([toolTurn('shell', { command: 'sleep 30' })]),
      registry,
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const run = session.run({ until: 'turn-end', signal: ac.signal })
    await running
    ac.abort()
    expect((await run).reason).toBe('aborted')

    const result = (await log.scan({ type: 'tool/result', limit: 10 }))[0]
    expect(result?.data).toMatchObject({
      isError: true,
      code: 'CANCELLED',
      partial: true,
      cancelledBy: { id: 'u' },
    })
    const settled = (await log.scan({ type: 'effect/settled', order: 'desc', limit: 1 }))[0]
    expect(settled?.data).toMatchObject({ outcome: 'aborted' })
    // The request is on the ledger before the settlement it licenses.
    const marks = await log.scan({ type: 'x/core/op-mark', limit: 100 })
    const cancelMark = marks.find(
      (e) => (e.data as { control?: string } | null)?.control === 'cancel_requested',
    )
    expect(cancelMark?.seq).toBeLessThan(settled?.seq ?? 0)
    expect((await log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({ reason: 'aborted' })
    expect(session.op()).toBeNull()

    const checks = new InvariantRegistry()
    checks.register('@agnes/core', CORE_CHECKS)
    const events = await log.scan({ fromSeq: 1, limit: 500 } as never)
    expect(checks.run(events, foldEvents([]))).toEqual([])
  })

  it('does not wedge the session: a later run() is not stuck reporting aborted', async () => {
    const ac = new AbortController()
    const provider = fakeProvider([twoCalls])
    const { session } = await openSession({ provider, registry: slowRegistry([]) })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const run = session.run({ until: 'turn-end', signal: ac.signal })
    await wait(15)
    ac.abort()
    await run

    // Nothing is queued, so the honest answer is "there was nothing to do", not "aborted".
    const again = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(again.reason).toBe('completed')
  })

  it('answers a prompt queued after the abort', async () => {
    const ac = new AbortController()
    const provider = fakeProvider([twoCalls, textTurn('answer')])
    const { session, log } = await openSession({ provider, registry: slowRegistry([]) })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const run = session.run({ until: 'turn-end', signal: ac.signal })
    await wait(15)
    ac.abort()
    await run

    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'again' }], actor })
    const second = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(second.reason).toBe('completed')
    const ends = await log.scan({ type: 'turn/end', limit: 10 })
    expect(ends.map((e) => (e.data as { reason: string }).reason)).toEqual(['aborted', 'completed'])
    const said = await log.scan({ type: 'assistant/message', limit: 10 })
    expect(JSON.stringify(said[said.length - 1]?.data)).toContain('answer')
  })

  it('leaves a ledger a fresh process can carry on from', async () => {
    const storage = new MemoryStorage()
    const ac = new AbortController()
    const { session } = await openSession({
      storage,
      provider: fakeProvider([twoCalls]),
      registry: slowRegistry([]),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const run = session.run({ until: 'turn-end', signal: ac.signal })
    await wait(15)
    ac.abort()
    await run
    await session.close()

    const next = await openSession({ storage, provider: fakeProvider([textTurn('fresh')]) })
    await next.session.enqueue('next-turn', { content: [{ type: 'text', text: 'again' }], actor })
    const out = await next.session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(out.reason).toBe('completed')
  })
})

describe('abort during inference', () => {
  it('still settles the stream and closes the step, and now ends the turn too', async () => {
    const ac = new AbortController()
    const { session, log } = await openSession({ provider: hangingProvider() })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    const run = session.run({ until: 'turn-end', signal: ac.signal })
    await wait(15)
    ac.abort()
    expect((await run).reason).toBe('aborted')

    // Unchanged: the spend is recorded as interrupted, the effect settles aborted, the step closes.
    const cost = await log.scan({ type: 'cost/ledger', limit: 5 })
    expect(cost[0]?.data).toMatchObject({ interrupted: true })
    const settled = await log.scan({ type: 'effect/settled', limit: 5 })
    expect(settled[0]?.data).toMatchObject({ outcome: 'aborted' })
    const t = await types(log as never)
    expect(t).toContain('step/end')

    // Added: the turn no longer waits for a second run() to find out it is over.
    expect((await log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({
      reason: 'aborted',
      error: { code: 'ABORTED' },
    })
    expect(session.op()).toBeNull()
  })

  it('leaves a ledger a fresh process can carry on from', async () => {
    const storage = new MemoryStorage()
    const ac = new AbortController()
    const { session } = await openSession({ storage, provider: hangingProvider() })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    const run = session.run({ until: 'turn-end', signal: ac.signal })
    await wait(15)
    ac.abort()
    await run
    await session.close()

    const next = await openSession({ storage, provider: fakeProvider([textTurn('fresh')]) })
    await next.session.enqueue('next-turn', { content: [{ type: 'text', text: 'again' }], actor })
    const out = await next.session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(out.reason).toBe('completed')
    expect((await next.log.scan({ type: 'turn/end', limit: 5 })).length).toBe(2)
  })
})

describe('abort before the turn opens', () => {
  /** The cancel the ledger carries: it has to precede the turn's end, whoever delivered it. */
  const cancelMarks = async (log: { scan: (q: never) => Promise<Array<{ data: unknown }>> }) =>
    (await log.scan({ type: 'x/core/op-mark', limit: 100 } as never)).filter(
      (e) => (e.data as { control?: string } | null)?.control === 'cancel_requested',
    )

  it.each(['the signal was aborted before run()', 'session.abort() landed right after run()'] as const)(
    'records the cancel once the turn exists when %s',
    async (how) => {
      const ac = new AbortController()
      const { session, log } = await openSession({ provider: hangingProvider() })
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
      if (how.startsWith('the signal')) ac.abort()
      const run = session.run({ until: 'turn-end', signal: ac.signal })
      // No turn is open yet: this is the window a Stop sent right behind a Send lands in.
      if (how.startsWith('session')) await session.abort()
      expect((await run).reason).toBe('aborted')

      expect(await cancelMarks(log as never)).toHaveLength(1)
      expect((await log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({ reason: 'aborted' })
      // A model request that never started has nothing to settle as aborted without a cancel on file.
      for (const e of await log.scan({ type: 'effect/settled', limit: 10 }))
        expect(e.data).not.toMatchObject({ outcome: 'aborted' })
      expect(session.op()).toBeNull()
    },
  )
})

describe('abort while a hook is running', () => {
  /**
   * What the real dispatcher does to a fail-closed hook whose caller has gone away: the hook counts
   * as failed. The turn must still end as the stop the user asked for, not as that failure.
   */
  it.each(['before_step', 'context'] as const)(
    'ends the turn aborted, not blocked or failed, when the %s hook is cut by the cancel',
    async (which) => {
      let entered: () => void = () => undefined
      const inHook = new Promise<void>((resolve) => (entered = resolve))
      let signal: AbortSignal | undefined
      const cut = async (): Promise<void> => {
        entered()
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        )
      }
      const hooks: HookPort = {
        ...noopHooks,
        ...(which === 'before_step'
          ? {
              beforeStep: async () => {
                await cut()
                return { block: true, reason: 'hook execution failed' }
              },
            }
          : {
              context: async () => {
                await cut()
                throw new CoreError('E_ENVELOPE', 'hook rejected transformation')
              },
            }),
      }
      const ac = new AbortController()
      const { session, log } = await openSession({ provider: hangingProvider(), hooks })
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
      const run = session.run({ until: 'turn-end', signal: ac.signal })
      signal = session.ac.signal
      await inHook
      ac.abort()
      const out = await run
      expect(out.reason).toBe('aborted')
      expect(out.error).toBeUndefined()
      const end = (await log.scan({ type: 'turn/end', limit: 5 }))[0]?.data as { error?: { code: string } }
      expect(end).toMatchObject({ reason: 'aborted' })
      expect(end.error?.code).not.toBe('HOOK_BLOCKED')
      expect(end.error?.code).not.toBe('E_STEP_FAILED')
      expect(await types(log as never)).not.toContain('x/core/invariant')
      expect(session.op()).toBeNull()
    },
  )
})

describe('the run loop bounds', () => {
  it('closes a turn that still has a step open when the no-progress bound fires', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([textTurn('x')]) })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await session.step()
    const op = session.op()
    if (!op) throw new Error('expected an open turn')
    await session.transition(
      [session.ev('step/start', { turn: op.meta.turn, step: 1 })],
      withPhase(op, op.phase),
    )
    // A phase edge that reports where it went without writing where it went, which is the shape the
    // bound exists for. Stubbing it is the only way to hold one still long enough to observe.
    ;(session as unknown as { step: () => Promise<{ outcome: 'running'; phase: string }> }).step = async () => ({
      outcome: 'running',
      phase: 'tools',
    })
    const out = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(out.reason).toBe('error')
    const t = await types(log as never)
    expect(t.slice(-2)).toEqual(['step/end', 'turn/end'])
    expect((await log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({ reason: 'error' })
    expect(session.op()).toBeNull()
  })

  it('contains a hook that throws instead of stranding the turn', async () => {
    const hooks: HookPort = {
      ...noopHooks,
      toolCall: async () => {
        throw new Error('boom')
      },
    }
    const { session, log } = await openSession({
      provider: fakeProvider([twoCalls]),
      registry: slowRegistry([]),
      hooks,
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const out = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(out.reason).toBe('error')
    expect(out.error?.message).toContain('boom')
    const t = await types(log as never)
    expect(t.slice(-2)).toEqual(['step/end', 'turn/end'])
    expect(session.op()).toBeNull()
  })
})
