import { describe, expect, it } from 'vitest'
import { castRay, MAP_AREA, occupancy } from '../src/live/map.js'
import { grayPng } from '../src/live/png.js'

describe('base map', () => {
  it('marks footprints and steep ground occupied, with the top row the largest y', () => {
    const flat = () => 0
    const grid = occupancy([{ x: 0, z: 0, r: 2 }], flat)
    const { x0, y1 } = MAP_AREA
    const at = (x: number, y: number) => grid.cells[Math.floor(y1 - y) * grid.w + Math.floor(x - x0)]
    expect(grid.origin).toEqual([MAP_AREA.x0, MAP_AREA.y0])
    expect(at(0.5, 0.5)).toBe(0)
    expect(at(10.5, 0.5)).toBe(255)
    // A wall north of the base (z = −30 is y = 30) shows in the upper part of the grid.
    const wall = occupancy([{ x: 0, z: -30, w: 4, d: 1 }], flat)
    expect(wall.cells[Math.floor(y1 - 30) * wall.w + Math.floor(0 - x0)]).toBe(0)
    const cliff = occupancy([], (x) => (x > 20 ? 50 : 0))
    expect(cliff.cells[Math.floor(y1) * cliff.w + Math.floor(20 - x0)]).toBe(0)
  })

  it('casts rays against circles and boxes', () => {
    const shapes = [
      { x: 10, z: 0, r: 1 },
      { x: 0, z: 10, w: 2, d: 2 },
    ]
    expect(castRay(0, 0, Math.PI / 2, shapes, 30)).toBeCloseTo(9)
    expect(castRay(0, 0, 0, shapes, 30)).toBeCloseTo(9)
    expect(castRay(0, 0, Math.PI, shapes, 30)).toBeUndefined()
    expect(castRay(0, 0, Math.PI / 2, shapes, 5)).toBeUndefined()
  })

  it('encodes an 8-bit grayscale PNG', async () => {
    const pixels = new Uint8Array([0, 128, 255, 255, 128, 0])
    const png = await grayPng(3, 2, pixels)
    expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG')
    const view = new DataView(png.buffer, png.byteOffset)
    expect([view.getUint32(16), view.getUint32(20), png[24], png[25]]).toEqual([3, 2, 8, 0])
    const idatLength = view.getUint32(33)
    const stream = new Blob([png.slice(41, 41 + idatLength)]).stream()
    const raw = new Uint8Array(
      await new Response(stream.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer(),
    )
    expect([...raw]).toEqual([0, 0, 128, 255, 0, 255, 128, 0])
  })
})
