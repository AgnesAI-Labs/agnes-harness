import { validateRegistration } from '@agnes/mhs-device'
import type { DeviceView } from '@agnes/mhs-hub'
import type { JsonValue } from '@agnes/protocol'

/** UI projection, normalized from the Hub's versioned query; not a second device protocol. */
export type Data = Record<string, unknown>
export const record = (v: unknown): Data =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : {}
export const text = (v: unknown): string => (typeof v === 'string' ? v : '')
export const number = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
export const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export type Device = {
  id: string
  name: string
  revision: string
  online: boolean
  available: boolean
  health: string
  trust: string
  origin: string
  simulated: boolean | undefined
  description: DeviceView['description']
  fields: Data
  state: Data
  jobs: Data[]
  sourceStates: Data
  tools: Data[]
  sources: Data[]
  manual: Data
  position: Data
}
export function devicesFrom(value: unknown): Device[] {
  if (!Array.isArray(value)) throw new Error('invalid-device-projection')
  return value.map((raw): Device => {
    const d = record(raw),
      desc = validateRegistration(d.description),
      info = record(desc.device),
      ui = record(desc.ui)
    if (
      !text(d.id) ||
      !text(d.revision) ||
      typeof d.online !== 'boolean' ||
      typeof d.available !== 'boolean' ||
      info.id !== d.id
    )
      throw new Error('invalid-device-projection')
    return {
      id: d.id as string,
      name: text(info.name) || text(d.id),
      revision: d.revision as string,
      online: d.online,
      available: d.available,
      health: text(d.health),
      trust: text(d.trust),
      origin: text(ui.example) || text(ui.group),
      simulated: typeof ui.simulated === 'boolean' ? ui.simulated : undefined,
      description: desc,
      fields: record(desc.state),
      state: record(d.state),
      sourceStates: record(d.sourceStates),
      jobs: array(d.jobs).map(record),
      tools: array(desc.tools).map(record),
      sources: array(desc.sources).map(record),
      manual: record(desc.manual),
      position: record(d.position),
    }
  })
}
export const TOOL_NAMES = [
  'list_devices',
  'read_device',
  'call_device',
  'set_device',
  'stop_device',
  'watch_device',
  'unwatch_device',
] as const
export type ToolRecord = {
  id: string
  name: string
  device: string
  args: unknown
  result: unknown
  state: string
  callSeq?: number
}
/** Read only the selected session's supported UI projection; never a global device cache. */
export function toolsFrom(value: unknown): ToolRecord[] {
  const root = record(value)
  const nodes = Array.isArray(value) ? value : array(root.nodes)
  return nodes
    .flatMap((raw, i) => {
      const n = record(raw)
      if (n.kind !== 'tool' || !TOOL_NAMES.includes(n.name as (typeof TOOL_NAMES)[number])) return []
      const args = n.args ?? parsePreview(n.argsPreview) ?? n.arguments ?? n.input
      const a = record(args)
      return [
        {
          id: text(n.toolUseId) || String(i),
          name: text(n.name),
          device: text(a.device),
          args,
          result: n.result ?? parsePreview(n.resultPreview) ?? n.resultPreview ?? n.output,
          state: text(n.state) || text(n.status),
          ...(typeof (n.callSeq ?? n.seq) === 'number' ? { callSeq: number(n.callSeq ?? n.seq) } : {}),
        },
      ]
    })
    .reverse()
}
export type Activity = {
  id: string
  at: number
  type: string
  device: string
  sessionId: string
  detail: unknown
}
export function activityFrom(raw: unknown): {
  events: Activity[]
  earliest: number | null
  nextCursor?: string
} {
  const page = record(raw)
  if (!Array.isArray(page.events)) throw new Error('invalid-activity-projection')
  return {
    events: page.events.map((v) => {
      const e = record(v)
      return {
        id: text(e.id),
        at: number(e.at),
        type: text(e.type),
        device: text(e.device),
        sessionId: text(e.sessionId),
        detail: e.detail,
      }
    }),
    earliest: typeof page.earliest === 'number' ? page.earliest : null,
    ...(text(page.nextCursor) ? { nextCursor: text(page.nextCursor) } : {}),
  }
}
export const jsonText = (v: unknown): string => JSON.stringify(v, null, 2) ?? '—'
export const asJson = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue
export const isException = (e: Activity): boolean =>
  /error|fault|stop|interrupt|reject|disconnect|health|unknown/.test(e.type) ||
  /error|bad|unknown|reject|interrupt/.test(jsonText(e.detail))

function parsePreview(value: unknown): unknown {
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
