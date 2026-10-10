/**
 * What the pages know about AgnesHub, kept in one place (mhs-ui-design section 6.2): devices with
 * their state, health and position; the newest item of each source someone watches; two minutes of
 * numbers; the jobs this page started; the latest events. Every key has its own listeners, so a new
 * camera frame wakes only the component that draws it.
 *
 * Subscriptions are reference-counted (section 6.3): the first component that wants a source
 * subscribes, the highest rate wins, and the last one to leave unsubscribes 2 s later.
 */
import { type Conn, HubClient } from './hub.js'
import type { Device, HubEvent, Item, JobResult, Json, World } from './types.js'

const EVENTS_KEPT = 200
const HISTORY_KEPT = 120
const RELEASE_MS = 2000

export interface Latest {
  item: Item
  /** The binary payload of image, video, audio and grid items. */
  binary?: ArrayBuffer
  /** When it arrived, in ms on this page's clock. */
  at: number
}

export interface MyJob {
  job?: string
  device: string
  tool: string
  args: Json
  state: 'starting' | 'running' | 'paused' | 'ended' | 'rejected' | 'failed'
  progress?: { done?: number; total?: number; text?: string; reason?: string; by?: string }
  result?: JobResult
  /** The rejection or the error text. */
  text?: string
}

export interface SetOutcome {
  values: Json
  notes: string[]
  refused: Record<string, string>
  text: string
}

type Sample = { time: number; value: number }

/** One device's messages in the last second (hub-api.md 4.3). */
export interface Traffic {
  mhs_up: number
  mhs_down: number
  nerve_up: number
  nerve_down: number
  bytes_up: number
}

/** Something the brain sent to or got from a device, for drawing it (host-reported). */
export interface BrainPulse {
  id: number
  device: string | undefined
  tool: string
  dir: 'down' | 'up'
  at: number
}

interface Sub {
  device: string
  source: string
  wants: Map<number, number>
  hz: number
  binary: boolean
  sub?: string | undefined
  timer?: ReturnType<typeof setTimeout>
}

export class Store {
  readonly hub: HubClient
  private devices = new Map<string, Device>()
  private deviceList: Device[] = []
  private readonly latest = new Map<string, Latest>()
  private readonly frames = new Map<string, Set<(latest: Latest) => void>>()
  private readonly history = new Map<string, Sample[]>()
  private events: HubEvent[] = []
  private readonly jobs = new Map<string, MyJob>()
  private jobCount = 0
  private readonly subs = new Map<string, Sub>()
  private readonly bySub = new Map<string, string>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private lastEvent: string | undefined
  private wantCount = 0
  private trafficNow: { at: number; devices: Record<string, Traffic> } = { at: 0, devices: {} }
  private pulses: BrainPulse[] = []
  private pulseCount = 0
  private worldList: World[] = []

  constructor(url: string) {
    this.hub = new HubClient(url)
    this.hub.onConn((conn) => this.onConn(conn))
    this.hub.on('hub/changed', (p) => {
      for (const d of (p.devices as Device[]) ?? []) this.putDevice(d)
      for (const id of (p.removed as string[]) ?? []) this.devices.delete(id)
      this.relist()
    })
    this.hub.on('hub/state', (p) => {
      const d = this.devices.get(String(p.device))
      if (!d) return
      const values = { ...d.state.values, ...(p.values as Json) }
      this.putDevice({ ...d, state: { ...d.state, values, updated: Number(p.time) || d.state.updated } })
      this.relist()
    })
    this.hub.on('hub/data', (p) => {
      const key = this.bySub.get(String(p.sub))
      if (!key) return
      this.putItem(key, p.item as Item, p.binary as ArrayBuffer | undefined)
    })
    this.hub.on('hub/event', (p) => this.putEvent(p.event as HubEvent))
    this.hub.on('hub/world', (p) => this.putWorlds(p.worlds as World[]))
    this.hub.on('hub/traffic', (p) => {
      this.trafficNow = { at: Date.now(), devices: (p.devices as Record<string, Traffic>) ?? {} }
      this.emit('traffic')
    })
    this.hub.on('hub/progress', (p) => {
      const local = [...this.jobs.entries()].find(([, j]) => j.job === p.job)
      if (!local) return
      const [id, job] = local
      const { job: _, state, ...rest } = p
      const next: MyJob = { ...job, progress: { ...job.progress, ...(rest as MyJob['progress']) } }
      if (state === 'paused' || state === 'running') next.state = state
      this.putJob(id, next)
    })
    this.hub.on('hub/result', (p) => {
      const local = [...this.jobs.entries()].find(([, j]) => j.job === p.job)
      if (local) this.putJob(local[0], { ...local[1], state: 'ended', result: p as unknown as JobResult })
    })
  }

