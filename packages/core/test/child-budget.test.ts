import { describe, expect, it } from 'vitest'
import { admitFanOut, admitGeneration } from '../src/child/admission.js'
import { capToMicrocredits, chargeToMicrocredits, fitsCap } from '../src/child/credits.js'
import { CoreError } from '../src/types.js'

describe('child credit conversion', () => {
  it('floors caps, ceils charges, and refuses illegal values', () => {
    expect(capToMicrocredits(10)).toBe(10_000_000n)
    expect(chargeToMicrocredits(0.0000004)).toBe(1n)
    expect(() => capToMicrocredits(0)).toThrow(CoreError)
    expect(() => capToMicrocredits(-1)).toThrow(CoreError)
    expect(() => capToMicrocredits(Number.POSITIVE_INFINITY)).toThrow(CoreError)
    expect(() => capToMicrocredits(Number.NaN)).toThrow(CoreError)
    expect(() => capToMicrocredits(5e-10)).toThrow(/rounds to zero/)
  })

  it('does not admit a reservation that would overflow the cap', () => {
    expect(fitsCap(8_000_000n, 0n, 8_000_000n, 10_000_000n)).toBe(false)
    expect(fitsCap(2_000_000n, 0n, 8_000_000n, 10_000_000n)).toBe(true)
  })
})

describe('child admission', () => {
  it('separates generation from a zero parent depth', () => {
    expect(admitGeneration(0, 0)).toMatchObject({ ok: false })
    expect(admitGeneration(0, 1)).toEqual({ ok: true, childDepth: 1 })
    expect(admitGeneration(1, 1)).toMatchObject({ ok: false })
    expect(admitGeneration(1, 2)).toEqual({ ok: true, childDepth: 2 })
  })

  it('counts parent and root fan-out against the same cap', () => {
    expect(admitFanOut(4, 0, 4)).toMatchObject({ ok: false })
    expect(admitFanOut(0, 4, 4)).toMatchObject({ ok: false })
    expect(admitFanOut(3, 3, 4)).toEqual({ ok: true })
  })
})
