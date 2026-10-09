import { describe, expect, it } from 'vitest'
import { FOOTPRINTS, LAYOUT } from '../src/base.js'
import { occupancy } from '../src/live/map.js'
import {
  type Circle,
  firstBlocking,
  fromMap,
  inTheWay,
  MONO,
  monolithAhead,
  openAround,
  type Point,
  pathToRock,
  planNear,
  planRoute,
  ROVER,
  roverPath,
  toMap,
  toSegment,
  yawOf,
} from '../src/live/route.js'
import { heightAt } from '../src/terrain.js'

/** The west field's boulders as the scene has them (radii as measured in the scene). */
const BOULDERS: Circle[] = [
  { x: -34.5, z: 30.5, r: 4.3 },
  { x: -27, z: 23.5, r: 2.55 },
  { x: -36, z: 23, r: 3.15 },
  { x: -41.5, z: 39, r: 2.25 },
]
/** The astronaut at each spot of the worksite they walk between. */
const ASTRONAUT: Circle[] = LAYOUT.worksite.map(([x, z]) => ({ x, z, r: 0.5 }))
const STOPS: Circle[] = [...BOULDERS, ASTRONAUT[0] as Circle]
const ROCK: Circle = { x: -46, z: 44, r: 0.05 }
const DOCK: Point = { x: LAYOUT.dock[0], z: LAYOUT.dock[1] + 0.4 }
const grid = occupancy(FOOTPRINTS, heightAt)

/** Drives `path` from `from` like the rover does, leg by leg, and returns what stopped it, if anything. */
function drive(from: Point, path: Point[], stops = STOPS): Circle | undefined {
  let at = from
  for (const to of path) {
    const heading = Math.atan2(to.x - at.x, to.z - at.z)
    for (;;) {
      const remaining = Math.hypot(to.x - at.x, to.z - at.z)
      const hit = inTheWay(at, heading, stops, remaining)
      if (hit) return hit
      if (remaining < 0.1) break
      const step = Math.min(0.1, remaining)
      at = { x: at.x + Math.sin(heading) * step, z: at.z + Math.cos(heading) * step }
    }
  }
  return undefined
}

