/**
 * Turns what a device declares into what a page shows: names, the colour of its status bar, its key
 * numbers, readable arguments. Only the protocol is used; no device, tool or field name is special.
 */
import { t } from '../i18n/i18n.js'
import type { Device, Field, Json, Manual, Param, Source, Tool, World } from './types.js'

type Pt = [number, number]

export type Tone = 'ok' | 'busy' | 'warn' | 'bad' | 'off'

/** The status bar (mhs-ui-design 13.3): grey unavailable, red bad, amber attention or paused, accent busy. */
export function tone(d: Device): Tone {
  if (!d.available) return 'off'
  if (d.health.level === 'bad') return 'bad'
  const jobs = d.jobs ?? []
  if (d.health.level === 'attention' || jobs.some((j) => j.state === 'paused')) return 'warn'
  if (jobs.length > 0 || manualNow(d)) return 'busy'
  return 'ok'
}

export function manualNow(d: Device): boolean {
  return Object.values(d.busy ?? {}).some((b) => b?.manual)
}

export function displayName(d: Device): string {
  return d.name ?? d.id
}

/** Fields that are part of the protocol rather than the device's own state. */
const RESERVED = new Set(['problem', 'faults'])

export function visibleFields(d: Device): [string, Field][] {
  return Object.entries(d.state.fields).filter(([name, f]) => !RESERVED.has(name) && !f.ui?.hidden)
}

/**
 * The numbers worth showing on a small card (13.1): fields marked `ui.tile`; otherwise fields with
 * a role or an alert; otherwise the first few.
 */
export function keyFields(d: Device, max = 4): [string, Field][] {
  const fields = visibleFields(d)
  const tiles = fields.filter(([, f]) => f.ui?.tile)
  if (tiles.length > 0) return tiles.slice(0, max)
  const marked = fields.filter(([, f]) => f.role || f.alert)
  const rest = fields.filter(([, f]) => !(f.role || f.alert))
  return [...marked, ...rest].slice(0, max)
}

export function primaryImage(d: Device): Source | undefined {
  const images = d.sources.filter((s) => (s.kind === 'image' || s.kind === 'video') && !s.ui?.hidden)
  return images.find((s) => s.id === d.ui?.primary) ?? images.find((s) => s.kind === 'image') ?? images[0]
}

/**
 * The live picture a device's card shows: only a device that moves gets one, since its view is what
 * changes; a fixed camera's picture stays on its device page.
 */
export function previewImage(d: Device): Source | undefined {
  return d.mobile ? primaryImage(d) : undefined
}

/** The maps to draw: AgnesHub's worlds, then maps that a device's position names without one. */
export function worldMaps(worlds: World[], devices: Device[]): World[] {
  const out = [...worlds]
  for (const d of devices) {
    const map = d.position?.map
    if (map && !out.some((w) => w.map === map)) out.push({ map, entities: [] })
  }
  return out
}

/** The devices on a map now, with a position to draw. */
export function devicesOn(map: string, devices: Device[]): Device[] {
  return devices.filter(
    (d) => d.position?.map === map && d.position.x !== undefined && d.position.y !== undefined,
  )
}

/**
 * The part of a map to show, [xmin, ymin, xmax, ymax] in metres: its declared bounds, otherwise
 * everything on it (places, devices, `more` such as the grid's corners) with a margin, at least 4 m.
 */
export function worldExtent(
  world: World,
  devices: Device[],
  more: Pt[] = [],
): [number, number, number, number] {
  if (world.bounds) return world.bounds
  const pts: Pt[] = [...more]
  for (const p of world.places ?? []) {
    if (p.at) pts.push(p.at)
    for (const q of p.points ?? []) pts.push(q)
  }
  for (const d of devicesOn(world.map, devices)) pts.push([d.position?.x ?? 0, d.position?.y ?? 0])
  if (pts.length === 0) return [-5, -5, 5, 5]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const pad = Math.max(2, (x1 - x0) * 0.08, (y1 - y0) * 0.08)
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const hw = Math.max(2, (x1 - x0) / 2 + pad)
  const hh = Math.max(2, (y1 - y0) / 2 + pad)
  return [cx - hw, cy - hh, cx + hw, cy + hh]
}

/** Default section of a source (13.3). */
export function sectionOf(s: Source): string {
  if (s.ui?.group) return s.ui.group
  switch (s.kind) {
    case 'image':
    case 'video':
    case 'detections':
      return 'picture'
    case 'scan':
    case 'points':
      return 'ranging'
    case 'pose':
    case 'grid':
    case 'odometry':
    case 'gnss':
      return 'place'
    case 'values':
    case 'switch':
    case 'imu':
      return 'telemetry'
    case 'audio':
      return 'sound'
    case 'text':
    case 'transcript':
      return 'text'
    default:
      return 'other'
  }
}

export const SECTIONS = [
  'picture',
  'drive',
  'actions',
  'state',
  'ranging',
  'place',
  'telemetry',
  'sound',
  'text',
  'tools',
  'sources',
  'other',
  'activity',
] as const

/** How far a value is past its alert level: undefined, 'warn' or 'bad'. */
export function alertOf(field: Field | undefined, value: unknown): 'warn' | 'bad' | undefined {
  const a = field?.alert
  if (!a || typeof value !== 'number') return undefined
  const past = (limit: number | undefined) =>
    limit !== undefined && (a.below ? value <= limit : value >= limit)
  if (past(a.bad)) return 'bad'
  if (past(a.warn)) return 'warn'
  return undefined
}

