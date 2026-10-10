import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { type RawData, type WebSocket, WebSocketServer } from 'ws'
import type { Field, NerveData, Source, WorldData } from '../gen/ts/mhs-v1.js'
import { Maps, zoneAt } from './maps.js'
import { Observer, type ValueAlert, type Wanted } from './observe.js'
import type { DeviceInfo, Latest, Outcome, South } from './south.js'
import {
  fieldLabel,
  type Health,
  type HealthLevel,
  type Position,
  summaryText,
  type Trust,
} from './summary.js'

/**
 * The northbound side of AgnesHub (server/hub-api.md): the brain, device pages and agents use devices
 * through it: sessions, the device table, state, reading and data subscriptions (step N1); calls,
 * jobs, control and settings (step N2); health and position, events and watches (step N3); manual
 * control, source switches and demand (step N4). The WebSocket at /ws/hub and in-process callers (the brain)
 * use the same methods.
 */

type Json = Record<string, unknown>

export const HUB_PATH = '/ws/hub'
/** Errors of hub-api.md section 2, besides the JSON-RPC ones. */
export const HUB_ERROR = { notAllowed: -32004, unknown: -32005 } as const

/** How long hub/read waits for data newer than `since`. */
const SINCE_WAIT_MS = 2000
/** How much `values` history hub/read keeps, at one sample a second. */
const HISTORY_S = 120
/** Subscribed data is dropped, never queued, while a client has this much unsent. */
const LAG_BYTES = 1 << 20
/** How long a finished job's result stays readable with hub/job. */
const JOB_KEPT_MS = 10 * 60_000
/** How long events stay for subscriptions with `since`. */
const EVENTS_KEPT_S = 600
const WATCHES_PER_CALLER = 20
const WATCH_TIMEOUT_S = { default: 600, max: 3600 }
/** How long a hub/read keeps a source on. */
const READ_DEMAND_S = 10
/** Pose sources stay on at this rate so that position is always current. */
const POSE_HZ = 1
/** Manual input after this long a pause counts as a new takeover (one `manual` event). */
const MANUAL_QUIET_S = 1

export interface Caller {
  name: string
  level: 1 | 2
}

export interface DeviceEntry {
  id: string
  kind: string
  [key: string]: unknown
  online: boolean
  available: boolean
  since: number
  sources: Source[]
  state: EntryState
  health: Health
  position?: Position
}

export interface EntryState {
  /** The device's declaration of its state fields (MHS 10.1). */
  fields: Record<string, Field>
  values: Record<string, unknown>
  /** When the state last changed, on the hub's clock; null before the first report. */
  updated: number | null
  /** Fields past their alert level. */
  alerts: Record<string, 'warn' | 'bad'>
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
  history?: { time: number; data: unknown }[]
  error?: string
  text: string
}

export interface ReadParams {
  device: string
  sources?: string[]
  kinds?: string[]
  since?: number
  history?: boolean
}

export interface ReadResult {
  state: EntryState
  health: Health
  position?: Position
  items: Item[]
  text: string
}

export interface SubscribeParams {
  device: string
  sources: string[]
  hz?: number
  binary?: boolean
}

export interface CallParams {
  device: string
  tool: string
  arguments?: Json
  /** The caller's own reference for the call, kept on the job (the brain uses its tool call id). */
  ref?: string
}

/** Where a job's progress and result go: the connection that made the call, or an in-process caller. */
export interface JobSink {
  progress?: (params: Json) => void
  result?: (params: Json) => void
}

export interface Job {
  job: string
  device: string
  tool: string
  caller: string
  state: 'running' | 'paused' | 'ended'
  started: number
  arguments: Json
  ref?: string
  /** The newest progress the device reported: `done`, `total`, `text`. */
  progress?: Json
  /** The hub/result params once the job ended. */
  result?: Json
}

export type EventLevel = 'info' | 'warning' | 'critical'

export interface HubEvent {
  id: string
  time: number
  device?: string
  type: string
  level: EventLevel
  text: string
  data: Json
}

export interface WatchParams {
  device: string
  until: Json
  timeout?: number
  note?: string
}

export interface NorthOptions {
  name?: string
  version?: string
  log?: (line: string) => void
  /** Where to keep the maps devices declare, so they survive a restart; in memory only without it. */
  mapsFile?: string
}

export class HubError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

interface Subscription {
  device: string
  sources: Set<string>
  /** Least milliseconds between items of one source; 0 for every item. */
  gap: number
  binary: boolean
  sent: Map<string, number>
  /** Video sources that wait for a keyframe before their first item. */
  awaitingKey: Set<string>
  /** Hub time of the subscription, for judging the stream's health. */
  since: number
}

interface Traffic {
  mhs_up: number
  mhs_down: number
  nerve_up: number
  nerve_down: number
  bytes_up: number
}

interface EventSubscription {
  types: Set<string> | undefined
  device: string | undefined
}

interface Watch {
  id: string
  caller: string
  device: string
  until: Json
  note: string | undefined
  timeout: number
  since: number
  timer: NodeJS.Timeout
  deliver: (event: HubEvent) => void
}

interface Client {
  ws: WebSocket
  caller: Caller | undefined
  subs: Map<string, Subscription>
  events: Map<string, EventSubscription>
  watches: Set<string>
  /** Devices this client steered by hand; they get all-zero input when it disconnects. */
  steering: Set<string>
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const now = () => Date.now() / 1000
const round = (n: number, digits = 1) => Number(n.toFixed(digits))

/**
 * Emits `event` (HubEvent) for every event of section 11, so in-process callers such as the brain
 * see what pages see.
 */
export class North extends EventEmitter {
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly clients = new Set<Client>()
  /** Every device seen, so devices that went away stay listed with their last description. */
  private readonly known = new Map<string, DeviceInfo>()
  private readonly histories = new Map<string, { time: number; data: unknown }[]>()
  private readonly waiters = new Set<{ device: string; source: string; since: number; wake: () => void }>()
  private readonly log: (line: string) => void
  private sessions = 0
  private subs = 0
  private jobCount = 0
  private readonly jobs = new Map<string, Job & { call: string; sink: JobSink; uses: string[] }>()
  /** `${device}/${call id}` to job id, to name holders and stopped calls by job. */
  private readonly byCall = new Map<string, string>()
  /** Messages each way per device since the last `hub/traffic` (section 4.3). */
  private readonly traffic = new Map<string, Traffic>()
  /** What pages last saw of each device's health and position (review). */
  private readonly lastLook = new Map<string, string>()
  private readonly observer: Observer
  private readonly events: HubEvent[] = []
  private eventCount = 0
  private readonly watches = new Map<string, Watch>()
  private watchCount = 0
  private readonly lastHealth = new Map<string, HealthLevel>()
  private readonly lastTrust = new Map<string, Trust>()
  private readonly ticker: NodeJS.Timeout
  /** `${device}/${source}` switched off by hand with hub/configure. */
  private readonly offByHand = new Set<string>()
  /** `${device}/${source}` kept on by a recent hub/read, until this hub time. */
  private readonly readDemand = new Map<string, number>()
  /** `${device}/${source}` to the setting last applied, as JSON. */
  private readonly applied = new Map<string, string>()
  private readonly pendingDemand = new Set<string>()
  /** Hub time of the last non-zero manual input per device. */
  private readonly lastManual = new Map<string, number>()
  /** Every map devices declared (MOS 3.5), kept after they go. */
  readonly maps: Maps

