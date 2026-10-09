import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { prepareEvents } from '../src/log/validate.js'
import type { CoreError, EventInput } from '../src/types.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { openSession } from './helpers/open-session.js'

const actor = { id: 'system', org: 'local', role: 'system', deptPath: [], attrs: {} }
const AT = Date.parse('2026-10-09T06:37:00.000Z')
const ctx = { ids: defaultIds(() => AT), clock: () => AT, refineCaller: false }
const settled = (data: Record<string, unknown>): EventInput => ({
  type: 'effect/settled',
  data: data as EventInput['data'],
  actor,
  origin: 'system',
  trust: 'trusted',
})
const rejection = (row: EventInput): CoreError => {
  try {
    prepareEvents([row], ctx)
  } catch (error) {
    return error as CoreError
  }
  throw new Error('the row was accepted')
}

describe('where an envelope rejection happened', () => {
  it('names the event type and the field in the message', () => {
    const error = rejection(settled({ effectId: 'e1', outcome: 'ok', durationMs: -11460 }))
    expect(error.code).toBe('E_ENVELOPE')
    expect(error.message).toContain('effect/settled /data/durationMs')
    expect(error.message).toContain('Expected integer to be greater or equal to 0')
  })

  it('keeps the message free of the rejected value and of the surrounding data', () => {
    const error = rejection(settled({ effectId: 'secret-effect-id', outcome: 'ok', durationMs: -11460 }))
    expect(error.message).not.toContain('11460')
    expect(error.message).not.toContain('secret-effect-id')
  })

  it('names a missing field by its full path', () => {
    const error = rejection(settled({ outcome: 'ok' }))
    expect(error.message).toContain('effect/settled /data/effectId')
  })

  it('counts the other problems in the same row', () => {
    const error = rejection(settled({ outcome: 'nope', durationMs: -1 }))
    expect(error.message).toMatch(/\(\+\d+ more\)$/)
    expect((error.detail as { errors: unknown[] }).errors.length).toBeGreaterThan(1)
  })

  it('reaches the turn error and the invariant row a failed step leaves behind', async () => {
    const { session } = await openSession({ provider: fakeProvider([textTurn('unused')]) })
    session.step = async () => {
      prepareEvents([settled({ effectId: 'e1', outcome: 'ok', durationMs: -1 })], ctx)
      throw new Error('unreachable')
    }

    const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })

    expect(outcome).toMatchObject({ reason: 'error', error: { code: 'E_STEP_FAILED' } })
    expect(outcome.error?.message).toContain('effect/settled /data/durationMs')
    const rows = await session.scan({ type: 'x/core/invariant', limit: 20 })
    const threw = rows.find((row) => (row.data as { kind?: string } | null)?.kind === 'step-threw')
    if (!threw) throw new Error('no step-threw row')
    expect((threw.data as { message: string }).message).toContain('effect/settled /data/durationMs')
  })
})
