import type { DeviceMap } from '@agnes/mhs-device'
export interface Position {
  map: string
  x: number
  y: number
  yaw: number
}
export function zoneAt(map: DeviceMap, position: Position): string | undefined {
  if (map.id !== position.map) return undefined
  const area = (points: number[][]) =>
    Math.abs(
      points.reduce((sum, a, i) => {
        const b = points[(i + 1) % points.length]!
        return sum + a[0]! * b[1]! - b[0]! * a[1]!
      }, 0),
    )
  for (const place of [...(map.places ?? [])].sort(
    (a, b) => area(a.points ?? []) - area(b.points ?? []) || a.id.localeCompare(b.id),
  )) {
    const points = place.points
    if (!points) continue
    let inside = false
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i],
        b = points[j]
      if (!a || !b) continue
      const cross = (position.x - a[0]) * (b[1] - a[1]) - (position.y - a[1]) * (b[0] - a[0])
      if (
        Math.abs(cross) < 1e-9 &&
        position.x >= Math.min(a[0], b[0]) &&
        position.x <= Math.max(a[0], b[0]) &&
        position.y >= Math.min(a[1], b[1]) &&
        position.y <= Math.max(a[1], b[1])
      )
        return place.id
      if (
        a[1] > position.y !== b[1] > position.y &&
        position.x < ((b[0] - a[0]) * (position.y - a[1])) / (b[1] - a[1]) + a[0]
      )
        inside = !inside
    }
    if (inside) return place.id
  }
  return undefined
}

/** Project bounded, approved navigation coordinates without exposing arbitrary tool arguments. */
export function navigationFrom(
  input: unknown,
): { route: [number, number][]; target?: [number, number] } | undefined {
  const data =
    input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  const point = (v: unknown): [number, number] | undefined => {
    const p = Array.isArray(v)
      ? v
      : v && typeof v === 'object'
        ? [(v as Record<string, unknown>).x, (v as Record<string, unknown>).y]
        : []
    return p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n))
      ? (p as [number, number])
      : undefined
  }
  const raw = data.route ?? data.points,
    route =
      Array.isArray(raw) && raw.length <= 256
        ? raw.map(point).filter((p): p is [number, number] => p !== undefined)
        : []
  const target = point(data.target) ?? point(data)
  return target || route.length ? { route, ...(target ? { target } : {}) } : undefined
}