  constructor(
    private readonly south: South,
    private readonly options: NorthOptions = {},
  ) {
    super()
    this.log = options.log ?? (() => undefined)
    this.maps = new Maps(options.mapsFile)
    this.observer = new Observer(south)
    this.wss.on('connection', (ws) => this.accept(ws))
    south.on('online', (info: DeviceInfo) => {
      this.known.set(info.id, info)
      if (this.maps.declare(info.description.maps ?? []))
        this.broadcast('hub/world', { worlds: this.worlds() })
      for (const key of [...this.applied.keys()]) if (key.startsWith(`${info.id}/`)) this.applied.delete(key)
      this.scheduleDemand(info.id)
      this.changed(info.id)
      this.publish({
        device: info.id,
        type: 'online',
        level: 'info',
        text: `${info.id} is available.`,
        data: {},
      })
    })
    south.on('offline', (id: string, reason: string) => {
      this.changed(id)
      this.publish({
        device: id,
        type: 'offline',
        level: 'warning',
        text: `${id} is not available: ${reason}.`,
        data: { reason },
      })
    })
    south.on('state', (id: string, values: Record<string, unknown>) => {
      this.count(id, 'mhs_up')
      const updated = this.south.state(id)?.updated ?? {}
      const time = Math.max(...Object.keys(values).map((k) => updated[k] ?? 0))
      this.broadcast('hub/state', { device: id, time, values })
      for (const [field, value] of Object.entries(values))
        this.checkWatches(id, { state: field, value, item: values })
    })
    south.on('alert', (id: string, name: string, level: 'ok' | 'warn' | 'bad', value: unknown) => {
      const field = ((this.known.get(id)?.description.state ?? {}) as Record<string, Field>)[name]
      if (field) this.alertEvent(id, { source: '', name, field, level, value })
    })
    // Health, position and stream quality change with time as well as with data.
    this.ticker = setInterval(() => this.review(), 1000)
    this.ticker.unref?.()
    south.on('data', (device: string, msg: NerveData, binary?: Buffer) => {
      this.count(device, 'nerve_up')
      this.count(device, 'bytes_up', 100 + (binary?.length ?? 0))
      this.onData(device, msg, binary)
    })
  }

