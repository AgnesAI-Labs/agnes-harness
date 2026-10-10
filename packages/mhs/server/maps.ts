import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MapDecl, Place, Zone } from '../gen/ts/mhs-v1.js'

/**
 * The maps AgnesHub has seen (MOS 3.5, hub-api.md section 4.4): the latest declaration of each map
 * gives its frame fields, and places merge by id across declarations. Maps stay after their devices
 * go; with a file they also survive a restart of the hub.
 */
export class Maps {
  private readonly maps = new Map<string, MapDecl>()

  constructor(private readonly file?: string) {
    if (!file) return
    try {
      for (const map of JSON.parse(readFileSync(file, 'utf8')) as MapDecl[]) this.maps.set(map.id, map)
    } catch {
      // No file yet, or an unreadable one: start without maps.
    }
  }

  /** Merges a device's map declarations; true when anything changed. */
  declare(decls: MapDecl[]): boolean {
    let changed = false
    for (const decl of decls) {
      const places = new Map((this.maps.get(decl.id)?.places ?? []).map((p) => [p.id, p]))
      for (const place of decl.places ?? []) places.set(place.id, place)
      const { places: _, ...frame } = decl
      const merged: MapDecl = places.size > 0 ? { ...frame, places: [...places.values()] } : frame
      if (JSON.stringify(merged) === JSON.stringify(this.maps.get(decl.id))) continue
      this.maps.set(decl.id, merged)
      changed = true
    }
    if (changed) this.save()
    return changed
  }

  list(): MapDecl[] {
    return [...this.maps.values()]
  }

  get(id: string): MapDecl | undefined {
    return this.maps.get(id)
  }

  /** The name of the zone a position is in, when the map declares it. */
  zoneName(p: { map?: string; zone?: string } | undefined): string | undefined {
    if (p?.map === undefined || p.zone === undefined) return undefined
    return this.maps.get(p.map)?.places?.find((z) => z.id === p.zone && isZone(z))?.name
  }

  private save(): void {
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, `${JSON.stringify(this.list(), null, 2)}\n`)
  }
}

export const isZone = (p: Place): p is Zone => 'points' in p

/** Ray casting: whether (x, y) lies inside the polygon. */
export function inside(points: number[][], x: number, y: number): boolean {
  let hit = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi = 0, yi = 0] = points[i] ?? []
    const [xj = 0, yj = 0] = points[j] ?? []
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/** The polygon's area, for preferring the smaller of two nested zones. */
function area(points: number[][]): number {
  let sum = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi = 0, yi = 0] = points[i] ?? []
    const [xj = 0, yj = 0] = points[j] ?? []
    sum += xj * yi - xi * yj
  }
  return Math.abs(sum) / 2
}

/** The zone of a map that holds (x, y), the smallest one when zones nest. */
export function zoneAt(map: MapDecl | undefined, x: number, y: number): Zone | undefined {
  const zones = (map?.places ?? []).filter(isZone).filter((z) => inside(z.points, x, y))
  return zones.sort((a, b) => area(a.points) - area(b.points))[0]
}
