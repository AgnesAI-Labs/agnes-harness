import { chargeToMicrocredits } from '@agnes/core-child-control/child/credits'
import { withPhase } from '@agnes/core-common/step/op-state'
import { presetDefaults } from '@agnes/core-common/step/preset'
import type { EventInput } from '@agnes/core-common/types'
import type { SideCallOptions } from '@agnes/extension-api'
import type { RequestBody } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createLoopContext, disposeLoopContext } from '../src/loop/ports.js'
import { LoopScope } from '../src/step/loop-deadline.js'
import { sentFor } from './helpers/fake-provider.js'
import { actor } from './helpers/open-session.js'
import {
  ANSWER,
  data,
  type Harness,
  ofType,
  options,
  type SideScript,
  settlements,
  sideCosts,
  sideUsage,
  signal,
  stalled,
  terminals,
  violations,
  withSession,
} from './helpers/side-call-session.js'

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
/** The default options without a payload, so the request carries messages only. */
const messagesOnly = (over: Partial<SideCallOptions>): SideCallOptions => {
  const { payload: _payload, ...rest } = options(over)
  return rest
}
const withTreeBudget = () => {
  const preset = presetDefaults()
  preset.treeBudgetCredits = 10
  return preset
}

describe('side call inputs', () => {
  it('refuses a signal that is not an AbortSignal before it holds or writes anything', async () => {
    await withSession({ preset: withTreeBudget() }, async (t) => {
      const reserve = vi.spyOn(t.storage, 'reserve')
      const prepared = await t.port.prepare(options())
      const count = (await t.rows()).length
      await expect(t.port.invoke(prepared, { aborted: false } as AbortSignal)).rejects.toMatchObject({
        code: 'E_ENVELOPE',
        detail: { reason: 'signal' },
      })
      expect(await t.rows()).toHaveLength(count)
      expect(t.session.pendingEffects()).toHaveLength(0)
      expect(reserve).not.toHaveBeenCalled()
      expect(t.provider.calls).toHaveLength(0)
      expect(await t.port.invoke(prepared, signal())).toMatchObject({ status: 'ok' })
    })
  })

  it('refuses an output, system prompt or sampling out of range, before anything is written', async () => {
    await withSession({}, async (t) => {
      const count = (await t.rows()).length
      const refused = (over: object, reason: string) =>
        expect(t.port.prepare(options(over))).rejects.toMatchObject({
          code: 'E_ENVELOPE',
          detail: { reason },
        })
      await refused({ output: 'xml' }, 'output')
      await refused({ system: 'x'.repeat(1_048_577) }, 'system')
      await refused({ system: 42 }, 'system')
      await refused({ sampling: { temperature: 3 } }, 'sampling')
      await refused({ sampling: { maxTokens: 0 } }, 'sampling')
      await refused({ sampling: { thinking: 'deep' } }, 'sampling')
      await refused({ sampling: { topP: 0.5 } }, 'sampling')
      expect(await t.rows()).toHaveLength(count)
    })
  })

  it('estimates from a provider count bound to the request, and from the text otherwise', async () => {
    await withSession({}, async (t) => {
      const counted: RequestBody[] = []
      t.provider.count = async (request) => {
        counted.push(request)
        return { tokens: 777, source: 'provider', boundHash: request.derivedHash }
      }
      const messages: RequestBody['messages'] = [
        { role: 'user', content: [{ type: 'text', text: 'which move?' }] },
      ]
      const byProvider = await t.port.prepare(messagesOnly({ messages, invocationId: 'counted' }))
      expect(byProvider.estimate).toMatchObject({
        inputTokens: 777,
        source: 'provider',
        projectedCredits: 0.777,
      })
      // A provider count cannot see a payload, so a request with one uses the text estimate.
      const withPayload = await t.port.prepare(options({ messages, invocationId: 'with-payload' }))
      expect(withPayload.estimate.source).toBe('estimate')
      // A count bound to another request is not used.
      t.provider.count = async () => ({ tokens: 777, source: 'provider', boundHash: 'f'.repeat(64) })
      const unbound = await t.port.prepare(messagesOnly({ messages, invocationId: 'unbound' }))
      expect(unbound.estimate.source).toBe('estimate')
      expect(unbound.estimate.inputTokens).not.toBe(777)
      expect(counted).toHaveLength(1)
    })
  })
})

