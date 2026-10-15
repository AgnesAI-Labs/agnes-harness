import { presetDefaults } from '@agnes/core-common/step/preset'
import type { Event } from '@agnes/core-common/types'
import {
  type LoopContext,
  type LoopFactory,
  type LoopSideCallPort,
  type LoopStepOutcome,
  loopCheckpointCodec,
  type SideCallResult,
} from '@agnes/extension-api'
import type { InferenceEvent, RequestBody } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { sentFor } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'
import {
  answer,
  data,
  type Harness,
  ofType,
  options,
  type Row,
  type SideProvider,
  settlements,
  sideCosts,
  sideProvider,
  signal,
  stalled,
  terminals,
  violations,
  withSession,
} from './helpers/side-call-session.js'

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const settledWith = <T>(work: Promise<T>): Promise<{ value?: T; error?: unknown }> =>
  work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
/** Diagnostics naming a side call that was still unsettled when its turn ended. */
const unsettled = (rows: Event[]) =>
  ofType(rows, 'x/core/invariant')
    .map(data)
    .filter((row) => row.kind === 'side-call-unsettled')
const cutByTurnEnd = {
  status: 'failed',
  reason: 'cancelled',
  retryable: false,
  dispatch: 'may-have-sent',
  replayed: false,
}

/**
 * The call was closed inside its turn: settled once, before `turn/end`, as a cancellation by the
 * caller, with one cost row billed once and nothing left pending.
 */
function settledBeforeTurnEnd(rows: Event[], billing: Row[], effectId = 'side:call-1') {
  const settled = settlements(rows).filter((row) => data(row).effectId === effectId)
  const ends = ofType(rows, 'turn/end')
  expect(settled.map((row) => data(row).outcome)).toEqual(['error'])
  expect(settled[0]?.seq).toBeLessThan(ends.at(-1)?.seq ?? 0)
  expect(
    terminals(rows)
      .filter((row) => data(row).effectId === effectId)
      .map((row) => (data(row).terminal as Row).reason),
  ).toEqual(['caller_cancelled'])
  expect(sideCosts(rows).filter((row) => data(row).effectId === effectId)).toHaveLength(1)
  expect(billing.filter((row) => row.effectId === effectId)).toHaveLength(1)
  expect(violations(rows)).toEqual([])
}

/** The next turn of the same session sends a side call and finishes as if nothing had happened. */
async function nextTurnRuns(t: Harness, invocationId: string) {
  expect(t.session.pendingEffects()).toEqual([])
  t.provider.side = answer()
  await t.session.enqueue('next-turn', { content: [{ type: 'text', text: 'again' }], actor })
  expect(await t.session.acceptInput()).toBe(true)
  const prepared = await t.port.prepare(options({ invocationId }))
  expect(await t.port.invoke(prepared, signal())).toMatchObject({ status: 'ok', replayed: false })
  await expect(t.ctx.events.finish('completed')).resolves.toMatchObject({ outcome: 'turn-ended' })
}

/** Holds the billing record of side-call rows until the test lets it go. */
function holdSideBilling(t: Harness) {
  const reached = deferred()
  const release = deferred()
  const record = t.session.d.runtime.billingRecord.bind(t.session.d.runtime)
  vi.spyOn(t.session.d.runtime, 'billingRecord').mockImplementation(async (row) => {
    if (row.purpose === 'side-call') {
      reached.resolve()
      await release.promise
    }
    return record(row)
  })
  return { reached: reached.promise, release: () => release.resolve() }
}

/** Starts a call and returns once the provider has it; the call itself is still running. */
const started = async (t: Harness, invocationId = 'call-1') => {
  const call = t.port.invoke(await t.port.prepare(options({ invocationId })), signal())
  call.catch(() => undefined)
  await vi.waitFor(() => expect(t.provider.calls).toHaveLength(1))
  return { call }
}

