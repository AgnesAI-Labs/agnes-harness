/**
 * The parts of the AgnesHub API (server/hub-api.md) and of device descriptions (MHS section 5) the
 * pages read. Field names follow the wire; anything a device may leave out is optional.
 */

export type Json = Record<string, unknown>

export interface Field {
  type: 'number' | 'integer' | 'boolean' | 'string'
  enum?: string[]
  unit?: string
  min?: number
  max?: number
  alert?: { warn?: number; bad?: number; below?: boolean }
  role?: string
  of?: string
  description?: string
  writable?: boolean
  ui?: { label?: string; tile?: boolean; widget?: string; hidden?: boolean }
}

export interface Source {
  id: string
  kind: string
  description: string
  hz?: number
  switchable?: boolean
  default?: boolean
  encoding?: string
  mime?: string
  size?: [number, number]
  fov_deg?: [number, number]
  range_m?: [number, number]
  fields?: Record<string, Field>
  of?: string
  mount?: { xyz?: [number, number, number]; rpy?: [number, number, number] }
  rate?: number
  channels?: number
  codec?: string
  ui?: { group?: string; order?: number; label?: string; hidden?: boolean; widget?: string }
}

export interface Param {
  type?: 'object' | 'number' | 'integer' | 'string' | 'boolean' | 'array'
  properties?: Record<string, Param>
  required?: string[]
  default?: unknown
  minimum?: number
  maximum?: number
  maxLength?: number
  items?: Param
  enum?: unknown[]
  description?: string
  ui?: { pick?: 'map-point' | 'map-pose' | 'map-polygon'; limit?: number; label?: string }
}

export interface Tool {
  name: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, Param>; required?: string[] }
  uses?: string[]
  motion?: boolean
  readOnly?: boolean
  pausable?: boolean
  timeout: number
  ui?: { group?: string; label?: string; confirm?: boolean | string; hidden?: boolean; widget?: string }
}

export interface Axis {
  id: string
  role: string
  unit: string
  min: number
  max: number
  keys?: [string, string]
  joint?: number
}

export interface Manual {
  axes: Axis[]
  rate_hz: number
  deadman_s: number
  speeds?: { label: string; scale: number }[]
}

export interface Health {
  level: 'ok' | 'attention' | 'bad'
  reasons: string[]
}

export interface Position {
  trust: 'trusted' | 'uncertain' | 'lost'
  map?: string
  x?: number
  y?: number
  yaw?: number
  age?: number
  reason?: string
  /** An installed device: its placement, always trusted. */
  fixed?: true
  /** The id of the zone of the map it is in. */
  zone?: string
}

/** A landmark (`at`) or a zone (`points`) on a map (MOS 3.5). */
export interface Place {
  id: string
  name: string
  at?: [number, number]
  yaw?: number
  points?: [number, number][]
  description?: string
}

/** One map as AgnesHub knows it (hub-api.md 4.4, MOS Appendix B `world`). */
export interface World {
  map: string
  name?: string
  bounds?: [number, number, number, number]
  entities: {
    device: string
    x: number
    y: number
    yaw: number
    ok: boolean
    fixed?: boolean
    zone?: string
  }[]
  places?: Place[]
}

export interface JobInfo {
  job: string
  tool: string
  caller: string
  state: 'running' | 'paused' | 'ended'
  started: number
  arguments?: Json
  ref?: string
  progress?: { done?: number; total?: number; text?: string }
  result?: Json
}

export interface DeviceState {
  fields: Record<string, Field>
  values: Record<string, unknown>
  updated: number | null
  alerts: Record<string, 'warn' | 'bad'>
}

export interface Device {
  id: string
  kind: string
  name?: string
  model?: string
  vendor?: string
  mobile?: boolean
  online: boolean
  available: boolean
  since: number
  localization?: 'self' | 'external' | 'fixed' | 'none'
  placement?: { map: string; x: number; y: number; yaw: number }
  profile?: { size_m?: [number, number, number] }
  resources?: Record<string, string>
  state: DeviceState
  busy?: Record<string, { job?: string; tool?: string; caller?: string; manual?: boolean } | null>
  jobs?: JobInfo[]
  off?: string[]
  health: Health
  position?: Position
  sources: Source[]
  tools?: Tool[]
  manual?: Manual
  ui?: { icon?: string; primary?: string; order?: number }
}

export interface Item {
  source: string
  kind: string
  seq?: number
  time?: number
  age?: number
  data?: unknown
  mime?: string
  b64?: string
  bin?: true
  error?: string
  text: string
  history?: { time: number; data: unknown }[]
}

export interface HubEvent {
  id: string
  time: number
  device?: string
  type: string
  level: 'info' | 'warning' | 'critical'
  text: string
  data: Json
}

/** hub/result params. */
export interface JobResult {
  job: string
  device: string
  tool: string
  status: 'done' | 'rejected' | 'interrupted' | 'error'
  reason?: string
  detail?: string
  notes?: string[]
  time?: number
  after?: { pose?: { x: number; y: number; yaw: number; ok: boolean; map?: string } }
  data?: Json
  text: string
}