describe('side call outcomes', () => {
  /** Cancels the call the moment its intent is committed, before the provider is first read. */
  const cancelAfterIntent = (t: Harness, cancel: () => void) => {
    const log = t.session.d.log
    const append = log.append.bind(log)
    vi.spyOn(log, 'append').mockImplementation(async (events: EventInput[], ...rest) => {
      const committed = await append(events, ...rest)
      if (events.some((row) => row.type === 'x/core/side-call-intent')) cancel()
      return committed
    })
  }

  it.each([
    ['the loop signal', false, 'error'],
    ['a session stop', true, 'aborted'],
  ] as const)(
    'records a call cancelled by %s after its intent and before dispatch as no spend',
    async (_name, stopping, outcome) => {
      await withSession({ preset: withTreeBudget() }, async (t) => {
        const settle = vi.spyOn(t.storage, 'settleOrigin')
        const release = vi.spyOn(t.storage, 'releaseReservation')
        const prepared = await t.port.prepare(options())
        const stop = new AbortController()
        if (stopping)
          await t.session.transition([], (cur) =>
            cur
              ? withPhase(cur, cur.phase, {
                  control: { status: 'cancel_requested', requestedAt: new Date(0).toISOString(), by: actor },
                })
              : null,
          )
        cancelAfterIntent(t, () => (stopping ? t.session.ac.abort() : stop.abort()))
        expect(await t.port.invoke(prepared, stop.signal)).toMatchObject({
          status: 'failed',
          reason: 'cancelled',
          retryable: false,
          dispatch: 'not-sent',
          usage: { tokens: ZERO, credits: 0, creditSource: 'estimated' },
        })
        expect(t.provider.calls).toHaveLength(0)
        const rows = await t.rows()
        expect(sideCosts(rows).map(data)).toEqual([
          expect.objectContaining({ tokens: ZERO, credits: 0, creditSource: 'estimated', interrupted: true }),
        ])
        expect(settlements(rows).map((row) => data(row).outcome)).toEqual([outcome])
        expect(data(terminals(rows)[0])).toMatchObject({
          terminal: { kind: 'no_spend', outcome, reason: 'cancelled_before_dispatch' },
        })
        expect(settle).toHaveBeenCalledTimes(1)
        expect(settle.mock.calls[0]?.[0]).toMatchObject({
          actualMicro: 0n,
          complete: true,
          originCostSeq: sideCosts(rows)[0]?.seq,
        })
        expect(release).not.toHaveBeenCalled()
        if (stopping) await t.ctx.turn.finishCancelled()
        else await t.ctx.events.finish('completed')
        expect(violations(await t.rows())).toEqual([])
      })
    },
  )

  const failing = (withUsage: boolean): SideScript =>
    async function* (request) {
      yield sentFor(request)
      if (withUsage) yield sideUsage()
      yield {
        type: 'error',
        reason: 'error',
        code: withUsage ? 'RATE_LIMIT' : 'AUTH',
        message: 'refused by the vendor',
        retryable: withUsage,
      }
    }

  it('records an adapter error that reported usage as known spend', async () => {
    await withSession({ script: failing(true) }, async (t) => {
      expect(await t.port.invoke(await t.port.prepare(options()), signal())).toMatchObject({
        status: 'failed',
        reason: 'adapter-error',
        code: 'RATE_LIMIT',
        retryable: true,
        dispatch: 'may-have-sent',
        usage: { credits: 0.042, creditSource: 'gateway' },
      })
      const rows = await t.rows()
      expect(sideCosts(rows).map(data)).toEqual([
        expect.objectContaining({ credits: 0.042, creditSource: 'gateway', interrupted: true }),
      ])
      expect(settlements(rows).map(data)).toEqual([
        expect.objectContaining({ outcome: 'error', code: 'RATE_LIMIT' }),
      ])
      expect(data(terminals(rows)[0])).toMatchObject({
        terminal: { kind: 'known_spend', reason: 'driver_failed', code: 'RATE_LIMIT', retryable: true },
      })
    })
  })

  it('records an adapter error without usage as unknown spend with an estimated cost row', async () => {
    await withSession({ script: failing(false) }, async (t) => {
      const prepared = await t.port.prepare(options())
      const estimate = {
        tokens: expect.objectContaining({ input: prepared.estimate.inputTokens }),
        credits: prepared.estimate.projectedCredits,
        creditSource: 'estimated',
      }
      expect(await t.port.invoke(prepared, signal())).toMatchObject({
        status: 'failed',
        reason: 'adapter-error',
        code: 'AUTH',
        retryable: false,
        dispatch: 'may-have-sent',
        usage: estimate,
      })
      const rows = await t.rows()
      expect(sideCosts(rows).map(data)).toEqual([expect.objectContaining({ ...estimate, interrupted: true })])
      expect(data(terminals(rows)[0])).toMatchObject({
        terminal: { kind: 'unknown_spend', reason: 'adapter_error', code: 'AUTH', retryable: false },
      })
    })
  })
})