  /** Takes a WebSocket upgrade for /ws/hub; returns false for any other path. */
  handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    if (new URL(req.url ?? '/', 'http://hub').pathname !== HUB_PATH) return false
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req))
    return true
  }

  close(): void {
    clearInterval(this.ticker)
    for (const w of this.watches.values()) clearTimeout(w.timer)
    for (const ws of this.wss.clients) ws.terminate()
    this.wss.close()
  }

  /** hub/hello: who the caller is (hub-api.md section 3). */
  hello(params: unknown): Caller {
    if (!isObject(params) || (params.role !== 'ui' && params.role !== 'agent'))
      throw new HubError(-32602, 'role must be ui or agent')
    const name =
      isObject(params.client) && typeof params.client.name === 'string' ? params.client.name : 'agent'
    return params.role === 'ui' ? { name: 'web', level: 1 } : { name, level: 2 }
  }

  /** hub/devices: every device seen, with what the hub knows about it (section 4.1). */
  devices(): DeviceEntry[] {
    const current = new Map(this.south.devices().map((d) => [d.id, d]))
    for (const info of current.values()) this.known.set(info.id, info)
    return [...this.known.values()].map((info) =>
      this.entry(current.get(info.id) ?? info, current.has(info.id)),
    )
  }

  /**
   * hub/world: one `world` (MOS Appendix B) per map, declared maps first, then maps that positions
   * name without a declaration; entities are the devices whose position is on the map (section 4.4).
   */
  worlds(): WorldData[] {
    const devices = this.devices()
    const ids = this.maps.list().map((m) => m.id)
    for (const d of devices) if (d.position?.map && !ids.includes(d.position.map)) ids.push(d.position.map)
    return ids.map((id) => {
      const map = this.maps.get(id)
      const entities: WorldData['entities'] = []
      for (const d of devices) {
        const p = d.position
        if (p?.map !== id || p.x === undefined || p.y === undefined) continue
        entities.push({
          device: d.id,
          x: p.x,
          y: p.y,
          yaw: p.yaw ?? 0,
          ok: p.trust === 'trusted',
          ...(p.fixed ? { fixed: true } : {}),
          ...(p.zone ? { zone: p.zone } : {}),
        })
      }
      return {
        map: id,
        ...(map?.name ? { name: map.name } : {}),
        ...(map?.bounds ? { bounds: map.bounds } : {}),
        entities,
        ...(map?.places?.length ? { places: map.places } : {}),
      }
    })
  }

  device(id: string): DeviceEntry {
    const entry = this.devices().find((d) => d.id === id)
    if (!entry) throw new HubError(HUB_ERROR.unknown, `no device ${id}`)
    return entry
  }

  /** hub/read: state, and the newest item of each source asked for (section 7.1). */
  async read(params: ReadParams): Promise<ReadResult> {
    const entry = this.device(params.device)
    const wanted =
      params.sources ?? entry.sources.filter((s) => params.kinds?.includes(s.kind)).map((s) => s.id)
    const items = await Promise.all(wanted.map((id) => this.readSource(entry, id, params)))
    const result: ReadResult = {
      state: entry.state,
      health: entry.health,
      items,
      text: [deviceText(entry, this.maps.zoneName(entry.position)), ...items.map((i) => i.text)].join(' '),
    }
    if (entry.position) result.position = entry.position
    return result
  }

  /** hub/subscribe for data: items of these sources as they arrive (section 7.2). */
  subscribe(client: Client, params: SubscribeParams): string {
    const entry = this.device(params.device)
    const sources = entry.sources.filter((s) => params.sources.includes(s.id))
    const missing = params.sources.filter((id) => !sources.some((s) => s.id === id))
    if (missing.length > 0)
      throw new HubError(HUB_ERROR.unknown, `${entry.id} has no source ${missing.join(', ')}`)
    this.subs += 1
    const id = `s${this.subs}`
    const video = sources.filter((s) => s.kind === 'video').map((s) => s.id)
    client.subs.set(id, {
      device: entry.id,
      sources: new Set(params.sources),
      gap: params.hz && params.hz > 0 ? 1000 / params.hz : 0,
      binary: params.binary === true,
      sent: new Map(),
      awaitingKey: new Set(video),
      since: now(),
    })
    // A new viewer starts at a keyframe (MOS 7).
    if (video.length > 0) this.south.keyframe(entry.id, video).catch(() => undefined)
    this.scheduleDemand(entry.id)
    return id
  }

  /** hub/call: one job through the hub (section 8.1). Progress and the result go to `sink`. */
  async call(caller: Caller, params: CallParams, sink: JobSink = {}): Promise<Json> {
    const entry = this.device(params.device)
    const tool = (entry.tools as { name: string; uses?: string[] }[] | undefined)?.find(
      (t) => t.name === params.tool,
    )
    this.jobCount += 1
    const id = `j${this.jobCount}`
    this.count(entry.id, 'mhs_down')
    const handle = this.south.call(entry.id, params.tool, params.arguments ?? {}, {
      meta: { job: id, caller: caller.name },
      onProgress: (p) => {
        this.count(entry.id, 'mhs_up')
        const { call: _, ...rest } = p
        const job = this.jobs.get(id)
        if (job && !p.state) {
          job.progress = rest
          this.changed(entry.id)
        }
        if (job && p.state) {
          job.state = p.state
          this.changed(entry.id)
          const paused = p.state === 'paused'
          this.publish({
            device: entry.id,
            type: paused ? 'paused' : 'resumed',
            level: paused ? 'warning' : 'info',
            text: `${entry.id}: ${job.tool} ${id} ${paused ? 'paused' : 'resumed'}.`,
            data: { job: id },
          })
        }
        sink.progress?.({ job: id, ...rest })
      },
    })
    const reply = await handle.reply
    if (!reply.accepted) {
      const rejected: Json = { ...reply }
      if ('holder' in reply && reply.holder && 'call' in reply.holder) {
        const holder = this.jobs.get(this.byCall.get(`${entry.id}/${reply.holder.call}`) ?? '')
        if (holder) {
          rejected.holder = { job: holder.job, tool: holder.tool, caller: holder.caller }
          rejected.detail = `${String(reply.detail ?? 'a resource').split(' held by ')[0]} held by ${holder.tool} ${holder.job} (${holder.caller})`
        }
      }
      rejected.text = rejectionText(entry.id, params.tool, rejected)
      return rejected
    }
    const job = {
      job: id,
      device: entry.id,
      tool: params.tool,
      caller: caller.name,
      state: 'running' as const,
      started: now(),
      arguments: params.arguments ?? {},
      ...(params.ref === undefined ? {} : { ref: params.ref }),
      call: handle.id,
      sink,
      uses: tool?.uses ?? [],
    }
    this.jobs.set(id, job)
    this.byCall.set(`${entry.id}/${handle.id}`, id)
    this.changed(entry.id)
    this.publish({
      device: entry.id,
      type: 'job',
      level: 'info',
      text: `${entry.id} started ${params.tool} ${id} for ${caller.name}.`,
      data: {
        job: id,
        tool: params.tool,
        caller: caller.name,
        state: 'running',
        ...(params.ref === undefined ? {} : { ref: params.ref }),
      },
    })
    void handle.done.then((outcome) => this.ended(id, outcome))
    return { accepted: true, job: id }
  }

  /** hub/job: a job's caller, state, and its result once it ended (section 8.2). */
  job(id: string): Job {
    const job = this.jobs.get(id)
    if (!job) throw new HubError(HUB_ERROR.unknown, `no job ${id}`)
    const { call: _, sink: __, uses: ___, ...rest } = job
    return rest
  }

  async cancel(id: string): Promise<{ cancelled: boolean }> {
    const job = this.job(id)
    if (job.state === 'ended') return { cancelled: false }
    return this.south.cancel(job.device, this.jobs.get(id)?.call ?? '')
  }

  /** Stops every motion job of one device, or of every device (section 9). */
  async stop(device?: string): Promise<{ stopped: string[] }> {
    const ids = device === undefined ? this.south.devices().map((d) => d.id) : [this.device(device).id]
    for (const d of ids) this.count(d, 'mhs_down')
    const results = await Promise.all(
      ids.map((d) =>
        this.south
          .stop(d)
          .then((r) => r.stopped.map((call) => this.byCall.get(`${d}/${call}`) ?? call))
          .catch(() => [] as string[]),
      ),
    )
    return { stopped: results.flat() }
  }

  async pause(id: string): Promise<{ paused: boolean }> {
    const job = this.job(id)
    if (job.state !== 'running') return { paused: false }
    return this.south.pause(job.device, this.jobs.get(id)?.call ?? '')
  }

  async resume(id: string): Promise<{ resumed: boolean }> {
    const job = this.job(id)
    if (job.state !== 'paused') return { resumed: false }
    return this.south.resume(job.device, this.jobs.get(id)?.call ?? '')
  }

  /** hub/set: writable state fields (section 5). */
  async set(device: string, values: Json): Promise<Json> {
    const entry = this.device(device)
    if (!entry.available) throw new HubError(HUB_ERROR.unknown, `${entry.id} is not available`)
    this.count(entry.id, 'mhs_down')
    const result = await this.south.set(entry.id, values)
    const fields = entry.state.fields
    const applied = valuesText(result.values, fields)
    const refused = Object.entries(result.refused ?? {}).map(([name, why]) => `${name} ${why}`)
    const parts = [applied ? `${entry.id}: ${applied}.` : `${entry.id}: nothing changed.`]
    if (result.notes?.length) parts.push(`${result.notes.join('; ')}.`)
    if (refused.length) parts.push(`Refused: ${refused.join('; ')}.`)
    return { notes: [], refused: {}, ...result, text: parts.join(' ') }
  }

  private ended(id: string, outcome: Outcome): void {
    const job = this.jobs.get(id)
    if (!job) return
    this.count(job.device, 'mhs_up')
    const { call: _, ...rest } = outcome as Json
    const result: Json = { job: id, device: job.device, tool: job.tool, notes: [], ...rest, time: now() }
    result.text = resultText(job.device, job.tool, result)
    job.state = 'ended'
    job.result = result
    this.changed(job.device)
    const failed = result.status !== 'done'
    this.publish({
      device: job.device,
      type: 'job',
      level: failed ? 'warning' : 'info',
      text: result.text as string,
      data: {
        job: id,
        tool: job.tool,
        caller: job.caller,
        state: 'ended',
        status: result.status,
        reason: result.reason,
        ...(job.ref === undefined ? {} : { ref: job.ref }),
      },
    })
    if (result.reason === 'estop')
      this.publish({
        device: job.device,
        type: 'estop',
        level: 'critical',
        text: `${job.device} stopped itself: ${String(result.detail ?? 'safety stop')}.`,
        data: { job: id, detail: result.detail },
      })
    job.sink.result?.(result)
    setTimeout(() => {
      this.jobs.delete(id)
      this.byCall.delete(`${job.device}/${job.call}`)
    }, JOB_KEPT_MS).unref?.()
  }

  /** For each declared resource, the job holding it, or null. */
  private busy(info: DeviceInfo): Record<string, Json | null> {
    const busy: Record<string, Json | null> = {}
    for (const name of Object.keys(info.description.resources ?? {})) busy[name] = null
    for (const job of this.jobs.values())
      if (job.device === info.id && job.state !== 'ended')
        for (const name of job.uses) busy[name] = { job: job.job, tool: job.tool, caller: job.caller }
    return busy
  }

  private entry(info: DeviceInfo, online: boolean): DeviceEntry {
    const { protocol: _, device, ...rest } = info.description
    const available = online && info.available
    const t = now()
    const entry: DeviceEntry = {
      ...device,
      ...rest,
      online,
      available,
      since: info.since,
      sources: info.description.sources ?? [],
      state: this.entryState(info),
      busy: this.busy(info),
      jobs: [...this.jobs.values()]
        .filter((job) => job.device === info.id && job.state !== 'ended')
        .map(({ call: _, sink: __, uses: ___, result: ____, ...rest }) => rest),
      off: (info.description.sources ?? [])
        .map((s) => s.id)
        .filter((id) => this.offByHand.has(`${info.id}/${id}`)),
      health: this.observer.health(info, available, this.wanted(info.id), t),
    }
    const where = this.observer.position(info, available, t)
    if (where?.map !== undefined && where.x !== undefined && where.y !== undefined) {
      const zone = zoneAt(this.maps.get(where.map), where.x, where.y)
      if (zone) where.zone = zone.id
    }
    if (where) entry.position = where
    return entry
  }

  /** Sources someone uses through a subscription or a watch, with the rate asked for. */
  private wanted(device: string): Map<string, Wanted> {
    const out = new Map<string, Wanted>()
    const declared = (id: string) =>
      (this.known.get(device)?.description.sources?.find((s) => s.id === id) as { hz?: number } | undefined)
        ?.hz
    const want = (source: string, rate: number, since: number) => {
      const had = out.get(source)
      out.set(source, {
        wanted: Math.max(rate, had?.wanted ?? 0),
        since: Math.min(since, had?.since ?? since),
      })
    }
    for (const client of this.clients)
      for (const sub of client.subs.values())
        if (sub.device === device)
          for (const source of sub.sources) {
            const rate = sub.gap > 0 ? 1000 / sub.gap : (declared(source) ?? 1)
            want(source, Math.min(rate, declared(source) ?? rate), sub.since)
          }
    for (const w of this.watches.values())
      if (w.device === device && typeof w.until.source === 'string')
        want(w.until.source, Math.min(declared(w.until.source) ?? 1, 1), w.since)
    return out
  }

  private entryState(info: DeviceInfo): EntryState {
    const fields = (info.description.state ?? {}) as Record<string, Field>
    const state = this.south.state(info.id)
    if (!state) return { fields, values: {}, updated: null, alerts: {} }
    const times = Object.values(state.updated)
    const alerts: Record<string, 'warn' | 'bad'> = {}
    for (const [name, level] of Object.entries(state.levels)) if (level !== 'ok') alerts[name] = level
    return {
      fields,
      values: { ...state.values },
      updated: times.length > 0 ? Math.max(...times) : null,
      alerts,
    }
  }

  private async readSource(entry: DeviceEntry, id: string, params: ReadParams): Promise<Item> {
    const source = entry.sources.find((s) => s.id === id)
    if (!source)
      return { source: id, kind: '?', error: 'no such source', text: `${entry.id} has no source ${id}.` }
    const fail = (error: string): Item => ({ source: id, kind: source.kind, error, text: `${id}: ${error}.` })
    if (source.kind === 'video')
      return fail('video is for watching; read an image source of the same camera to see a picture')
    let latest = this.south.latest(entry.id, id)
    const key = `${entry.id}/${id}`
    if (this.offByHand.has(key)) return fail('switched off by hand')
    // Reading keeps the source on for a while; a source that was off gets up to 2 s to deliver.
    const fresh =
      latest !== undefined &&
      now() - this.timeOf(entry.id, latest) < Math.max(2, 2 / ((source as { hz?: number }).hz ?? 1))
    const wasOn = this.readDemand.has(key) || this.demand(entry.id).has(id)
    this.readDemand.set(key, now() + READ_DEMAND_S)
    if (!wasOn) this.scheduleDemand(entry.id)
    if (!fresh && params.since === undefined && entry.available) {
      await this.waitForData(entry.id, id, latest ? this.timeOf(entry.id, latest) : 0)
      latest = this.south.latest(entry.id, id)
    }
    if (params.since !== undefined) {
      const since = params.since
      if (!latest || this.timeOf(entry.id, latest) <= since) {
        await this.waitForData(entry.id, id, since)
        latest = this.south.latest(entry.id, id)
        if (!latest || this.timeOf(entry.id, latest) <= since) return fail('nothing newer arrived within 2 s')
      }
    }
    if (!latest) return fail('no data yet')
    const item = this.item(entry.id, source, latest, false)
    if (params.history && source.kind === 'values')
      item.history = [...(this.histories.get(`${entry.id}/${id}`) ?? [])]
    return item
  }

  private timeOf(device: string, latest: Latest): number {
    return this.south.hubTime(device, latest.msg.t)
  }

  private waitForData(device: string, source: string, since: number): Promise<void> {
    return new Promise((resolve) => {
      const waiter = {
        device,
        source,
        since,
        wake: () => {
          clearTimeout(timer)
          this.waiters.delete(waiter)
          resolve()
        },
      }
      const timer = setTimeout(waiter.wake, SINCE_WAIT_MS)
      this.waiters.add(waiter)
    })
  }

  /** An item as clients see it: hub time, age, binary as base64 unless it travels as its own frame. */
  private item(device: string, source: Source, latest: Latest, binaryFrame: boolean): Item {
    const { msg, binary } = latest
    const time = this.timeOf(device, latest)
    const item: Item = {
      source: source.id,
      kind: source.kind,
      seq: msg.seq,
      time,
      age: round(Math.max(0, now() - time), 2),
      data: msg.data,
      text: '',
    }
    if (binary) {
      const mime = (source as { mime?: string }).mime ?? sniff(binary)
      if (mime) item.mime = mime
      if (binaryFrame) item.bin = true
      else item.b64 = binary.toString('base64')
    }
    item.text = itemText(device, source, item)
    return item
  }

  private onData(device: string, msg: NerveData, binary?: Buffer): void {
    const source = this.known.get(device)?.description.sources?.find((s) => s.id === msg.source)
    if (!source) return
    const time = this.south.hubTime(device, msg.t)
    for (const alert of this.observer.onData(device, source, msg, time)) this.alertEvent(device, alert)
    this.checkWatches(device, { source: msg.source, kind: source.kind, data: msg.data })
    if (source.kind === 'values') {
      const key = `${device}/${msg.source}`
      const history = this.histories.get(key) ?? []
      if (time - (history.at(-1)?.time ?? 0) >= 1) history.push({ time, data: msg.data })
      while (history.length > 0 && (history[0]?.time ?? 0) < time - HISTORY_S) history.shift()
      this.histories.set(key, history)
    }
    for (const w of this.waiters)
      if (w.device === device && w.source === msg.source && time > w.since) w.wake()
    const latest: Latest = binary === undefined ? { msg } : { msg, binary }
    for (const client of this.clients)
      for (const [id, sub] of client.subs) {
        if (sub.device !== device || !sub.sources.has(msg.source)) continue
        if (sub.awaitingKey.has(msg.source)) {
          if (!(msg.data as { key?: boolean }).key) continue
          sub.awaitingKey.delete(msg.source)
        }
        const at = Date.now()
        if (sub.gap > 0 && at - (sub.sent.get(msg.source) ?? 0) < sub.gap) continue
        // Newest only: while the client lags, items are dropped instead of queued.
        if (client.ws.bufferedAmount > LAG_BYTES) continue
        sub.sent.set(msg.source, at)
        const frame = sub.binary && binary !== undefined
        send(client.ws, {
          jsonrpc: '2.0',
          method: 'hub/data',
          params: { sub: id, device, item: this.item(device, source, latest, frame) },
        })
        if (frame) client.ws.send(binary)
      }
  }

  /** hub/manual (section 10): clamped to the declared axes and forwarded on Nerve. */
  manual(caller: Caller, device: string, axes: Json): void {
    const entry = this.device(device)
    const manual = entry.manual as { axes: { id: string; min: number; max: number }[] } | undefined
    if (!manual) throw new HubError(-32602, `${entry.id} has no manual control`)
    const clamped: Record<string, number> = {}
    for (const axis of manual.axes) {
      const v = axes[axis.id]
      clamped[axis.id] = Math.max(
        axis.min,
        Math.min(axis.max, typeof v === 'number' && Number.isFinite(v) ? v : 0),
      )
    }
    this.count(entry.id, 'nerve_down')
    this.south.manual(entry.id, clamped)
    if (Object.values(clamped).every((v) => v === 0)) return
    const t = now()
    const last = this.lastManual.get(entry.id) ?? 0
    this.lastManual.set(entry.id, t)
    if (t - last > MANUAL_QUIET_S)
      this.publish({
        device: entry.id,
        type: 'manual',
        level: 'warning',
        text: `${entry.id} taken over by hand (${caller.name}).`,
        data: { by: caller.name },
      })
  }

  /** hub/configure (section 10): switchable sources on or off by hand. Rates follow demand. */
  async configure(device: string, sources: Json): Promise<{ sources: Json }> {
    const entry = this.device(device)
    const applied: Json = {}
    for (const [id, setting] of Object.entries(sources)) {
      const source = entry.sources.find((s) => s.id === id)
      if (!source) throw new HubError(HUB_ERROR.unknown, `${entry.id} has no source ${id}`)
      if (!(source as { switchable?: boolean }).switchable)
        throw new HubError(-32602, `${id} is not switchable`)
      const on = isObject(setting) ? setting.on : undefined
      if (typeof on !== 'boolean') throw new HubError(-32602, `${id}: on must be true or false`)
      if (on) this.offByHand.delete(`${entry.id}/${id}`)
      else this.offByHand.add(`${entry.id}/${id}`)
      applied[id] = { on }
    }
    await this.applyDemand(entry.id)
    this.changed(entry.id)
    return { sources: applied }
  }

  /** Each source's rate from demand (section 14); sources missing from the map have none. */
  private demand(device: string): Map<string, number> {
    const info = this.known.get(device)
    const out = new Map<string, number>()
    const want = (id: string, rate: number) => out.set(id, Math.max(rate, out.get(id) ?? 0))
    const declared = (id: string) =>
      (info?.description.sources?.find((s) => s.id === id) as { hz?: number } | undefined)?.hz
    for (const client of this.clients)
      for (const sub of client.subs.values())
        if (sub.device === device)
          for (const id of sub.sources) want(id, sub.gap > 0 ? 1000 / sub.gap : (declared(id) ?? 1))
    for (const w of this.watches.values())
      if (w.device === device && typeof w.until.source === 'string')
        want(w.until.source, declared(w.until.source) ?? 1)
    for (const [key, until] of this.readDemand)
      if (until > now() && key.startsWith(`${device}/`)) {
        const id = key.slice(device.length + 1)
        want(id, declared(id) ?? 1)
      }
    for (const source of info?.description.sources ?? [])
      if (source.kind === 'pose') want(source.id, Math.min(POSE_HZ, declared(source.id) ?? POSE_HZ))
    for (const [id, rate] of out) {
      const cap = declared(id)
      if (cap !== undefined && rate > cap) out.set(id, cap)
      if (this.offByHand.has(`${device}/${id}`)) out.delete(id)
    }
    return out
  }

  /** Applies demand on the next tick, so several changes become one mhs/configure. */
  private scheduleDemand(device: string): void {
    if (this.pendingDemand.has(device)) return
    this.pendingDemand.add(device)
    setImmediate(() => {
      this.pendingDemand.delete(device)
      void this.applyDemand(device)
    })
  }

  /** Sends mhs/configure for the sources whose setting changed (MOS 8). */
  private async applyDemand(device: string): Promise<void> {
    const info = this.south.devices().find((d) => d.id === device)
    if (!info?.available) return
    const demand = this.demand(device)
    const settings: Record<string, { on: boolean; hz?: number }> = {}
    for (const source of info.description.sources ?? []) {
      const rate = demand.get(source.id)
      const setting = rate === undefined ? { on: false } : { on: true, hz: Math.round(rate * 100) / 100 }
      const key = `${device}/${source.id}`
      const json = JSON.stringify(setting)
      if (this.applied.get(key) === json) continue
      this.applied.set(key, json)
      settings[source.id] = setting
    }
    if (Object.keys(settings).length === 0) return
    try {
      await this.south.configure(device, settings)
    } catch (e) {
      for (const id of Object.keys(settings)) this.applied.delete(`${device}/${id}`)
      this.log(`${device}: configure failed: ${(e as Error).message}`)
    }
  }

  /** hub/subscribe for events (section 11): `since` delivers the missed events of the last 10 minutes. */
  subscribeEvents(
    client: Client,
    types: string[] | undefined,
    device: string | undefined,
    since: string | undefined,
  ): string {
    this.subs += 1
    const id = `s${this.subs}`
    const sub: EventSubscription = { types: types ? new Set(types) : undefined, device }
    client.events.set(id, sub)
    const from = since === undefined ? this.events.length : this.events.findIndex((e) => e.id === since) + 1
    for (const event of this.events.slice(Math.max(from, 0)))
      if (matches(sub, event))
        send(client.ws, { jsonrpc: '2.0', method: 'hub/event', params: { sub: id, event } })
    return id
  }

  /** hub/watch (section 12). `deliver` gets the watch event, once. */
  watch(caller: Caller, params: WatchParams, deliver: (event: HubEvent) => void): string {
    const entry = this.device(params.device)
    const problem = untilProblem(entry, params.until)
    if (problem) throw new HubError(-32602, problem)
    if ([...this.watches.values()].filter((w) => w.caller === caller.name).length >= WATCHES_PER_CALLER)
      throw new HubError(HUB_ERROR.notAllowed, `at most ${WATCHES_PER_CALLER} watches per caller`)
    const timeout = Math.min(Math.max(params.timeout ?? WATCH_TIMEOUT_S.default, 1), WATCH_TIMEOUT_S.max)
    this.watchCount += 1
    const id = `w${this.watchCount}`
    const watch: Watch = {
      id,
      caller: caller.name,
      device: entry.id,
      until: params.until,
      note: params.note,
      timeout,
      since: now(),
      deliver,
      timer: setTimeout(() => this.fire(watch, false, undefined), timeout * 1000),
    }
    watch.timer.unref?.()
    this.watches.set(id, watch)
    this.scheduleDemand(entry.id)
    return id
  }

  unwatch(id: string): boolean {
    const watch = this.watches.get(id)
    if (!watch) return false
    clearTimeout(watch.timer)
    this.watches.delete(id)
    this.scheduleDemand(watch.device)
    return true
  }

  private fire(watch: Watch, matched: boolean, item: unknown): void {
    if (!this.unwatch(watch.id)) return
    const what = describeUntil(watch.until)
    const note = watch.note ? ` (${watch.note})` : ''
    const text = matched
      ? `${watch.device}: ${what}${note}.`
      : `${watch.device}: waited ${watch.timeout} s and ${what} did not happen${note}.`
    this.eventCount += 1
    watch.deliver({
      id: `e${this.eventCount}`,
      time: now(),
      device: watch.device,
      type: 'watch',
      level: 'info',
      text,
      data: { watch: watch.id, matched, ...(item === undefined ? {} : { item }) },
    })
  }

  /** Compares new state, data, health or position with every watch on the device. */
  private checkWatches(
    device: string,
    change: {
      state?: string
      value?: unknown
      item?: unknown
      source?: string
      kind?: string
      data?: unknown
      health?: HealthLevel
      trust?: Trust
    },
  ): void {
    for (const w of [...this.watches.values()]) {
      if (w.device !== device) continue
      const u = w.until
      if (typeof u.state === 'string' && change.state === u.state && compare(change.value, u))
        this.fire(w, true, change.item)
      else if (
        typeof u.source === 'string' &&
        change.source === u.source &&
        dataMatches(u, change.kind, change.data)
      )
        this.fire(w, true, change.data)
      else if (typeof u.health === 'string' && change.health === u.health)
        this.fire(w, true, { health: change.health })
      else if (typeof u.trust === 'string' && change.trust === u.trust)
        this.fire(w, true, { trust: change.trust })
    }
  }

  /** Appends an event, prunes old ones, and sends it to matching subscriptions and in-process listeners. */
  private publish(e: Omit<HubEvent, 'id' | 'time'>): void {
    this.eventCount += 1
    const event: HubEvent = { id: `e${this.eventCount}`, time: now(), ...e }
    this.events.push(event)
    while ((this.events[0]?.time ?? event.time) < event.time - EVENTS_KEPT_S) this.events.shift()
    for (const client of this.clients)
      for (const [id, sub] of client.events)
        if (matches(sub, event))
          send(client.ws, { jsonrpc: '2.0', method: 'hub/event', params: { sub: id, event } })
    this.emit('event', event)
  }

  private alertEvent(device: string, a: ValueAlert): void {
    const { role, of } = a.field as Field & { role?: string; of?: string }
    const label = fieldLabel(a.name, a.field)
    const unit = a.field.unit ? ` ${a.field.unit}` : ''
    const value = typeof a.value === 'number' ? round(a.value, 2) : String(a.value)
    const threshold = a.level === 'bad' ? a.field.alert?.bad : a.field.alert?.warn
    this.publish({
      device,
      type: 'alert',
      level: a.level === 'bad' ? 'critical' : a.level === 'warn' ? 'warning' : 'info',
      text:
        a.level === 'ok'
          ? `${device}: ${label} ${value}${unit}, back to normal.`
          : `${device}: ${label} ${value}${unit}, past ${a.level}${threshold === undefined ? '' : ` ${threshold}${unit}`}.`,
      data: {
        ...(a.source ? { source: a.source } : {}),
        field: a.name,
        ...(role ? { role } : {}),
        ...(of ? { of } : {}),
        value: a.value,
        alert: a.level,
      },
    })
  }

  /** Once a second: health and position changes become events and may match watches. */
  private review(): void {
    this.sendTraffic()
    const t = now()
    for (const [key, until] of this.readDemand)
      if (until <= t) {
        this.readDemand.delete(key)
        this.scheduleDemand(key.slice(0, key.indexOf('/')))
      }
    for (const entry of this.devices()) {
      // Pages learn health and position from hub/changed; send it when either moved on.
      const p = entry.position
      const look = JSON.stringify([
        entry.health,
        p?.trust,
        p?.reason,
        p?.x === undefined ? null : Math.round(p.x * 5),
        p?.y === undefined ? null : Math.round(p.y * 5),
        p?.yaw === undefined ? null : Math.round(p.yaw / 5),
      ])
      if (this.lastLook.get(entry.id) !== look) {
        this.lastLook.set(entry.id, look)
        this.broadcast('hub/changed', { devices: [entry], removed: [] })
      }
      const level = entry.health.level
      const before = this.lastHealth.get(entry.id)
      this.lastHealth.set(entry.id, level)
      if (before !== undefined && before !== level) {
        this.publish({
          device: entry.id,
          type: 'health',
          level: level === 'bad' ? 'critical' : level === 'attention' ? 'warning' : 'info',
          text:
            level === 'ok'
              ? `${entry.id} is healthy again.`
              : `${entry.id}: ${summaryText(entry.health, undefined)}`,
          data: { level, reasons: entry.health.reasons },
        })
        this.checkWatches(entry.id, { health: level })
      }
      const trust = entry.position?.trust
      if (trust === undefined) continue
      const was = this.lastTrust.get(entry.id)
      this.lastTrust.set(entry.id, trust)
      if (was !== undefined && was !== trust) {
        this.publish({
          device: entry.id,
          type: 'position',
          level: trust === 'lost' ? 'critical' : trust === 'uncertain' ? 'warning' : 'info',
          text: `${entry.id}: ${summaryText({ level: 'ok', reasons: [] }, entry.position, this.maps.zoneName(entry.position))}`,
          data: { trust, ...(entry.position?.reason ? { reason: entry.position.reason } : {}) },
        })
        this.checkWatches(entry.id, { trust })
      }
    }
  }

  /** Counts one message for `hub/traffic`. */
  private count(device: string, lane: keyof Traffic, n = 1): void {
    let t = this.traffic.get(device)
    if (!t) {
      t = { mhs_up: 0, mhs_down: 0, nerve_up: 0, nerve_down: 0, bytes_up: 0 }
      this.traffic.set(device, t)
    }
    t[lane] += n
  }

  /** hub/traffic (section 4.3): last second's messages per device, to every client, when there were any. */
  private sendTraffic(): void {
    if (this.traffic.size === 0) return
    const devices = Object.fromEntries(this.traffic)
    this.traffic.clear()
    this.broadcast('hub/traffic', { time: now(), devices })
  }

  private changed(id: string): void {
    const entry = this.devices().find((d) => d.id === id)
    if (entry) this.broadcast('hub/changed', { devices: [entry], removed: [] })
  }

  private broadcast(method: string, params: Json): void {
    for (const client of this.clients) if (client.caller) send(client.ws, { jsonrpc: '2.0', method, params })
  }

  private accept(ws: WebSocket): void {
    const client: Client = {
      ws,
      caller: undefined,
      subs: new Map(),
      events: new Map(),
      watches: new Set(),
      steering: new Set(),
    }
    this.clients.add(client)
    ws.on('message', (data, isBinary) => {
      if (!isBinary) void this.onMessage(client, data)
    })
    ws.on('close', () => {
      this.clients.delete(client)
      for (const id of client.watches) this.unwatch(id)
      // Manual control stops with the connection that steered (section 10).
      for (const device of client.steering) {
        const axes = (this.known.get(device)?.description.manual?.axes ?? []).map((a) => [a.id, 0])
        this.south.manual(device, Object.fromEntries(axes))
      }
      for (const sub of client.subs.values()) this.scheduleDemand(sub.device)
      if (client.caller) this.log(`${client.caller.name} left`)
    })
  }

  private async onMessage(client: Client, data: RawData): Promise<void> {
    let msg: unknown
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return send(client.ws, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'not JSON' } })
    }
    if (!isObject(msg) || typeof msg.method !== 'string')
      return send(client.ws, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a request' } })
    const id = msg.id
    if (msg.method === 'hub/manual' && id === undefined) {
      // A notification: no reply, errors are only logged.
      try {
        if (!client.caller) throw new HubError(-32600, 'the first message must be hub/hello')
        const p = isObject(msg.params) ? msg.params : {}
        if (typeof p.device !== 'string') throw new HubError(-32602, 'device is required')
        this.manual(client.caller, p.device, isObject(p.axes) ? p.axes : {})
        client.steering.add(p.device)
      } catch (e) {
        this.log(`hub/manual: ${(e as Error).message}`)
      }
      return
    }
    try {
      const result = await this.dispatch(client, msg.method, msg.params ?? {})
      if (id !== undefined) send(client.ws, { jsonrpc: '2.0', id, result })
    } catch (e) {
      const code = e instanceof HubError ? e.code : -32603
      if (id !== undefined)
        send(client.ws, { jsonrpc: '2.0', id, error: { code, message: (e as Error).message } })
      if (!(e instanceof HubError)) this.log(`${msg.method} failed: ${(e as Error).message}`)
    }
  }

  private async dispatch(client: Client, method: string, params: unknown): Promise<unknown> {
    if (method === 'hub/hello') {
      client.caller = this.hello(params)
      this.sessions += 1
      this.log(`${client.caller.name} connected`)
      return {
        session: `h${this.sessions}`,
        caller: client.caller,
        hub: { name: this.options.name ?? 'agnes-hub', version: this.options.version ?? '0.0.0' },
        time: now(),
      }
    }
    if (!client.caller) throw new HubError(-32600, 'the first message must be hub/hello')
    if (!isObject(params)) throw new HubError(-32602, 'params must be an object')
    switch (method) {
      case 'hub/devices':
        return { devices: this.devices() }
      case 'hub/world':
        return { worlds: this.worlds() }
      case 'hub/read':
        return this.read(readParams(params))
      case 'hub/subscribe': {
        if (params.events !== undefined) {
          if (params.events !== true && !isStrings(params.events))
            throw new HubError(-32602, 'events must be a list of event types, or true for all')
          const device = typeof params.device === 'string' ? this.device(params.device).id : undefined
          const since = typeof params.since === 'string' ? params.since : undefined
          return {
            sub: this.subscribeEvents(
              client,
              params.events === true ? undefined : params.events,
              device,
              since,
            ),
          }
        }
        const { device, sources } = params
        if (typeof device !== 'string' || !isStrings(sources))
          throw new HubError(-32602, 'device and sources are required')
        const hz = typeof params.hz === 'number' ? params.hz : undefined
        const sub = this.subscribe(client, {
          device,
          sources,
          binary: params.binary === true,
          ...(hz === undefined ? {} : { hz }),
        })
        return { sub }
      }
      case 'hub/unsubscribe': {
        const data = typeof params.sub === 'string' ? client.subs.get(params.sub) : undefined
        if (
          typeof params.sub !== 'string' ||
          !(client.subs.delete(params.sub) || client.events.delete(params.sub))
        )
          throw new HubError(HUB_ERROR.unknown, `no subscription ${String(params.sub)}`)
        if (data) this.scheduleDemand(data.device)
        return {}
      }
      case 'hub/call': {
        if (typeof params.device !== 'string' || typeof params.tool !== 'string')
          throw new HubError(-32602, 'device and tool are required')
        if (params.arguments !== undefined && !isObject(params.arguments))
          throw new HubError(-32602, 'arguments must be an object')
        const notify = (method: string) => (p: Json) => send(client.ws, { jsonrpc: '2.0', method, params: p })
        return this.call(
          client.caller,
          {
            device: params.device,
            tool: params.tool,
            ...(params.arguments ? { arguments: params.arguments } : {}),
            ...(typeof params.ref === 'string' ? { ref: params.ref } : {}),
          },
          { progress: notify('hub/progress'), result: notify('hub/result') },
        )
      }
      case 'hub/job':
        return this.job(jobParam(params))
      case 'hub/cancel':
        return this.cancel(jobParam(params))
      case 'hub/pause':
        return this.pause(jobParam(params))
      case 'hub/resume':
        return this.resume(jobParam(params))
      case 'hub/stop':
        if (params.device !== undefined && typeof params.device !== 'string')
          throw new HubError(-32602, 'device must be a device id')
        return this.stop(params.device as string | undefined)
      case 'hub/watch': {
        if (typeof params.device !== 'string' || !isObject(params.until))
          throw new HubError(-32602, 'device and until are required')
        const watch = this.watch(
          client.caller,
          {
            device: params.device,
            until: params.until,
            ...(typeof params.timeout === 'number' ? { timeout: params.timeout } : {}),
            ...(typeof params.note === 'string' ? { note: params.note } : {}),
          },
          (event) => send(client.ws, { jsonrpc: '2.0', method: 'hub/event', params: { event } }),
        )
        client.watches.add(watch)
        return { watch }
      }
      case 'hub/unwatch':
        if (typeof params.watch !== 'string' || !this.unwatch(params.watch))
          throw new HubError(HUB_ERROR.unknown, `no watch ${String(params.watch)}`)
        client.watches.delete(params.watch)
        return {}
      case 'hub/configure':
        if (typeof params.device !== 'string' || !isObject(params.sources))
          throw new HubError(-32602, 'device and sources are required')
        return this.configure(params.device, params.sources)
      case 'hub/set':
        if (typeof params.device !== 'string' || !isObject(params.values))
          throw new HubError(-32602, 'device and values are required')
        return this.set(params.device, params.values)
      default:
        throw new HubError(-32601, `unknown method ${method}`)
    }
  }
}

