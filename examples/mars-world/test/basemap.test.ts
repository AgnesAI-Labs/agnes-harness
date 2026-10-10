import { describe, expect, it } from 'vitest'
import { LAYOUT } from '../src/base.js'
import { BASE_MAP, placed } from '../src/live/basemap.js'

type Place = { id: string; at?: [number, number]; points?: [number, number][] }

/** Whether (x, y) lies inside the polygon `points` (even-odd rule). */
function inside(points: [number, number][], x: number, y: number): boolean {
  let hit = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i] as [number, number]
    const [xj, yj] = points[j] as [number, number]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

describe('base map declaration', () => {
  const places = BASE_MAP.places as Place[]
  const [x0, y0, x1, y1] = BASE_MAP.bounds as [number, number, number, number]
  const zone = (id: string) => places.find((p) => p.id === id)?.points as [number, number][]

  it('has unique place ids, each a landmark or a zone, inside its bounds (MAP-1, MAP-2)', () => {
    expect(new Set(places.map((p) => p.id)).size).toBe(places.length)
    for (const p of places) {
      expect(Number(p.at !== undefined) + Number(p.points !== undefined)).toBe(1)
      for (const [x, y] of p.at ? [p.at] : (p.points ?? [])) {
        expect(x).toBeGreaterThanOrEqual(x0)
        expect(x).toBeLessThanOrEqual(x1)
        expect(y).toBeGreaterThanOrEqual(y0)
        expect(y).toBeLessThanOrEqual(y1)
      }
    }
  })

  it('names the places where the scene has them, in the map frame (y north)', () => {
    expect(places.find((p) => p.id === 'airlock')?.at).toEqual([0, -12.2])
    expect(places.find((p) => p.id === 'dock')?.at).toEqual([-15.5, -15.5])
    expect(placed(LAYOUT.camBase, 90)).toEqual({ map: 'base', x: -4, y: -28, yaw: 90 })
  })

  it('puts the base in the base area and the outcrop and its rocks in the west field', () => {
    for (const key of [
      'habitat',
      'airlockDoor',
      'dock',
      'lab',
      'hopperPad',
      'landingPad',
      'camBase',
      'comms',
    ] as const) {
      const [x, z] = LAYOUT[key]
      expect(inside(zone('base-area'), x, -z), key).toBe(true)
      expect(inside(zone('west-field'), x, -z), key).toBe(false)
    }
    for (const [x, z] of [LAYOUT.field, [-46, 44] as const])
      expect(inside(zone('west-field'), x, -z)).toBe(true)
  })
})