describe('a turn that ends while a side call is in flight', () => {
  it('cuts the call and settles it before a loop ends its own turn as cancelled', async () => {
    // The adapter neither answers nor honours its abort; Core still cuts the call at once.
    await withSession({ script: stalled }, async (t) => {
      const { call } = await started(t)
      const began = performance.now()
      await t.ctx.turn.finishCancelled()
      // Settling a cut call is immediate; the ceiling is the settle bound (5 s) less a wide margin.
      expect(performance.now() - began).toBeLessThan(3000)
      expect(t.session.op()).toBeNull()
      expect(await call).toMatchObject(cutByTurnEnd)
      const rows = await t.rows()
      expect(data(ofType(rows, 'turn/end').at(-1)).reason).toBe('aborted')
      settledBeforeTurnEnd(rows, t.billing)
      expect(unsettled(rows)).toEqual([])
      await nextTurnRuns(t, 'call-2')
    })
  })

  it('settles the call before a failed continuation ends the turn', async () => {
    await withSession({ script: stalled }, async (t) => {
      const { call } = await started(t)
      const failing = async function* (request: RequestBody): AsyncIterable<InferenceEvent> {
        yield sentFor(request)
        yield { type: 'error', reason: 'error', code: 'AUTH', message: 'refused', retryable: false }
      }
      const side = t.provider.infer.bind(t.provider)
      t.provider.infer = (request, opts) =>
        request.route === 'side-route' ? side(request, opts) : failing(request)
      await t.ctx.model.respond(signal())
      expect(t.session.op()?.phase.kind).toBe('failure_drain')
      await expect(t.ctx.turn.finishFailure()).resolves.toMatchObject({ reason: 'error' })
      expect(await call).toMatchObject(cutByTurnEnd)
      settledBeforeTurnEnd(await t.rows(), t.billing)
    })
  })

  it('refuses a new call once the turn has begun to end, and writes nothing for it', async () => {
    await withSession({ script: stalled }, async (t) => {
      const billing = holdSideBilling(t)
      const { call } = await started(t)
      const second = await t.port.prepare(options({ invocationId: 'call-2' }))
      const ending = t.ctx.turn.finishCancelled()
      await billing.reached
      await expect(t.port.invoke(second, signal())).rejects.toMatchObject({
        code: 'E_RELATION',
        detail: { reason: 'turn-closing' },
      })
      billing.release()
      await ending
      expect(await call).toMatchObject(cutByTurnEnd)
      const rows = await t.rows()
      expect(ofType(rows, 'effect/intent').filter((row) => data(row).effectId === 'side:call-2')).toEqual([])
      expect(t.provider.calls).toHaveLength(1)
      settledBeforeTurnEnd(rows, t.billing)
    })
  })

  it('waits for a call only as long as its bound, then records which call it left and ends the turn', async () => {
    await withSession({ script: stalled, extra: { closeDrainMs: 150 } }, async (t) => {
      const billing = holdSideBilling(t)
      const { call } = await started(t)
      const began = performance.now()
      await t.ctx.turn.finishCancelled()
      const waited = performance.now() - began
      expect(waited).toBeGreaterThanOrEqual(140)
      expect(waited).toBeLessThan(2000)
      expect(t.session.op()).toBeNull()
      const rows = await t.rows()
      expect(unsettled(rows)).toEqual([{ kind: 'side-call-unsettled', effectId: 'side:call-1' }])
      // The settlement itself was committed before the billing seam held the call up.
      expect(settlements(rows)[0]?.seq).toBeLessThan(ofType(rows, 'turn/end').at(-1)?.seq ?? 0)
      billing.release()
      expect(await call).toMatchObject(cutByTurnEnd)
      settledBeforeTurnEnd(await t.rows(), t.billing)
      await nextTurnRuns(t, 'call-2')
    })
  })

  it('ends the turn after the bound when a call is held before its intent, and the call then writes nothing', async () => {
    const preset = presetDefaults()
    preset.treeBudgetCredits = 10
    await withSession({ preset, extra: { closeDrainMs: 150 } }, async (t) => {
      const reached = deferred()
      const release = deferred()
      const reserve = t.storage.reserve.bind(t.storage)
      vi.spyOn(t.storage, 'reserve').mockImplementation(async (req) => {
        const out = await reserve(req)
        reached.resolve()
        await release.promise
        return out
      })
      const releaseHold = vi.spyOn(t.storage, 'releaseReservation')
      const call = t.port.invoke(await t.port.prepare(options()), signal())
      await reached.promise
      await t.ctx.turn.finishCancelled()
      expect(t.session.op()).toBeNull()
      expect(unsettled(await t.rows())).toEqual([{ kind: 'side-call-unsettled', effectId: 'side:call-1' }])
      release.resolve()
      expect(await call).toMatchObject({ status: 'failed', reason: 'cancelled', dispatch: 'not-sent' })
      const rows = await t.rows()
      expect(ofType(rows, 'effect/intent')).toEqual([])
      expect(releaseHold).toHaveBeenCalledTimes(1)
      expect(t.provider.calls).toHaveLength(0)
      expect(t.session.pendingEffects()).toEqual([])
    })
  })

  it('does not let a turn end that failed to commit block later calls', async () => {
    await withSession({ script: stalled }, async (t) => {
      const billing = holdSideBilling(t)
      const { call } = await started(t)
      const ending = settledWith(t.ctx.turn.finishCancelled())
      await billing.reached
      // Another phase edge lands while the end waits, so the end's own commit is refused.
      await t.session.transition([], (cur) => cur)
      billing.release()
      expect((await ending).error).toMatchObject({ code: 'E_CAS' })
      expect(t.session.op()).not.toBeNull()
      expect(await call).toMatchObject(cutByTurnEnd)
      // The turn is still open and has moved on: a call in it is no longer refused as closing.
      t.provider.side = answer()
      const again = await t.port.prepare(options({ invocationId: 'call-2' }))
      expect(await t.port.invoke(again, signal())).toMatchObject({ status: 'ok' })
      await t.ctx.turn.finishCancelled()
      await nextTurnRuns(t, 'call-3')
    })
  })

  it('does not wait a second time when close ends the turn after its own drain', async () => {
    await withSession({ script: stalled, extra: { closeDrainMs: 1000 } }, async (t) => {
      const billing = holdSideBilling(t)
      const { call } = await started(t)
      const began = performance.now()
      await t.session.close()
      const closing = performance.now() - began
      expect(closing).toBeGreaterThanOrEqual(990)
      // Waiting again for the same call after the drain would take another full bound (2 s in all).
      expect(closing).toBeLessThan(1900)
      billing.release()
      // Close released the loop's scope before the call returned, so its caller sees the close.
      expect(await settledWith(call)).toMatchObject({ error: { code: 'E_CLOSED' } })
      const rows = await t.storage.scan('k', { fromSeq: 1, limit: 500 })
      expect(unsettled(rows)).toEqual([])
      expect(settlements(rows)[0]?.seq).toBeLessThan(ofType(rows, 'turn/end').at(-1)?.seq ?? 0)
    })
  })
})