function matches(sub: EventSubscription, event: HubEvent): boolean {
  return (!sub.types || sub.types.has(event.type)) && (!sub.device || sub.device === event.device)
}

const OPS = ['lt', 'lte', 'gt', 'gte', 'eq', 'ne'] as const

/** True when every comparison in `until` holds for `value`; false without any comparison. */
function compare(value: unknown, until: Json): boolean {
  const ops = OPS.filter((op) => op in until)
  if (ops.length === 0) return false
  return ops.every((op) => {
    const ref = until[op]
    if (op === 'eq') return value === ref
    if (op === 'ne') return value !== ref
    if (typeof value !== 'number' || typeof ref !== 'number') return false
    return op === 'lt' ? value < ref : op === 'lte' ? value <= ref : op === 'gt' ? value > ref : value >= ref
  })
}

function dataMatches(until: Json, kind: string | undefined, data: unknown): boolean {
  const d = (data ?? {}) as Json
  if (typeof until.field === 'string') return until.field in d && compare(d[until.field], until)
  if (typeof until.has === 'string' && kind === 'detections') {
    const min = typeof until.min_conf === 'number' ? until.min_conf : 0.5
    return ((d.items as { label: string; conf: number }[]) ?? []).some(
      (i) => i.label === until.has && i.conf >= min,
    )
  }
  if (typeof until.says === 'string' && kind === 'transcript')
    return (
      d.final === true &&
      String(d.text ?? '')
        .toLowerCase()
        .includes(until.says.toLowerCase())
    )
  return false
}

