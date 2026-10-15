export type Point = { x: number; y: number }
export type Pose = Point & { z: number; yaw: number }
export const PLACES = {
  habitat: { x: 0, y: 0 },
  airlock: { x: 0, y: -12 },
  dock: { x: -17, y: -18 },
  lab: { x: -22, y: -8 },
  pad: { x: 23, y: -15 },
  field: { x: -45, y: -42 },
  sample: { x: -52, y: -38 },
  power: { x: 22, y: 16 },
  comms: { x: -10, y: 20 },
  weather: { x: 13, y: 26 },
  camera: { x: -4, y: -30 },
  monolith: { x: 8, y: -13 },
} as const
export const OBSTACLES = [
  { x: 0, y: 0, radius: 8 },
  { x: -22, y: -8, radius: 5 },
  { x: -37, y: -31, radius: 3 },
  { x: -41, y: -46, radius: 3 },
] as const
export function heightAt(x: number, y: number): number {
  return 0.18 * Math.sin(x / 9) * Math.cos(y / 11)
}
export function inside(p: Point): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= 80 && Math.abs(p.y) <= 80
}
function segmentClear(a: Point, b: Point, clearance: number): boolean {
  return OBSTACLES.every((o) => {
    const dx = b.x - a.x,
      dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((o.x - a.x) * dx + (o.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    return Math.hypot(a.x + t * dx - o.x, a.y + t * dy - o.y) >= o.radius + clearance
  })
}
/** Bounded visibility graph: every accepted leg retains clearance from the scene's solids. */
export function route(from: Point, to: Point, clearance = 1): Point[] {
  if (!inside(from) || !inside(to)) throw new Error('outside-map')
  const nodes: Point[] = [from, to]
  for (const o of OBSTACLES)
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8,
        r = (o.radius + clearance + 0.2) / Math.cos(Math.PI / 16)
      nodes.push({ x: o.x + Math.cos(a) * r, y: o.y + Math.sin(a) * r })
    }
  const distances = nodes.map(() => Infinity),
    previous = nodes.map(() => -1),
    done = new Set<number>()
  distances[0] = 0
  while (done.size < nodes.length) {
    let next = -1
    for (let i = 0; i < nodes.length; i++)
      if (!done.has(i) && (next < 0 || distances[i]! < distances[next]!)) next = i
    if (next < 0 || !Number.isFinite(distances[next])) break
    if (next === 1) {
      const path: Point[] = []
      for (let i = 1; i > 0; i = previous[i]!) path.unshift({ ...nodes[i]! })
      return path
    }
    done.add(next)
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[next]!,
        b = nodes[i]!
      if (done.has(i) || !segmentClear(a, b, clearance)) continue
      const distance = distances[next]! + Math.hypot(a.x - b.x, a.y - b.y)
      if (distance < distances[i]!) {
        distances[i] = distance
        previous[i] = next
      }
    }
  }
  throw new Error('no-safe-route')
}
export const BASE_MAP = {
  id: 'mars-base',
  name: 'Agnes Mars Base (simulation)',
  bounds: [-80, -80, 80, 80] as [number, number, number, number],
  places: Object.entries(PLACES).map(([id, p]) => ({ id, name: id, at: [p.x, p.y] as [number, number] })),
}
export const DEVICE_IDS = [
  'habitat-01',
  'airlock-01',
  'suit-01',
  'rover-01',
  'hopper-01',
  'lab-01',
  'power-01',
  'weather-01',
  'comms-01',
  'cam-base',
  'monolith-01',
] as const
export type DeviceId = (typeof DEVICE_IDS)[number]
export const SPAWNS: Record<DeviceId, Point> = {
  'habitat-01': PLACES.habitat,
  'airlock-01': PLACES.airlock,
  'suit-01': PLACES.field,
  'rover-01': PLACES.dock,
  'hopper-01': PLACES.pad,
  'lab-01': PLACES.lab,
  'power-01': PLACES.power,
  'weather-01': PLACES.weather,
  'comms-01': PLACES.comms,
  'cam-base': PLACES.camera,
  'monolith-01': PLACES.monolith,
}