/** A short form of one value: numbers rounded, objects as compact JSON. */
export function shortValue(value: unknown): string {
  if (typeof value === 'number') return String(Math.round(value * 100) / 100)
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value) && value.every((v) => typeof v === 'number'))
    return `(${value.map((v) => shortValue(v)).join(', ')})`
  const text = JSON.stringify(value)
  return text.length > 40 ? `${text.slice(0, 39)}…` : text
}

/** "alt 5 · speed 2": arguments with the labels the tool declares. */
export function argsText(tool: Tool | undefined, args: Json | undefined): string {
  const entries = Object.entries(args ?? {})
  if (entries.length === 0) return ''
  const params = tool?.inputSchema.properties ?? {}
  // A list of objects (a route's points) reads as its length, not as JSON.
  const text = (v: unknown) =>
    Array.isArray(v) && v.some((x) => typeof x === 'object' && x !== null)
      ? t('card.items', { n: v.length })
      : shortValue(v)
  return entries.map(([name, value]) => `${params[name]?.ui?.label ?? name} ${text(value)}`).join(' · ')
}

/** The declared parameters of a tool, in declaration order, with whether each is required. */
export function paramsOf(tool: Tool): [string, Param, boolean][] {
  const required = new Set(tool.inputSchema.required ?? [])
  return Object.entries(tool.inputSchema.properties ?? {}).map(([name, p]) => [name, p, required.has(name)])
}

/** A watch condition in words: "battery < 20", "air.co2 > 1000", "health bad". */
export function untilText(until: Json): string {
  const op = (['lt', 'gt', 'eq', 'ne'] as const).find((o) => o in until)
  const sign = { lt: '<', gt: '>', eq: '=', ne: '≠' }
  if (typeof until.state === 'string' && op) return `${until.state} ${sign[op]} ${shortValue(until[op])}`
  if (typeof until.source === 'string') {
    if (op && typeof until.field === 'string')
      return `${until.source}.${until.field} ${sign[op]} ${shortValue(until[op])}`
    if (typeof until.has === 'string') return `${until.source} has ${until.has}`
    if (typeof until.says === 'string') return `${until.source} says "${until.says}"`
  }
  if (typeof until.health === 'string') return `health ${until.health}`
  if (typeof until.trust === 'string') return `position ${until.trust}`
  return JSON.stringify(until)
}

/** Map coordinates found in job arguments: one target, or a route. */
export function targetsOf(args: Json | undefined): { point?: Pt; route?: Pt[] } {
  const out: { point?: Pt; route?: Pt[] } = {}
  const asPt = (v: unknown): Pt | undefined => {
    if (Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number')
      return [v[0], v[1]]
    if (v && typeof v === 'object' && typeof (v as Json).x === 'number' && typeof (v as Json).y === 'number')
      return [(v as Json).x as number, (v as Json).y as number]
    return undefined
  }
  if (!args) return out
  if (typeof args.x === 'number' && typeof args.y === 'number') out.point = [args.x, args.y]
  for (const value of Object.values(args)) {
    if (!out.point) {
      const p = asPt(value)
      if (p && !Array.isArray(value)) out.point = p
    }
    if (Array.isArray(value) && value.length >= 2 && value.every((v) => asPt(v)))
      out.route = value.map((v) => asPt(v) as Pt)
  }
  return out
}

/** Suggested keys per role: [positive, negative] (MHS Appendix B.2). */
const ROLE_KEYS: Record<string, [string, string]> = {
  forward: ['w', 's'],
  turn: ['a', 'd'],
  strafe: ['q', 'e'],
  up: ['r', 'f'],
  roll: ['z', 'c'],
  pitch: ['ArrowUp', 'ArrowDown'],
  yaw: ['ArrowLeft', 'ArrowRight'],
  zoom: ['=', '-'],
  grip: ['g', 'h'],
}

export function keysOf(manual: Manual): Map<string, [string, number]> {
  const out = new Map<string, [string, number]>()
  const roles = new Set(manual.axes.map((a) => a.role))
  for (const axis of manual.axes) {
    const keys = axis.keys ?? ROLE_KEYS[axis.role]
    if (!keys) continue
    out.set(keys[0].toLowerCase(), [axis.id, 1])
    out.set(keys[1].toLowerCase(), [axis.id, -1])
  }
  // Without pitch and yaw, the arrow keys drive like WASD.
  if (!roles.has('pitch') && !roles.has('yaw')) {
    const forward = manual.axes.find((a) => a.role === 'forward')
    const turn = manual.axes.find((a) => a.role === 'turn')
    if (forward) {
      out.set('arrowup', [forward.id, 1])
      out.set('arrowdown', [forward.id, -1])
    }
    if (turn) {
      out.set('arrowleft', [turn.id, 1])
      out.set('arrowright', [turn.id, -1])
    }
  }
  return out
}

/** The brain's device tools (hub-api.md section 15.1). */
export const BRAIN_TOOLS = [
  'list_devices',
  'read_device',
  'call_device',
  'set_device',
  'stop_device',
  'watch_device',
  'unwatch_device',
] as const

/** The brain's device calls among a conversation's tool nodes, newest first. */
export function brainCalls<T extends { kind?: string; name?: string }>(nodes: readonly T[]): T[] {
  return nodes
    .filter((n) => n.kind === 'tool' && (BRAIN_TOOLS as readonly string[]).includes(String(n.name)))
    .reverse()
}
