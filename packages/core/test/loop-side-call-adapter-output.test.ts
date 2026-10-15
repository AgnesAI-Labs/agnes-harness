import { chargeToMicrocredits } from '@agnes/core-child-control/child/credits'
import { presetDefaults } from '@agnes/core-common/step/preset'
import type { InferenceEvent } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { sentFor } from './helpers/fake-provider.js'
import {
  ANSWER,
  data,
  options,
  type SideScript,
  settlements,
  sideCosts,
  sideUsage,
  signal,
  terminals,
  violations,
  withSession,
} from './helpers/side-call-session.js'

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const withTreeBudget = () => {
  const preset = presetDefaults()
  preset.treeBudgetCredits = 10
  return preset
}
/** Events a community adapter might send that do not match the inference event schema. */
const unchecked = (event: Record<string, unknown>) => event as unknown as InferenceEvent

const unknownCode: SideScript = async function* (request) {
  yield sentFor(request)
  yield unchecked({
    type: 'error',
    reason: 'error',
    code: 'SERVICE_UNAVAILABLE',
    message: 'try again later',
    retryable: true,
  })
}
const misshapenBilling: SideScript = async function* (request) {
  yield sentFor(request)
  yield { type: 'text_delta', delta: ANSWER }
  yield unchecked({ ...sideUsage(), billing: { usd: 0.00042 } })
  yield { type: 'done', reason: 'stop' }
}
const endlessCredits: SideScript = async function* (request) {
  yield sentFor(request)
  yield { type: 'text_delta', delta: ANSWER }
  yield unchecked({ ...sideUsage(), credits: Number.POSITIVE_INFINITY })
  yield { type: 'done', reason: 'stop' }
}
const misshapenResponse: SideScript = async function* (request) {
  yield sentFor(request)
  yield { type: 'text_delta', delta: ANSWER }
  yield unchecked({ ...sideUsage(), response: { id: 42 } })
  yield { type: 'done', reason: 'stop' }
}
const negativeTiming: SideScript = async function* (request) {
  yield sentFor(request)
  yield { type: 'text_delta', delta: ANSWER }
  yield sideUsage()
  yield unchecked({ type: 'done', reason: 'stop', timing: { ttftMs: -5, durationMs: 'slow' } })
}
const unknownCodeBeforeSending: SideScript = async function* () {
  yield unchecked({
    type: 'error',
    reason: 'error',
    code: 'SERVICE_UNAVAILABLE',
    message: 'not configured',
    retryable: false,
  })
}

describe('adapter output Core cannot record as given', () => {
  it.each([
    ['an unknown error code after sending', unknownCode],
    ['a usage report whose billing has another shape', misshapenBilling],
    ['a usage report whose credits are not finite', endlessCredits],
    ['a usage report whose response id is not a string', misshapenResponse],
    ['timing figures that are not valid numbers', negativeTiming],
  ])('records %s as an adapter error with an estimate and leaves nothing pending', async (_name, script) => {
    await withSession({ script, preset: withTreeBudget() }, async (t) => {
      const settle = vi.spyOn(t.storage, 'settleOrigin')
      const prepared = await t.port.prepare(options())
      const projected = prepared.estimate.projectedCredits as number
      const estimate = {
        tokens: { ...ZERO, input: prepared.estimate.inputTokens },
        credits: projected,
        creditSource: 'estimated',
      }
      const result = await t.port.invoke(prepared, signal())
      expect(result).toEqual({
        status: 'failed',
        invocationId: 'call-1',
        reason: 'adapter-error',
        code: 'TRANSPORT',
        retryable: false,
        dispatch: 'may-have-sent',
        usage: estimate,
        latencyMs: expect.any(Number),
        replayed: false,
      })
      const rows = await t.rows()
      expect(sideCosts(rows).map(data)).toEqual([expect.objectContaining({ ...estimate, interrupted: true })])
      expect(settlements(rows).map(data)).toEqual([
        { effectId: 'side:call-1', outcome: 'error', code: 'TRANSPORT', durationMs: expect.any(Number) },
      ])
      expect(terminals(rows).map((row) => data(row).terminal)).toEqual([
        expect.objectContaining({
          kind: 'unknown_spend',
          reason: 'adapter_error',
          code: 'TRANSPORT',
          retryable: false,
        }),
      ])
      expect(t.session.pendingEffects()).toHaveLength(0)
      expect(t.billing).toEqual([expect.objectContaining({ purpose: 'side-call', credits: projected })])
      expect(settle.mock.calls.map(([request]) => request)).toEqual([
        expect.objectContaining({
          actualMicro: chargeToMicrocredits(projected),
          complete: true,
          creditSource: 'estimated',
          originCostSeq: sideCosts(rows)[0]?.seq,
        }),
      ])
      await expect(t.ctx.turn.endStep()).resolves.toBeUndefined()
      expect(await t.port.status('call-1')).toMatchObject({
        status: 'finished',
        result: { ...result, replayed: true },
      })
      expect(violations(await t.rows())).toEqual([])
    })
  })

  it('records an unknown error code before sending as not sent, with a zero cost row', async () => {
    await withSession({ script: unknownCodeBeforeSending, preset: withTreeBudget() }, async (t) => {
      const settle = vi.spyOn(t.storage, 'settleOrigin')
      const result = await t.port.invoke(await t.port.prepare(options()), signal())
      expect(result).toMatchObject({
        status: 'failed',
        reason: 'adapter-error',
        code: 'TRANSPORT',
        retryable: false,
        dispatch: 'not-sent',
        usage: { tokens: ZERO, credits: 0, creditSource: 'estimated' },
      })
      const rows = await t.rows()
      expect(sideCosts(rows).map(data)).toEqual([
        expect.objectContaining({ tokens: ZERO, credits: 0, creditSource: 'estimated' }),
      ])
      expect(settlements(rows).map(data)).toEqual([
        expect.objectContaining({ outcome: 'error', code: 'TRANSPORT' }),
      ])
      expect(terminals(rows).map((row) => data(row).terminal)).toEqual([
        expect.objectContaining({ kind: 'no_spend', reason: 'driver_not_sent', code: 'TRANSPORT' }),
      ])
      expect(t.session.pendingEffects()).toHaveLength(0)
      expect(settle.mock.calls.map(([request]) => request)).toEqual([
        expect.objectContaining({ actualMicro: 0n, complete: true }),
      ])
      await expect(t.ctx.turn.endStep()).resolves.toBeUndefined()
      expect(await t.port.status('call-1')).toMatchObject({
        status: 'finished',
        result: { ...result, replayed: true },
      })
    })
  })
})
