import type { Field } from '../gen/ts/mhs-v1.js'

/**
 * AgnesHub's health and position summaries (hub-api.md section 6): plain functions over what the
 * hub already knows, so the brain need not learn each device's field names.
 */

export type HealthLevel = 'ok' | 'attention' | 'bad'
export type Trust = 'trusted' | 'uncertain' | 'lost'

export interface Health {
  level: HealthLevel
  reasons: string[]
}

export interface Position {
  trust: Trust
  map?: string
  x?: number
  y?: number
  yaw?: number
  age?: number
  reason?: string
  /** An installed device: its placement, always trusted. */
  fixed?: true
  /** The id of the zone of the map the position is in. */
  zone?: string
}

/** A field past its alert level, from state or a values source. */
export interface FieldAlert {
  name: string
  field: Field
  value: unknown
  level: 'warn' | 'bad'
}

/** How a source someone uses is flowing: items in the last 10 s, its newest, and lost seqs. */
export interface Flow {
  source: string
  /** Items per second asked for. */
  wanted: number
  /** Hub times of the items of the last 10 s, oldest first. */
  times: number[]
  /** Items lost by seq gaps in the last 10 s. */
  lost: number
  /** Hub time of the newest item, if any arrived since the source was wanted. */
  newest: number | undefined
  /** Hub time since when the source is wanted. */
  since: number
}

export interface HealthInput {
  available: boolean
  problem: unknown
  faults: unknown
  alerts: FieldAlert[]
  flows: Flow[]
  rtt: number | undefined
  now: number
}

const round = (n: number, digits = 1) => Number(n.toFixed(digits))

/** "motor temperature", "battery", or the field's own name without a role. */
export function fieldLabel(name: string, field: Field): string {
  const { role, of } = field as Field & { role?: string; of?: string }
  if (!role) return name
  const words = role.replace(/_/g, ' ')
  return of && of !== role ? `${of} ${words}` : words
}

function alertReason(a: FieldAlert): string {
  const alert = a.field.alert ?? {}
  const threshold = a.level === 'bad' ? alert.bad : alert.warn
  const unit = a.field.unit ? ` ${a.field.unit}` : ''
  const value = typeof a.value === 'number' ? round(a.value, 2) : String(a.value)
  return `${fieldLabel(a.name, a.field)} ${value}${unit} (${a.level}${threshold === undefined ? '' : ` ${threshold}`})`
}

/** hub-api.md 6.1. Reasons come worst first. */
export function health(input: HealthInput): Health {
  const bad: string[] = []
  const attention: string[] = []
  if (!input.available) bad.push('not available')
  for (const a of input.alerts) (a.level === 'bad' ? bad : attention).push(alertReason(a))
  if (typeof input.problem === 'string') attention.push(input.problem)
  if (Array.isArray(input.faults) && input.faults.length > 0)
    attention.push(`faults: ${input.faults.join(', ')}`)
  for (const f of input.flows) {
    const wanted = Math.max(f.wanted, 0.01)
    const quiet = input.now - (f.newest ?? f.since)
    if (quiet > 10) {
      bad.push(`${f.source}: nothing for ${Math.round(quiet)} s`)
      continue
    }
    const period = 1 / wanted
    if (f.newest !== undefined && quiet > 3 * period && quiet > 1)
      attention.push(`${f.source}: newest ${round(quiet)} s old`)
    if (input.now - f.since >= 5) {
      const recent = f.times.filter((t) => t > input.now - 5).length / 5
      if (recent < wanted / 2) attention.push(`${f.source}: ${round(recent)}/${round(wanted)} per second`)
    }
    const total = f.times.length + f.lost
    if (total >= 5 && f.lost / total > 0.2)
      attention.push(`${f.source}: ${Math.round((100 * f.lost) / total)} % lost`)
  }
  if (input.available && input.rtt !== undefined && input.rtt > 1)
    attention.push(`slow link: ${round(input.rtt)} s round trip`)
  const level: HealthLevel = bad.length > 0 ? 'bad' : attention.length > 0 ? 'attention' : 'ok'
  return { level, reasons: [...bad, ...attention] }
}