describe('ground geometry', () => {
  it('maps world and map frames both ways, with yaw counter-clockwise from east', () => {
    expect(toMap({ x: -46, z: 44 })).toEqual({ x: -46, y: -44 })
    expect(fromMap(-46, -44)).toEqual({ x: -46, z: 44 })
    expect(yawOf(Math.PI / 2)).toBe(0) // facing +x, east
    expect(yawOf(Math.PI)).toBe(90) // facing −z, north
    expect(yawOf(0)).toBe(270) // facing +z, south
  })

  it('measures the distance to a segment', () => {
    expect(toSegment({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 5, z: 3 }).d).toBe(3)
    expect(toSegment({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: -4, z: 3 }).d).toBe(5)
  })

  it('routes around obstacles with clearance, and straight when nothing is in the way', () => {
    const boulder = { x: 5, z: 0.5, r: 1 }
    expect(planRoute({ x: 0, z: 0 }, { x: 10, z: 0 }, [], 2)).toEqual([{ x: 10, z: 0 }])
    const route = planRoute({ x: 0, z: 0 }, { x: 10, z: 0 }, [boulder], 2)
    expect(route.length).toBeGreaterThan(1)
    expect(route.at(-1)).toEqual({ x: 10, z: 0 })
    let at = { x: 0, z: 0 }
    for (const next of route) {
      expect(firstBlocking(at, next, [boulder], 2)).toBeUndefined()
      at = next
    }
  })

  it('plans a rover route to the rock that the safety stop never interrupts', () => {
    const path = pathToRock(grid, DOCK, ROCK, STOPS, [])
    expect(path).toBeDefined()
    const legs = path as Point[]
    const end = legs.at(-1) as Point
    expect(Math.hypot(end.x - ROCK.x, end.z - ROCK.z) - ROCK.r).toBeLessThan(4)
    expect(drive(DOCK, legs)).toBeUndefined()
    // The astronaut walks about the worksite after the route was planned; wherever they are, the
    // rover still gets through.
    for (const astronaut of ASTRONAUT) expect(drive(DOCK, legs, [...BOULDERS, astronaut])).toBeUndefined()
    // Every leg keeps (about, on 1 m cells) the stop clearance from boulders and people.
    let at = DOCK
    for (const next of legs) {
      for (const o of STOPS) expect(toSegment(at, next, o).d - o.r).toBeGreaterThan(ROVER.stopClearance - 1)
      at = next
    }
  })

  it('plans the way home around the boulders, and says when there is none', () => {
    const home = { x: LAYOUT.dock[0], z: LAYOUT.dock[1] + 7 }
    const from = { x: -46, z: 46.2 }
    const path = roverPath(grid, from, home, STOPS, [ROCK])
    expect(path?.at(-1)).toEqual(home)
    expect(drive(from, path as Point[])).toBeUndefined()
    // Walled in by a ring of boulders: no way out.
    const ring = Array.from({ length: 16 }, (_, k) => ({
      x: 60 + Math.cos((k / 16) * Math.PI * 2) * 12,
      z: 60 + Math.sin((k / 16) * Math.PI * 2) * 12,
      r: 2,
    }))
    expect(roverPath(grid, { x: 60, z: 60 }, home, ring, [])).toBeUndefined()
  })

  it('stops Monolith before a boulder at its look-ahead but only half a metre before a person', () => {
    const at = { x: 0, z: 0 }
    const front = MONO.nose
    const boulder = (d: number) => ({ x: 0, z: front + d + 1, r: 1, label: 'boulder' })
    const person = (d: number) => ({ x: 0, z: front + d + 0.5, r: 0.5, label: 'astronaut' })
    expect(monolithAhead(at, 0, [boulder(0.9)], 'walk')).toBeDefined()
    expect(monolithAhead(at, 0, [boulder(1.5)], 'walk')).toBeUndefined()
    expect(monolithAhead(at, 0, [boulder(1.5)], 'roll')).toBeDefined()
    expect(monolithAhead(at, 0, [person(0.9)], 'walk')).toBeUndefined()
    expect(monolithAhead(at, 0, [person(0.4)], 'walk')).toBeDefined()
    // Holding an astronaut in front, it stops that much earlier.
    expect(monolithAhead(at, 0, [boulder(1.5)], 'walk', Number.POSITIVE_INFINITY, true)).toBeDefined()
  })

  it('walks Monolith to the astronaut wherever they work, then to the airlock, around the boulders', () => {
    const keepouts = BOULDERS.map((b) => ({ ...b, r: b.r + MONO.clearance.walk }))
    const [mx, mz] = LAYOUT.monolith
    const door = { x: LAYOUT.airlockDoor[0], z: LAYOUT.airlockDoor[1] }
    for (const astronaut of ASTRONAUT) {
      // Beside the astronaut: some spots lie within a boulder's clearance, so it ends next to them.
      const there = planNear(grid, { x: mx, z: mz }, astronaut, keepouts, MONO.clearance.walk)
      const near = there?.end as Point
      expect(Math.hypot(near.x - astronaut.x, near.z - astronaut.z)).toBeLessThanOrEqual(1)
      // The door itself is inside the airlock: it gets as near as it can, in front of it.
      const back = planNear(grid, astronaut, door, keepouts, MONO.clearance.walk)
      const end = back?.end as Point
      expect(Math.hypot(end.x - door.x, end.z - door.z)).toBeLessThanOrEqual(3)
      expect(end.z).toBeGreaterThan(door.z)
    }
  })

  it('rolls Monolith only on open ground', () => {
    expect(
      openAround(grid, [], { x: LAYOUT.airlockDoor[0], z: LAYOUT.airlockDoor[1] + 1.5 }, MONO.clearance.roll),
    ).toBe(false)
    expect(openAround(grid, [], { x: 26, z: 42 }, MONO.clearance.roll)).toBe(true)
    expect(openAround(grid, [{ x: 27, z: 42, r: 0.5 }], { x: 26, z: 42 }, MONO.clearance.roll)).toBe(false)
  })
})
