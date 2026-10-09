/**
 * The base map every moving device shares: an occupancy grid in the map frame (x east, y north,
 * metres), from the scene's truth. Plain geometry, without three.js, so it can be tested on its own.
 */

/** Something that blocks the way, in world coordinates (x east, z south): a circle or a rectangle. */
export type Footprint = { x: number; z: number; r: number } | { x: number; z: number; w: number; d: number }

export interface GridMap {
  id: string
  /** Metres per cell. */
  resolution: number
  /** Map-frame [x, y] of the bottom-left cell. */
  origin: [number, number]
  w: number
  h: number
  /** One byte per cell, top row (largest y) first: 255 free, 0 occupied. */
  cells: Uint8Array
}

/** The area the base map covers, in the map frame. */
export const MAP_AREA = { x0: -80, x1: 90, y0: -70, y1: 60 } as const

const inside = (f: Footprint, x: number, z: number) =>
  'r' in f
    ? Math.hypot(x - f.x, z - f.z) <= f.r
    : Math.abs(x - f.x) <= f.w / 2 && Math.abs(z - f.z) <= f.d / 2

/**
 * Rasterizes `footprints` and ground steeper than `maxSlope` (rise over run) into a grid of
 * `resolution` metres over MAP_AREA.
 */
export function occupancy(
  footprints: Footprint[],
  height: (x: number, z: number) => number,
  resolution = 1,
  maxSlope = 0.4,
): GridMap {
  const { x0, x1, y0, y1 } = MAP_AREA
  const w = Math.round((x1 - x0) / resolution)
  const h = Math.round((y1 - y0) / resolution)
  // Heights at the cell corners, shared by neighbouring cells.
  const corners = new Float32Array((w + 1) * (h + 1))
  for (let j = 0; j <= h; j++)
    for (let i = 0; i <= w; i++)
      corners[j * (w + 1) + i] = height(x0 + i * resolution, -(y1 - j * resolution))
  const cells = new Uint8Array(w * h)
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const x = x0 + (i + 0.5) * resolution
      const z = -(y1 - (j + 0.5) * resolution)
      const a = corners[j * (w + 1) + i] as number
      const b = corners[j * (w + 1) + i + 1] as number
      const c = corners[(j + 1) * (w + 1) + i] as number
      const d = corners[(j + 1) * (w + 1) + i + 1] as number
      const slope = Math.hypot(b + d - a - c, c + d - a - b) / (2 * resolution)
      const blocked = slope > maxSlope || footprints.some((f) => inside(f, x, z))
      cells[j * w + i] = blocked ? 0 : 255
    }
  return { id: 'base', resolution, origin: [x0, y0], w, h, cells }
}

/**
 * Distance from (x, z) along `heading` (world radians, as rotation.y: 0 is +z) to the first
 * footprint, or undefined beyond `max`. For a simulated lidar.
 */
export function castRay(
  x: number,
  z: number,
  heading: number,
  footprints: Footprint[],
  max: number,
): number | undefined {
  const dx = Math.sin(heading)
  const dz = Math.cos(heading)
  let best = max
  for (const f of footprints) {
    let t: number | undefined
    if ('r' in f) {
      // Ray against circle: t² + 2bt + c = 0.
      const ox = x - f.x
      const oz = z - f.z
      const b = ox * dx + oz * dz
      const c = ox * ox + oz * oz - f.r * f.r
      const disc = b * b - c
      if (disc >= 0) t = c < 0 ? 0 : -b - Math.sqrt(disc)
    } else {
      // Ray against axis-aligned box: the slab method.
      let near = -Infinity
      let far = Infinity
      for (const [o, d, lo, hi] of [
        [x, dx, f.x - f.w / 2, f.x + f.w / 2],
        [z, dz, f.z - f.d / 2, f.z + f.d / 2],
      ] as [number, number, number, number][]) {
        if (Math.abs(d) < 1e-9) {
          if (o < lo || o > hi) near = Infinity
          continue
        }
        const a = (lo - o) / d
        const b = (hi - o) / d
        near = Math.max(near, Math.min(a, b))
        far = Math.min(far, Math.max(a, b))
      }
      if (near <= far && far >= 0) t = Math.max(0, near)
    }
    if (t !== undefined && t >= 0 && t < best) best = t
  }
  return best < max ? best : undefined
}