describe('the vendor retry hint', () => {
  /** A rate-limited answer, after a usage report or not, with the retry hint under test. */
  const limited = (retryAfterMs: number | undefined, withUsage = false): SideScript =>
    async function* (request) {
      yield sentFor(request)
      if (withUsage) yield sideUsage()
      yield {
        type: 'error',
        reason: 'error',
        code: 'RATE_LIMIT',
        message: 'too many requests',
        retryable: true,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      }
    }
  const terminalOf = async (t: Harness) =>
    (data(terminals(await t.rows())[0]) as { terminal: Record<string, unknown> }).terminal

  it.each([
    ['without usage', false, 'unknown_spend', 'adapter_error'],
    ['after usage', true, 'known_spend', 'driver_failed'],
  ] as const)(
    'hands the hint of a rate-limited call %s to the loop, records it and replays it',
    async (_name, withUsage, kind, reason) => {
      await withSession({ script: limited(2500, withUsage) }, async (t) => {
        const prepared = await t.port.prepare(options())
        const result = await t.port.invoke(prepared, signal())
        expect(result).toMatchObject({
          status: 'failed',
          reason: 'adapter-error',
          code: 'RATE_LIMIT',
          retryable: true,
          retryAfterMs: 2500,
          dispatch: 'may-have-sent',
          replayed: false,
        })
        expect(await terminalOf(t)).toMatchObject({ kind, reason, code: 'RATE_LIMIT', retryAfterMs: 2500 })
        expect(await t.port.status('call-1')).toEqual({
          status: 'finished',
          invocationId: 'call-1',
          label: 'sample.decide',
          requestHash: prepared.requestHash,
          result: { ...result, replayed: true },
        })
        expect(await t.port.invoke(await t.port.prepare(options()), signal())).toEqual({
          ...result,
          replayed: true,
        })
        expect(t.provider.calls).toHaveLength(1)
      })
    },
  )

  it.each([
    ['no hint', undefined, undefined],
    ['a zero wait', 0, 0],
    ['a fractional wait, rounded up', 1.2, 2],
    ['a wait of exactly one hour', 3_600_000, 3_600_000],
    ['a wait over one hour', 3_600_001, undefined],
    ['a negative wait', -5, undefined],
    ['a wait that is not a number', Number.NaN, undefined],
    ['an infinite wait', Number.POSITIVE_INFINITY, undefined],
  ])('keeps %s only as a whole number of milliseconds up to an hour', async (_name, given, kept) => {
    await withSession({ script: limited(given) }, async (t) => {
      const result = await t.port.invoke(await t.port.prepare(options()), signal())
      const replayed = await t.port.status('call-1')
      const terminal = await terminalOf(t)
      expect(result).toMatchObject({ status: 'failed', reason: 'adapter-error', code: 'RATE_LIMIT' })
      if (kept === undefined) {
        expect(result).not.toHaveProperty('retryAfterMs')
        expect(terminal).not.toHaveProperty('retryAfterMs')
      } else {
        expect(result).toHaveProperty('retryAfterMs', kept)
        expect(terminal).toHaveProperty('retryAfterMs', kept)
      }
      expect(replayed).toMatchObject({ status: 'finished', result: { ...result, replayed: true } })
    })
  })

  it('never puts a hint on a failure that is not an adapter error', async () => {
    await withSession({ script: stalled }, async (t) => {
      const result = await t.port.invoke(await t.port.prepare(options({ deadlineMs: 200 })), signal())
      expect(result).toMatchObject({ status: 'failed', reason: 'deadline' })
      expect(result).not.toHaveProperty('retryAfterMs')
      expect(await terminalOf(t)).not.toHaveProperty('retryAfterMs')
    })
    await withSession({ script: stalled }, async (t) => {
      const stop = new AbortController()
      const running = t.port.invoke(await t.port.prepare(options()), stop.signal)
      await vi.waitFor(() => expect(t.provider.calls).toHaveLength(1))
      stop.abort()
      const result = await running
      expect(result).toMatchObject({ status: 'failed', reason: 'cancelled' })
      expect(result).not.toHaveProperty('retryAfterMs')
      expect(await terminalOf(t)).not.toHaveProperty('retryAfterMs')
    })
  })
})