/** Why `until` cannot be watched on this device, or undefined. */
function untilProblem(entry: DeviceEntry, until: Json): string | undefined {
  const ops = OPS.filter((op) => op in until)
  if (typeof until.state === 'string') {
    const known = until.state in entry.state.fields || until.state === 'problem' || until.state === 'faults'
    if (!known) {
      // Often the name is a field of a data source; say which, so the next try is right.
      const owner = entry.sources.find((s) =>
        Object.hasOwn((s as { fields?: Record<string, unknown> }).fields ?? {}, String(until.state)),
      )
      return owner
        ? `${entry.id} has no state field ${until.state}; it is a field of source ${owner.id}: use {"source": "${owner.id}", "field": "${until.state}", ...}`
        : `${entry.id} has no state field ${until.state}`
    }
    return ops.length > 0 ? undefined : 'a state watch needs lt, lte, gt, gte, eq or ne'
  }
  if (typeof until.source === 'string') {
    const source = entry.sources.find((s) => s.id === until.source)
    if (!source) return `${entry.id} has no source ${until.source}`
    if (typeof until.field === 'string')
      return (source.kind === 'values' || source.kind === 'switch') && ops.length > 0
        ? undefined
        : 'a field watch needs a values or switch source and a comparison'
    if (typeof until.has === 'string')
      return source.kind === 'detections' ? undefined : `${until.source} is not a detections source`
    if (typeof until.says === 'string')
      return source.kind === 'transcript' ? undefined : `${until.source} is not a transcript source`
    return 'a source watch needs field, has or says'
  }
  if (until.health === 'ok' || until.health === 'attention' || until.health === 'bad') return undefined
  if (until.trust === 'trusted' || until.trust === 'uncertain' || until.trust === 'lost')
    return entry.position ? undefined : `${entry.id} has no position`
  return 'until needs state, source, health or trust'
}