export interface PoseItem {
  time: number
  map: string
  x: number
  y: number
  yaw: number
  ok: boolean
  cov?: number[]
}

export interface PositionInput {
  localization: string | undefined
  /** Where a fixed device is installed (REG-4). */
  placement?: { map: string; x: number; y: number; yaw: number } | undefined
  available: boolean
  pose: PoseItem | undefined
  /** Declared rate of the pose source, if any. */
  hz: number | undefined
  maxError: number | undefined
  /** Set while a jump that odometry does not explain is recent. */
  jump: string | undefined
  now: number
}

/** hub-api.md 6.2; undefined for devices that do not localize. */
export function position(input: PositionInput): Position | undefined {
  const placed = input.placement
  if (input.localization === 'fixed' && placed)
    return { trust: 'trusted', map: placed.map, x: placed.x, y: placed.y, yaw: placed.yaw, fixed: true }
  if (input.localization !== 'self' && input.localization !== 'external') return undefined
  const p = input.pose
  if (!p)
    return { trust: 'lost', reason: input.localization === 'external' ? 'not placed' : 'no position yet' }
  const age = round(Math.max(0, input.now - p.time), 1)
  const where = { map: p.map, x: p.x, y: p.y, yaw: p.yaw, age }
  if (!input.available) return { trust: 'lost', ...where, reason: 'device not available' }
  if (age > 10) return { trust: 'lost', ...where, reason: `no position for ${Math.round(age)} s` }
  if (!p.ok) return { trust: 'uncertain', ...where, reason: 'the device does not trust its fix' }
  if (input.maxError !== undefined && p.cov && p.cov.length === 9) {
    const error = Math.sqrt(Math.max(p.cov[0] ?? 0, p.cov[4] ?? 0))
    if (error > input.maxError)
      return {
        trust: 'uncertain',
        ...where,
        reason: `position error ${round(error, 2)} m, over ${input.maxError} m`,
      }
  }
  if (input.jump) return { trust: 'uncertain', ...where, reason: input.jump }
  const stale = Math.max(2, input.hz ? 3 / input.hz : 0)
  if (age > stale) return { trust: 'uncertain', ...where, reason: `position ${age} s old` }
  return { trust: 'trusted', ...where }
}

/**
 * "Attention: battery 15 % (warn 20)." and "At (1.2, -3) facing 40° on map office, in zone Lab (lab),
 * 0.3 s old.", the zone by its name and id, or by its id alone when it has no other name.
 */
export function summaryText(h: Health, p: Position | undefined, zoneName?: string): string {
  const parts: string[] = []
  if (h.level !== 'ok') parts.push(`${h.level === 'bad' ? 'Bad' : 'Attention'}: ${h.reasons.join('; ')}.`)
  if (p) {
    const zone = zoneName && zoneName !== p.zone ? `${zoneName} (${p.zone})` : p.zone
    const at =
      p.x === undefined || p.y === undefined
        ? ''
        : `(${round(p.x, 2)}, ${round(p.y, 2)}) facing ${Math.round(p.yaw ?? 0)}°${p.map ? ` on map ${p.map}` : ''}${zone ? `, in zone ${zone}` : ''}`
    if (p.fixed) parts.push(`Installed at ${at}.`)
    else if (p.trust === 'trusted') parts.push(`At ${at}, ${p.age} s old.`)
    else if (p.trust === 'uncertain') parts.push(`Position uncertain: ${at}, ${p.reason}.`)
    else
      parts.push(
        at ? `Position lost (${p.reason}): last known ${at}, ${p.age} s ago.` : `Position lost: ${p.reason}.`,
      )
  }
  return parts.join(' ')
}