describe('side call tree budget', () => {
  it('settles the hold at the reported credits after a success', async () => {
    await withSession({ preset: withTreeBudget() }, async (t) => {
      const settle = vi.spyOn(t.storage, 'settleOrigin')
      expect(await t.port.invoke(await t.port.prepare(options()), signal())).toMatchObject({ status: 'ok' })
      const [cost] = sideCosts(await t.rows())
      expect(settle.mock.calls.map(([request]) => request)).toEqual([
        expect.objectContaining({
          actualMicro: chargeToMicrocredits(0.042),
          complete: true,
          creditSource: 'gateway',
          originCostSeq: cost?.seq,
        }),
      ])
    })
  })

  it('settles the hold at the estimate when the deadline ends the call', async () => {
    await withSession({ preset: withTreeBudget(), script: stalled }, async (t) => {
      const settle = vi.spyOn(t.storage, 'settleOrigin')
      const prepared = await t.port.prepare(options({ deadlineMs: 200 }))
      expect(await t.port.invoke(prepared, signal())).toMatchObject({ status: 'failed', reason: 'deadline' })
      const [cost] = sideCosts(await t.rows())
      expect(settle.mock.calls.map(([request]) => request)).toEqual([
        expect.objectContaining({
          actualMicro: chargeToMicrocredits(prepared.estimate.projectedCredits as number),
          complete: true,
          creditSource: 'estimated',
          originCostSeq: cost?.seq,
        }),
      ])
    })
  })

  it('settles the hold at the estimate kept with the late receipt when the call is revoked', async () => {
    await withSession({ preset: withTreeBudget(), script: stalled }, async (t) => {
      const settle = vi.spyOn(t.storage, 'settleOrigin')
      const prepared = await t.port.prepare(options())
      const running = t.port.invoke(prepared, signal())
      running.catch(() => undefined)
      await vi.waitFor(() => expect(t.provider.calls).toHaveLength(1))
      disposeLoopContext(t.ctx)
      await expect(running).rejects.toMatchObject({ code: 'E_CLOSED' })
      const rows = await t.rows()
      const [cost] = sideCosts(rows)
      expect(ofType(rows, 'x/core/late-effect-receipt')).toHaveLength(1)
      expect(data(cost)).toMatchObject({ creditSource: 'estimated', interrupted: true })
      expect(settle.mock.calls.map(([request]) => request)).toEqual([
        expect.objectContaining({
          actualMicro: chargeToMicrocredits(prepared.estimate.projectedCredits as number),
          complete: true,
          creditSource: 'estimated',
          originCostSeq: cost?.seq,
        }),
      ])
    })
  })

  it('records a seam failure naming only the effect when the hold cannot be settled', async () => {
    await withSession({ preset: withTreeBudget() }, async (t) => {
      vi.spyOn(t.storage, 'settleOrigin').mockRejectedValue(new Error('budget store unavailable'))
      const result = await t.port.invoke(await t.port.prepare(options()), signal())
      expect(result).toMatchObject({ status: 'ok', text: ANSWER, replayed: false })
      const rows = await t.rows()
      expect(ofType(rows, 'x/core/seam-failed').map(data)).toEqual([
        { seam: 'tree-budget', op: 'settle', effectId: 'side:call-1' },
      ])
      expect(terminals(rows)).toHaveLength(1)
      expect(await t.port.status('call-1')).toMatchObject({
        status: 'finished',
        result: { ...result, replayed: true },
      })
    })
  })
})

describe('revocation and the end of the turn', () => {
  it("blocks the replacement's finish until the revoked call's receipt is written", async () => {
    await withSession({ script: stalled }, async (t) => {
      const running = t.port.invoke(await t.port.prepare(options()), signal())
      running.catch(() => undefined)
      await vi.waitFor(() => expect(t.provider.calls).toHaveLength(1))
      t.session.loopScope = new LoopScope()
      const fresh = await createLoopContext(t.session)
      let release!: () => void
      // Hold the session lock so the receipt cannot be written yet.
      const held = t.session.locked(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
      )
      disposeLoopContext(t.ctx)
      await expect(fresh.events.finish('completed')).rejects.toMatchObject({
        code: 'E_RELATION',
        detail: { reason: 'side-call-in-flight' },
      })
      expect(ofType(await t.rows(), 'x/core/late-effect-receipt')).toHaveLength(0)
      release()
      await held
      await expect(running).rejects.toMatchObject({ code: 'E_CLOSED' })
      expect(ofType(await t.rows(), 'x/core/late-effect-receipt')).toHaveLength(1)
      await expect(fresh.events.finish('completed')).resolves.toMatchObject({ outcome: 'turn-ended' })
    })
  })
})