/** "battery < 20", "objects saw person", "health became bad". */
function describeUntil(until: Json): string {
  const signs: Record<string, string> = { lt: '<', lte: '≤', gt: '>', gte: '≥', eq: '=', ne: '≠' }
  const cmp = OPS.filter((op) => op in until)
    .map((op) => `${signs[op]} ${String(until[op])}`)
    .join(' and ')
  if (typeof until.state === 'string') return `${until.state} ${cmp}`
  if (typeof until.field === 'string') return `${String(until.source)} ${until.field} ${cmp}`
  if (typeof until.has === 'string') return `${String(until.source)} saw ${until.has}`
  if (typeof until.says === 'string') return `${String(until.source)} heard "${until.says}"`
  if (typeof until.health === 'string') return `health became ${until.health}`
  return `position became ${String(until.trust)}`
}

function jobParam(params: Json): string {
  if (typeof params.job !== 'string') throw new HubError(-32602, 'job is required')
  return params.job
}

/** "robot-01 docked. Now at (1.5, 3.5) facing 320 degrees." */
/** A result's data goes into its text up to this many characters. */
const RESULT_DATA_CHARS = 2000

export function resultText(device: string, tool: string, result: Json): string {
  const detail = (typeof result.detail === 'string' ? result.detail : `${tool} ${result.status}`).replace(
    /[.!?]+$/,
    '',
  )
  // A detail that already says how the job ended is not repeated after it.
  const plain = result.status === 'done' || detail.startsWith(`${tool} ${result.status}`)
  const parts = [
    plain
      ? `${device}: ${detail}.`
      : `${device}: ${tool} ${result.status} (${String(result.reason)}): ${detail}.`,
  ]
  const notes = result.notes as string[] | undefined
  if (notes?.length) parts.push(`Notes: ${notes.join('; ')}.`)
  // What the tool found or planned (a route, a list of objects) is often what the next step needs.
  const data = result.data as Json | undefined
  if (data && Object.keys(data).length > 0) {
    const text = JSON.stringify(data)
    parts.push(`Data: ${text.length > RESULT_DATA_CHARS ? `${text.slice(0, RESULT_DATA_CHARS)}…` : text}`)
  }
  const pose = (result.after as { pose?: { x: number; y: number; yaw: number; ok: boolean } } | undefined)
    ?.pose
  if (pose)
    parts.push(
      `Now at (${round(pose.x, 2)}, ${round(pose.y, 2)}) facing ${Math.round(pose.yaw)} degrees${pose.ok ? '' : ', position not trusted'}.`,
    )
  return parts.join(' ')
}

