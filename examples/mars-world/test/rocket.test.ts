import { describe, expect, it } from 'vitest'
import { burn, flightTimeLeft, maxAltitude, ROCKET } from '../src/live/rocket.js'

describe('rocket hopper propellant', () => {
  it('burns more when it moves and climbs than when it hovers', () => {
    const hover = burn(1, 0, 0)
    expect(hover).toBe(ROCKET.hoverBurn)
    expect(burn(1, 10, 0)).toBeGreaterThan(hover)
    expect(burn(1, 0, 2)).toBeGreaterThan(hover)
    // Coming down costs nothing beyond hovering.
    expect(burn(1, 0, -2)).toBe(hover)
  })

  it('derives flight time and ceiling from what is left above the landing reserve', () => {
    expect(flightTimeLeft(ROCKET.reserve)).toBe(0)
    expect(flightTimeLeft(ROCKET.reserve - 5)).toBe(0)
    expect(flightTimeLeft(100)).toBe((100 - ROCKET.reserve) / ROCKET.hoverBurn)
    expect(maxAltitude(100)).toBe(ROCKET.ceiling)
    expect(maxAltitude(ROCKET.reserve)).toBe(0)
    expect(maxAltitude(ROCKET.minTakeOff)).toBeGreaterThan(0)
    expect(maxAltitude(40)).toBeLessThan(maxAltitude(60))
  })
})