const codec = loopCheckpointCodec(1, (state) => {
  if (state !== null) throw new Error('unexpected loop checkpoint')
  return null
})

/**
 * A loop that starts one side call in the first step of a turn and leaves it running. That step
 * then throws, or the loop goes on returning without writing anything until the run gives up.
 */
function callingLoop(provider: SideProvider, after: 'throw' | 'silence', seen: { call?: Promise<unknown> }) {
  const create = (ctx: LoopContext) => ({
    cancel() {},
    dispose() {},
    checkpoint: () => codec.encode(null),
    async step(): Promise<LoopStepOutcome> {
      if (!seen.call) {
        if (!(await ctx.input.claim('next-turn'))) return { outcome: 'idle', phase: 'idle' }
        const port = ctx.sideCall as LoopSideCallPort
        const call = port.invoke(await port.prepare(options()), signal())
        call.catch(() => undefined)
        seen.call = call
        await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
        if (after === 'throw') throw new Error('loop step failed')
      }
      return { outcome: 'running', phase: 'waiting' }
    },
  })
  const loop: LoopFactory = {
    id: 'test.side-call-end',
    version: '1.0.0',
    capabilities: ['model'],
    codec,
    create,
    resume: (ctx) => create(ctx),
  }
  return loop
}

async function runEndedBy(after: 'throw' | 'silence') {
  const provider = sideProvider(stalled)
  const billing: Row[] = []
  const seen: { call?: Promise<unknown> } = {}
  const f = await openSession({
    provider,
    loopFactory: callingLoop(provider, after, seen),
    seams: fakeSeams({
      billing: {
        record: async (row) => {
          billing.push(row as unknown as Row)
        },
        projected: async ({ tokensEstimate }) => ({
          credits: tokensEstimate / 1000,
          creditSource: 'estimated',
        }),
      },
    }),
  })
  try {
    await f.session.enqueue('next-turn', { content: [{ type: 'text', text: 'decide' }], actor })
    const out = await f.session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(out.reason).toBe('error')
    expect(f.session.op()).toBeNull()
    expect(await (seen.call as Promise<SideCallResult>)).toMatchObject(cutByTurnEnd)
    const rows = await f.session.scan({ fromSeq: 1, limit: 500 })
    settledBeforeTurnEnd(rows, billing)
    expect(f.session.pendingEffects()).toEqual([])
    return rows
  } finally {
    await f.session.close()
  }
}

describe('a run that ends a turn while its side call is in flight', () => {
  it('settles the call before the turn of a step that threw is closed', async () => {
    const rows = await runEndedBy('throw')
    expect(ofType(rows, 'x/core/invariant').map((row) => data(row).kind)).toEqual(['step-threw'])
  })

  it('settles the call before the turn of a run that made no progress is closed', async () => {
    const rows = await runEndedBy('silence')
    expect(ofType(rows, 'x/core/invariant').map((row) => data(row).kind)).toEqual(['run-no-progress'])
  })
})