  // --- listening ---

  subscribe(key: string, listener: () => void): () => void {
    const set = this.listeners.get(key) ?? new Set()
    set.add(listener)
    this.listeners.set(key, set)
    return () => set.delete(listener)
  }

  private emit(key: string): void {
    for (const listener of [...(this.listeners.get(key) ?? [])]) listener()
  }

  // --- reading ---

  get conn(): Conn {
    return this.hub.conn
  }

  list(): Device[] {
    return this.deviceList
  }

  device(id: string): Device | undefined {
    return this.devices.get(id)
  }

  item(device: string, source: string): Latest | undefined {
    return this.latest.get(`${device}/${source}`)
  }

  /** Every item of a source as it arrives (video needs all of them, not only the newest). */
  onItem(device: string, source: string, listener: (latest: Latest) => void): () => void {
    const key = `${device}/${source}`
    const set = this.frames.get(key) ?? new Set()
    set.add(listener)
    this.frames.set(key, set)
    return () => set.delete(listener)
  }

  samples(device: string, source: string, field: string): Sample[] {
    return this.history.get(`${device}/${source}/${field}`) ?? EMPTY
  }

  /** The maps AgnesHub knows, with their places (hub-api.md 4.4); positions come with the devices. */
  worlds(): World[] {
    return this.worldList
  }

  recentEvents(): HubEvent[] {
    return this.events
  }

  job(id: string): MyJob | undefined {
    return this.jobs.get(id)
  }

  traffic(): { at: number; devices: Record<string, Traffic> } {
    return this.trafficNow
  }

  brainPulses(): BrainPulse[] {
    return this.pulses
  }

  /** The host reports the brain's device tool calls and their results. */
  brain(device: string | undefined, tool: string, dir: 'down' | 'up'): void {
    this.pulseCount += 1
    const now = Date.now()
    this.pulses = [
      ...this.pulses.filter((p) => now - p.at < 10_000),
      { id: this.pulseCount, device, tool, dir, at: now },
    ]
    this.emit('brain')
  }

  // --- data on demand ---

  /** Wants a source at `hz`; returns the release. */
  want(device: string, source: string, hz: number, binary = true): () => void {
    const key = `${device}/${source}`
    let sub = this.subs.get(key)
    if (!sub) {
      sub = { device, source, wants: new Map(), hz: 0, binary }
      this.subs.set(key, sub)
    }
    clearTimeout(sub.timer)
    this.wantCount += 1
    const token = this.wantCount
    sub.wants.set(token, hz)
    this.resubscribe(sub)
    return () => {
      sub.wants.delete(token)
      if (sub.wants.size > 0) {
        this.resubscribe(sub)
        return
      }
      sub.timer = setTimeout(() => {
        if (sub.wants.size > 0) return
        this.subs.delete(key)
        this.unsubscribe(sub)
      }, RELEASE_MS)
    }
  }

  /** hub/read with history: fills the trend of a values source before its first live item. */
  async readHistory(device: string, source: string): Promise<void> {
    try {
      const result = await this.hub.request<{ items: Item[] }>('hub/read', {
        device,
        sources: [source],
        history: true,
      })
      for (const item of result.items)
        for (const h of item.history ?? []) this.record(`${device}/${source}`, h.data, h.time)
      this.emit(`h:${device}/${source}`)
    } catch {
      // The live items fill it in.
    }
  }

  private resubscribe(sub: Sub): void {
    const hz = Math.max(...sub.wants.values())
    if (sub.sub && hz === sub.hz) return
    sub.hz = hz
    if (this.hub.conn !== 'open') return
    const old = sub.sub
    sub.sub = undefined
    this.hub
      .request<{ sub: string }>('hub/subscribe', {
        device: sub.device,
        sources: [sub.source],
        hz,
        binary: sub.binary,
      })
      .then(
        (r) => {
          if (this.subs.get(`${sub.device}/${sub.source}`) !== sub) {
            this.hub.request('hub/unsubscribe', { sub: r.sub }).catch(() => undefined)
            return
          }
          sub.sub = r.sub
          this.bySub.set(r.sub, `${sub.device}/${sub.source}`)
        },
        () => undefined,
      )
    if (old) {
      this.bySub.delete(old)
      this.hub.request('hub/unsubscribe', { sub: old }).catch(() => undefined)
    }
  }

  private unsubscribe(sub: Sub): void {
    if (!sub.sub) return
    this.bySub.delete(sub.sub)
    this.hub.request('hub/unsubscribe', { sub: sub.sub }).catch(() => undefined)
    sub.sub = undefined
  }

