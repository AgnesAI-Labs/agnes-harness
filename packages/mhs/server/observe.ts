import type { Field, NerveData, Source } from '../gen/ts/mhs-v1.js'
import { type AlertLevel, alertLevel, type DeviceInfo, type South } from './south.js'
import {
  type FieldAlert,
  type Flow,
  type Health,
  health,
  type PoseItem,
  type Position,
  position,
} from './summary.js'

/** What AgnesHub watches in the data to judge health and position (hub-api.md section 6). */

const WINDOW_S = 10
const JUMP_M = 1
const JUMP_KEPT_S = 5

interface Stream {
  times: number[]
  lost: { time: number; n: number }[]
  lastSeq: number | undefined
  newest: number | undefined
}

/** A field of a values or switch source that crossed its alert level. */
export interface ValueAlert {
  source: string
  name: string
  field: Field
  level: AlertLevel
  value: unknown
}

/** A source someone uses: the rate asked for and since when. */
export interface Wanted {
  wanted: number
  since: number
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

export class Observer {
  private readonly streams = new Map<string, Stream>()
  private readonly levels = new Map<string, AlertLevel>()
  private readonly poses = new Map<string, PoseItem>()
  private readonly odometry = new Map<string, { x: number; y: number }>()
  private readonly odometryAtPose = new Map<string, { x: number; y: number }>()
  private readonly jumps = new Map<string, { reason: string; until: number }>()

  constructor(private readonly south: South) {}

  /** Records one data message at hub time `time`; returns the fields whose alert level changed. */
  onData(device: string, source: Source, msg: NerveData, time: number): ValueAlert[] {
    const key = `${device}/${source.id}`
    const stream = this.streams.get(key) ?? { times: [], lost: [], lastSeq: undefined, newest: undefined }
    if (stream.lastSeq !== undefined && msg.seq > stream.lastSeq + 1)
      stream.lost.push({ time, n: msg.seq - stream.lastSeq - 1 })
    stream.lastSeq = msg.seq
    stream.newest = time
    stream.times.push(time)
    while ((stream.times[0] ?? time) < time - WINDOW_S) stream.times.shift()
    while ((stream.lost[0]?.time ?? time) < time - WINDOW_S) stream.lost.shift()
    this.streams.set(key, stream)

    const data = msg.data as Record<string, unknown>
    if (source.kind === 'pose') this.onPose(device, data, time)
    if (source.kind === 'odometry') this.odometry.set(device, { x: Number(data.x), y: Number(data.y) })
    if (source.kind !== 'values' && source.kind !== 'switch') return []
    const changed: ValueAlert[] = []
    const fields = (source as { fields?: Record<string, Field> }).fields ?? {}
    for (const [name, field] of Object.entries(fields)) {
      if (!field.alert || !(name in data)) continue
      const level = alertLevel(field, data[name])
      const levelKey = `${key}/${name}`
      if (level !== (this.levels.get(levelKey) ?? 'ok'))
        changed.push({ source: source.id, name, field, level, value: data[name] })
      this.levels.set(levelKey, level)
    }
    return changed
  }

  private onPose(device: string, data: Record<string, unknown>, time: number): void {
    const pose: PoseItem = {
      time,
      map: String(data.map),
      x: Number(data.x),
      y: Number(data.y),
      yaw: Number(data.yaw),
      ok: data.ok === true,
      ...(Array.isArray(data.cov) ? { cov: data.cov as number[] } : {}),
    }
    const previous = this.poses.get(device)
    const odometry = this.odometry.get(device)
    const before = this.odometryAtPose.get(device)
    if (previous && odometry && before) {
      const moved = dist(pose, previous)
      const odometryMoved = dist(odometry, before)
      if (moved - odometryMoved > JUMP_M)
        this.jumps.set(device, {
          reason: `jumped ${moved.toFixed(1)} m while odometry moved ${odometryMoved.toFixed(1)} m`,
          until: time + JUMP_KEPT_S,
        })
    }
    if (odometry) this.odometryAtPose.set(device, odometry)
    this.poses.set(device, pose)
  }

  /** Every field past its alert level: state fields and fields of values sources. */
  alerts(info: DeviceInfo): FieldAlert[] {
    const out: FieldAlert[] = []
    const state = this.south.state(info.id)
    const stateFields = (info.description.state ?? {}) as Record<string, Field>
    for (const [name, level] of Object.entries(state?.levels ?? {})) {
      const field = stateFields[name]
      if (field && level !== 'ok') out.push({ name, field, value: state?.values[name], level })
    }
    for (const source of info.description.sources ?? []) {
      const fields = (source as { fields?: Record<string, Field> }).fields ?? {}
      const latest = this.south.latest(info.id, source.id)?.msg.data as Record<string, unknown> | undefined
      for (const [name, field] of Object.entries(fields)) {
        const level = this.levels.get(`${info.id}/${source.id}/${name}`)
        if (level && level !== 'ok') out.push({ name, field, value: latest?.[name], level })
      }
    }
    return out
  }

  health(info: DeviceInfo, available: boolean, wanted: Map<string, Wanted>, now: number): Health {
    const values = this.south.state(info.id)?.values ?? {}
    const flows: Flow[] = []
    for (const [source, w] of wanted) {
      const stream = this.streams.get(`${info.id}/${source}`)
      const times = (stream?.times ?? []).filter((t) => t > now - WINDOW_S)
      const lost = (stream?.lost ?? []).filter((l) => l.time > now - WINDOW_S).reduce((n, l) => n + l.n, 0)
      const newest = stream?.newest !== undefined && stream.newest >= w.since ? stream.newest : undefined
      flows.push({ source, wanted: w.wanted, times, lost, newest, since: w.since })
    }
    return health({
      available,
      problem: values.problem,
      faults: values.faults,
      alerts: this.alerts(info),
      flows,
      rtt: this.south.rtt(info.id),
      now,
    })
  }

  position(info: DeviceInfo, available: boolean, now: number): Position | undefined {
    const source = info.description.sources?.find((s) => s.kind === 'pose')
    const jump = this.jumps.get(info.id)
    return position({
      localization: info.description.localization,
      placement: info.description.placement,
      available,
      pose: this.poses.get(info.id),
      hz: (source as { hz?: number } | undefined)?.hz,
      maxError: (source as { max_error_m?: number } | undefined)?.max_error_m,
      jump: jump && jump.until > now ? jump.reason : undefined,
      now,
    })
  }
}
