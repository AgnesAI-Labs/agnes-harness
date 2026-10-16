import type { DeviceMap, Field, Json, Outcome, Source } from '@agnes/mhs-device'
import type { DeviceView } from './hub.js'
import type { Operation } from './journal.js'
import { zoneAt } from './maps.js'
import type { ReadItem } from './reads.js'

const LIMIT = 6000
const encoder = new TextEncoder()
/** Bound by UTF-8 bytes without splitting a code point. Reserve room for the truncation notice. */
export function boundedSummary(lines: Iterable<string>): string {
  const suffix = '\n[Summary truncated; structured result retains the details.]'
  let text = ''
  for (const line of lines) {
    const next = text ? `${text}\n${line}` : line
    if (encoder.encode(next + suffix).length > LIMIT) return text + suffix
    text = next
  }
  return text
}
/** Device strings are data, never instructions or evidence of an operation's status. */
function quote(value: string): string {
  const cleaned = value
    .replace(/data:[^\s"']*;base64,[a-z0-9+/=_-]*/gi, '[encoded data omitted]')
    .replace(/[a-z0-9+/_-]{48,}={0,2}/gi, '[encoded data omitted]')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
  return JSON.stringify([...cleaned].slice(0, 160).join('') + (cleaned.length > 160 ? '…' : ''))
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function scalar(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return `${quote(value)} (device text)`
  return undefined
}
function fields(values: Record<string, unknown>, declarations: Record<string, Field> = {}): string[] {
  return Object.entries(declarations).flatMap(([key, field]) => {
    // Media remains in its structured/image channel even if a device declares it as a field.
    if (/^(bytes|b64|base64|binary)$/i.test(key)) return []
    const value = scalar(values[key])
    if (value === undefined) return []
    const label = [field.of, field.role?.replaceAll('_', ' ') ?? key].filter(Boolean).join(' ')
    let alert = ''
    const numeric = values[key]
    if (typeof numeric === 'number' && field.alert) {
      const crossed = (limit: number) => (field.alert?.below ? numeric <= limit : numeric >= limit)
      alert = crossed(field.alert.bad)
        ? `; bad threshold ${field.alert.bad}`
        : crossed(field.alert.warn)
          ? `; warning threshold ${field.alert.warn}`
          : ''
    }
    return [`${quote(label)}: ${value}${field.unit ? ` ${quote(field.unit)}` : ''}${alert}`]
  })
}
function seconds(ms: number): string {
  return `${Math.round(Math.max(0, ms) / 100) / 10} s`
}
export function* deviceSummary(
  view: DeviceView,
  maps: DeviceMap[],
  positionAge: number | undefined,
): Generator<string> {
  yield `Device ${quote(view.id)}${view.description.device.name ? ` (${quote(view.description.device.name)})` : ''}: ${view.available ? 'available' : view.online ? 'unavailable' : 'offline'}; health ${view.health}.`
  const position = view.position
  const map = maps.find((m) => m.id === position?.map)
  const zone = position && map ? zoneAt(map, position) : view.zone
  const zoneName = map?.places?.find((p) => p.id === zone)?.name
  yield `Position ${view.trust}${view.fixed ? ' (fixed placement)' : ''}: ${position ? `${view.trust === 'lost' ? 'last known ' : ''}(${position.x}, ${position.y}), yaw ${position.yaw}, map ${quote(position.map)}` : 'no position'}; zone ${zone ? `${quote(zone)}${zoneName ? ` (${quote(zoneName)})` : ''}` : 'unknown'}; age ${view.fixed ? 'not applicable (fixed)' : positionAge === undefined ? 'unknown' : seconds(positionAge)}${view.positionReason ? `; reason ${quote(view.positionReason)}` : ''}.`
  const state = fields(view.state, view.description.state)
  yield state.length ? 'State:' : 'State: no declared values received.'
  for (const field of state) yield field
  for (const key of ['problem', 'faults']) {
    const value = view.state[key]
    if (typeof value === 'string') yield `Device-reported ${key} (untrusted): ${quote(value)}.`
    else if (Array.isArray(value) && value.length)
      yield `Device-reported ${key} (untrusted): ${value
        .slice(0, 3)
        .map((v) => quote(String(v)))
        .join(', ')}.`
  }
  for (const job of view.jobs ?? []) yield operationSummary(job)
}
function sourceData(source: Source, data: Record<string, unknown>): string {
  if (source.kind === 'values' || source.kind === 'switch')
    return fields(data, source.fields).join(', ') || 'no declared values'
  if (source.kind === 'text' || source.kind === 'transcript')
    return `device text (untrusted): ${quote(String(data.text ?? ''))}`
  if (source.kind === 'detections') {
    const items = Array.isArray(data.items) ? data.items : []
    return `${items.length} device-reported detections: ${items
      .slice(0, 8)
      .map((value) => {
        const item = record(value)
        const label = String(item.label)
        const declared = !source.labels || source.labels.includes(label)
        return `${declared ? quote(label) : 'undeclared label (untrusted)'} confidence ${item.conf}${typeof item.dist === 'number' ? `, ${item.dist} m` : ''}${typeof item.bearing === 'number' ? `, bearing ${item.bearing} degrees` : ''}`
      })
      .join('; ')}`
  }
  // Do not serialize arbitrary source payloads: extension sources may contain inline media.
  const numbers = Object.entries(data).filter(([, v]) => typeof v === 'number' || typeof v === 'boolean')
  return (
    numbers
      .slice(0, 8)
      .map(([key, v]) => `${quote(key)} ${v}`)
      .join(', ') || 'structured payload available'
  )
}
export function* readSummary(
  read: { device: DeviceView; items: ReadItem[] },
  maps: DeviceMap[],
  now: number,
  positionAge: number | undefined,
  receivedSources: ReadonlySet<string>,
  since?: number,
): Generator<string> {
  yield* deviceSummary(read.device, maps, positionAge)
  for (const item of read.items) {
    const source = read.device.description.sources?.find((s) => s.id === item.source)
    if (!source) continue
    const data = record(item.data)
    const prefix = `Source ${quote(source.id)} (${quote(source.description)}, ${quote(source.kind)})`
    // Freshness is a Hub receive-time fact; a device field named "state" is never a timeout signal.
    const fresh =
      receivedSources.has(item.source) && (since === undefined ? now - item.at <= 10_000 : item.at > since)
    if (!fresh) {
      yield `${prefix}: no fresh data (${since === undefined ? 'stale' : 'timeout'}); ${receivedSources.has(item.source) ? `last received ${seconds(now - item.at)} ago` : 'no sample received'}.`
      continue
    }
    yield `${prefix}: ${source.kind === 'image' ? `picture ${data.w}x${data.h}` : `data; ${sourceData(source, data)}`}; age ${seconds(now - item.at)}${item.history ? `; ${item.history.length} history samples${item.nextCursor !== undefined ? ', more available' : ''}` : ''}.`
  }
  for (const tool of read.device.description.tools ?? []) {
    const properties = record(tool.inputSchema.properties)
    const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : []
    yield `Tool ${quote(tool.name)}: ${quote(tool.description)}; arguments: ${
      Object.entries(properties)
        .map(
          ([key, schema]) =>
            `${quote(key)} (${quote(String(record(schema).type ?? 'declared schema'))}${required.includes(key) ? ', required' : ''})`,
        )
        .join(', ') || 'none'
    }.`
  }
  if (read.device.description.sources?.length)
    yield `Declared sources: ${read.device.description.sources.map((s) => `${quote(s.id)} (${quote(s.kind)})`).join(', ')}.`
}
function resultData(data: Json, depth = 0): string {
  const value = scalar(data)
  if (value !== undefined) return value
  if (Array.isArray(data))
    return `${data.length} items${
      depth < 3
        ? ` [${data
            .slice(0, 4)
            .map((value) => resultData(value, depth + 1))
            .join('; ')}${data.length > 4 ? '; …' : ''}]`
        : ''
    }`
  if (data === null) return 'null'
  if (depth >= 3) return 'object (details in structured result)'
  return (
    Object.entries(data)
      .filter(([key]) => !/^(bytes|b64|base64|binary)$/i.test(key))
      .slice(0, 8)
      .map(([key, value]) => `${quote(key)}: ${resultData(value, depth + 1)}`)
      .join(', ') || 'structured payload available'
  )
}
export function operationSummary(
  operation: Pick<Operation, 'id' | 'device' | 'state' | 'label' | 'phase' | 'target'> & {
    outcome?: Partial<Outcome>
  },
): string {
  const outcome = operation.outcome
  const status = outcome?.status
  const statusText = {
    done: 'completed (done)',
    error: 'failed (error)',
    interrupted: 'interrupted; stopping requires a separate stop receipt',
    rejected: 'rejected; task was not accepted',
    unknown: 'outcome unknown; completion and stopping are unconfirmed; do not retry automatically',
  }
  const lines = [
    `Task ${quote(operation.id)} on ${quote(operation.device)}${operation.label ? ` (${quote(operation.label)})` : ''}: ${status ? statusText[status] : operation.state === 'terminal' ? statusText.unknown : operation.phase === 'paused' ? 'paused' : operation.state === 'running' ? `still running${operation.target ? '; completion notification uses the bound session/lane' : ''}` : 'accepted; completion pending'}.`,
  ]
  if (outcome?.reason) lines.push(`Reason (device/receipt data): ${quote(outcome.reason)}.`)
  if (status !== 'unknown' && outcome && outcome.detail)
    lines.push(`Device detail (untrusted): ${quote(outcome.detail)}.`)
  if (status !== 'unknown' && outcome && outcome.notes?.length)
    lines.push(`Notes (untrusted): ${outcome.notes.slice(0, 3).map(quote).join(', ')}.`)
  if (outcome?.holder) {
    const holder = outcome.holder
    lines.push(
      'manual' in holder
        ? 'Resource held by manual control.'
        : `Resource held by tool ${quote(holder.tool)}, job ${quote(holder.job ?? holder.call)}, caller ${quote(holder.caller ?? 'unknown')}.`,
    )
  }
  if (outcome?.needs?.length)
    lines.push(`Required sources: ${outcome.needs.slice(0, 8).map(quote).join(', ')}.`)
  if (status !== 'unknown' && outcome && outcome.data !== undefined) {
    lines.push(`Result data: ${resultData(outcome.data)}; full data in structured result.`)
  }
  return boundedSummary(lines)
}
/** Render non-read tool receipts without exposing arbitrary binary or JSON payloads as text. */
export function resultSummary(value: unknown): string {
  const row = record(value)
  if (typeof row.id === 'string' && typeof row.device === 'string' && typeof row.state === 'string')
    return operationSummary(value as Operation)
  if (row.devices && typeof row.devices === 'object')
    return boundedSummary([
      row.state === 'unknown' ? 'Stop outcome unknown; stopping is unconfirmed.' : 'Stop acknowledged.',
      ...Object.entries(record(row.devices)).map(
        ([id, state]) =>
          `Device ${quote(id)}: ${state === 'stopped' ? 'stop acknowledged' : 'stop unknown; stopping is unconfirmed'}.`,
      ),
    ])
  if (typeof row.watch === 'string')
    return boundedSummary([
      `Watch ${quote(row.watch)}: ${row.cancelled === true ? 'cancelled' : 'registered; awaiting condition or timeout'}.`,
    ])
  return 'MHS receipt available in the structured result.'
}