  // --- acting ---

  /** hub/call; the returned id names this page's record of the job (store.job). */
  call(device: string, tool: string, args: Json): string {
    this.jobCount += 1
    const id = `local-${this.jobCount}`
    this.putJob(id, { device, tool, args, state: 'starting' })
    this.hub.request<Json>('hub/call', { device, tool, arguments: args }).then(
      (reply) => {
        const job = this.jobs.get(id)
        if (!job) return
        if (reply.accepted) {
          if (job.state === 'starting') this.putJob(id, { ...job, job: String(reply.job), state: 'running' })
          else this.putJob(id, { ...job, job: String(reply.job) })
        } else this.putJob(id, { ...job, state: 'rejected', text: String(reply.text ?? reply.reason) })
      },
      (e: Error) => {
        const job = this.jobs.get(id)
        if (job) this.putJob(id, { ...job, state: 'failed', text: e.message })
      },
    )
    return id
  }

  async control(method: 'hub/cancel' | 'hub/pause' | 'hub/resume', job: string): Promise<void> {
    await this.hub.request(method, { job })
  }

  async stop(device?: string): Promise<string[]> {
    const r = await this.hub.request<{ stopped: string[] }>('hub/stop', device ? { device } : {})
    return r.stopped
  }

  async set(device: string, values: Json): Promise<SetOutcome> {
    return this.hub.request<SetOutcome>('hub/set', { device, values })
  }

  async configure(device: string, source: string, on: boolean): Promise<void> {
    await this.hub.request('hub/configure', { device, sources: { [source]: { on } } })
  }

  manual(device: string, axes: Record<string, number>): void {
    this.hub.notify('hub/manual', { device, axes })
  }

  close(): void {
    this.hub.close()
  }

  // --- updates ---

  private async onConn(conn: Conn): Promise<void> {
    this.emit('conn')
    if (conn !== 'open') return
    try {
      const { devices } = await this.hub.request<{ devices: Device[] }>('hub/devices')
      this.devices = new Map()
      for (const d of devices) this.putDevice(d)
      this.relist()
      // A hub without maps answers with an error; the World view then stays empty.
      this.hub.request<{ worlds: World[] }>('hub/world').then(
        (r) => this.putWorlds(r.worlds),
        () => undefined,
      )
      await this.hub.request('hub/subscribe', {
        events: true,
        ...(this.lastEvent ? { since: this.lastEvent } : {}),
      })
      for (const sub of this.subs.values()) {
        sub.sub = undefined
        this.resubscribe(sub)
      }
    } catch {
      // The next reconnect tries again.
    }
  }

  private putDevice(d: Device): void {
    this.devices.set(d.id, d)
    this.emit(`d:${d.id}`)
  }

  private relist(): void {
    this.deviceList = [...this.devices.values()].sort(
      (a, b) => (a.ui?.order ?? 0) - (b.ui?.order ?? 0) || a.id.localeCompare(b.id),
    )
    this.emit('devices')
  }

  private putItem(key: string, item: Item, binary?: ArrayBuffer): void {
    const latest: Latest = { item, at: Date.now(), ...(binary ? { binary } : {}) }
    this.latest.set(key, latest)
    if (item.data && typeof item.data === 'object' && !binary && !item.error)
      this.record(key, item.data, item.time ?? Date.now() / 1000)
    for (const listener of [...(this.frames.get(key) ?? [])]) listener(latest)
    this.emit(`s:${key}`)
  }

  /** One sample per field per second, two minutes of them. */
  private record(key: string, data: unknown, time: number): void {
    if (!data || typeof data !== 'object') return
    let changed = false
    for (const [field, value] of Object.entries(data as Json)) {
      if (typeof value !== 'number') continue
      const k = `${key}/${field}`
      const list = this.history.get(k) ?? []
      const last = list[list.length - 1]
      if (last && time - last.time < 1) continue
      const next = [...list, { time, value }].slice(-HISTORY_KEPT)
      this.history.set(k, next)
      changed = true
    }
    if (changed) this.emit(`h:${key}`)
  }

  private putWorlds(worlds: World[] | undefined): void {
    this.worldList = worlds ?? []
    this.emit('worlds')
  }

  private putEvent(event: HubEvent): void {
    this.lastEvent = event.id
    this.events = [...this.events, event].slice(-EVENTS_KEPT)
    this.emit('events')
  }

  private putJob(id: string, job: MyJob): void {
    this.jobs.set(id, job)
    this.emit(`j:${id}`)
  }
}

const EMPTY: Sample[] = []