function rejectionText(device: string, tool: string, rejected: Json): string {
  if (rejected.reason === 'busy')
    return `${device} is busy: ${String(rejected.detail ?? 'a resource is held')}. Try later, or stop or cancel that first.`
  return `${device} rejected ${tool} (${String(rejected.reason)}): ${String(rejected.detail ?? '')}.`
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

function readParams(params: Json): ReadParams {
  if (typeof params.device !== 'string') throw new HubError(-32602, 'device is required')
  const read: ReadParams = { device: params.device }
  if (params.sources !== undefined) {
    if (!isStrings(params.sources)) throw new HubError(-32602, 'sources must be a list of source ids')
    read.sources = params.sources
  }
  if (params.kinds !== undefined) {
    if (!isStrings(params.kinds)) throw new HubError(-32602, 'kinds must be a list of kinds')
    read.kinds = params.kinds
  }
  if (typeof params.since === 'number') read.since = params.since
  if (params.history === true) read.history = true
  return read
}

function send(ws: WebSocket, message: Json): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
}

function sniff(binary: Buffer): string | undefined {
  if (binary[0] === 0xff && binary[1] === 0xd8) return 'image/jpeg'
  if (binary[0] === 0x89 && binary[1] === 0x50) return 'image/png'
  return undefined
}

function show(value: unknown, field: Field | undefined): string {
  const text =
    typeof value === 'number'
      ? String(round(value, 2))
      : Array.isArray(value)
        ? value.join(', ')
        : String(value)
  return field?.unit ? `${text} ${field.unit}` : text
}

/** "mode driving, battery 64 % (warn)" from values and their declarations. */
function valuesText(
  values: Record<string, unknown>,
  fields: Record<string, Field>,
  alerts: Record<string, string> = {},
): string {
  return Object.entries(values)
    .filter(([name, value]) => name !== 'problem' && name !== 'faults' && value !== null)
    .map(([name, value]) => `${name} ${show(value, fields[name])}${alerts[name] ? ` (${alerts[name]})` : ''}`)
    .join(', ')
}

/**
 * One or two sentences about a device for a model: availability, problem, faults and state, with
 * the name of the zone it is in when its map gives one.
 */
export function deviceText(entry: DeviceEntry, zoneName?: string): string {
  const where = entry.available ? 'available' : entry.online ? 'connected but not available' : 'offline'
  const { fields, values } = entry.state
  const parts = [`${entry.id} is ${where}.`]
  const summary = summaryText(entry.health, entry.position, zoneName)
  if (summary) parts.push(summary)
  const state = valuesText(values, fields)
  if (state) parts.push(`State: ${state}.`)
  return parts.join(' ')
}

/** One sentence about an item for a model. */
export function itemText(device: string, source: Source, item: Item): string {
  const age = item.age === undefined ? '' : `, ${item.age} s old`
  const data = item.data as Json
  switch (source.kind) {
    case 'image':
    case 'video':
      return `${device} ${source.id}: picture ${data.w}x${data.h}${age}.`
    case 'values':
    case 'switch':
      return `${device} ${source.id}: ${valuesText(data, (source as { fields?: Record<string, Field> }).fields ?? {})}${age}.`
    case 'detections': {
      const found = (data.items as { label: string; conf: number; dist?: number; bearing?: number }[]) ?? []
      if (found.length === 0) return `${device} ${source.id}: nothing detected${age}.`
      const list = found.slice(0, 5).map((d) => {
        const where = [
          d.dist === undefined ? '' : `${round(d.dist)} m`,
          d.bearing === undefined
            ? ''
            : `${Math.abs(Math.round(d.bearing))}° ${d.bearing >= 0 ? 'left' : 'right'}`,
        ].filter(Boolean)
        return `${d.label} ${round(d.conf, 2)}${where.length > 0 ? ` (${where.join(', ')})` : ''}`
      })
      return `${device} ${source.id}: ${list.join('; ')}${found.length > 5 ? ` and ${found.length - 5} more` : ''}${age}.`
    }
    case 'pose':
      return `${device} ${source.id}: at (${round(data.x as number, 2)}, ${round(data.y as number, 2)}) facing ${Math.round(data.yaw as number)}°, ${data.ok ? 'trusted' : 'not trusted'}${age}.`
    case 'transcript':
      return `${device} ${source.id}: "${data.text}"${age}.`
    case 'text':
      return `${device} ${source.id}: ${data.text}${age}.`
    default:
      return `${device} ${source.id}: ${source.kind} data${age}.`
  }
}
