import {
  type DeviceMap,
  fieldValue,
  type Json,
  MhsError,
  object,
  prepareArguments,
  validateObservation,
} from '@agnes/mhs-device'
import { Activity } from './activity.js'
import { digest, Journal, type Operation } from './journal.js'
import { type Position, zoneAt } from './maps.js'
import type { MediaSample } from './media.js'
import type { Authority, BoundWakes, DeviceLink, Invocation, OwnedStore, SouthEvents } from './ports.js'
import { Watches } from './watches.js'

export interface DeviceView {
  id: string
  revision: string
  online: boolean
  available: boolean
  description: DeviceLink['registration']
  state: Record<string, Json>
  sourceStates?: Record<string, boolean | null>
  health: 'ok' | 'attention' | 'bad'
  trust: 'trusted' | 'uncertain' | 'lost'
  position?: Position
}
type Sample = { at: number; data: Json; bytes?: Uint8Array; mime?: string }
type Live = { link: DeviceLink; view: DeviceView; samples: Map<string, Sample[]> }
export class Hub implements SouthEvents {
  readonly journal: Journal
  readonly activity: Activity
  readonly watches: Watches
  private readonly live = new Map<string, Live>()
  private readonly mediaListeners = new Set<(sample: MediaSample) => void>()
  private readonly listeners = new Set<(event: Json) => void>()
  private stopping = false
  private controlEpoch = 0
  private sampleBytes = 0
  private sampleJsonBytes = 0
  private readonly leases = new Map<string, { until: number; operationId: string }>()
  constructor(
    private readonly ports: {
      store: OwnedStore
      wakes: BoundWakes
      authority: Authority
      now?: () => number
    },
  ) {
    this.journal = new Journal(ports.store, ports.wakes)
    this.activity = new Activity(ports.store, ports.now)
    this.watches = new Watches(this.journal, this.activity, () => this.snapshot(), ports.now)
  }
  async recover(): Promise<void> {
    await this.ports.store.transaction((tx) => {
      const format = tx.get('format')
      if (format && format.value !== 1) throw new MhsError('unsupported-store-version')
      if (!format) tx.put('format', 1, null)
    })
    await this.journal.recover()
    await this.watches.tick()
  }
  private now(): number {
    return this.ports.now?.() ?? Date.now()
  }
  private async active(): Promise<void> {
    if (this.stopping) throw new MhsError('disabled')
    await this.ports.authority.assertActive()
  }
  snapshot(): DeviceView[] {
    return [...this.live.values()].map((d) => structuredClone(d.view))
  }
  private pick(id?: string, requireOnline = true): Live {
    const devices = [...this.live.values()].filter((d) => d.view.available)
    const found = id ? this.live.get(id) : devices.length === 1 ? devices[0] : undefined
    if (!found) throw new MhsError(id ? 'not-found' : 'device-required')
    if (requireOnline && !found.view.available) throw new MhsError('offline')
    return found
  }
  async list(): Promise<DeviceView[]> {
    await this.active()
    return this.snapshot()
  }
  async read(
    id?: string,
    sources: string[] = [],
  ): Promise<{
    device: DeviceView
    items: { source: string; at: number; data: Json; mime?: string; bytes?: Uint8Array }[]
  }> {
    await this.active()
    const live = this.pick(id, false)
    const items = sources.map((source) => {
      const declaration = live.view.description.sources?.find((s) => s.id === source)
      if (!declaration) throw new MhsError('unknown-source')
      if (declaration.kind === 'video') throw new MhsError('video-not-model-input')
      const latest = live.samples.get(source)?.at(-1)
      if (!latest || this.now() - latest.at > 10_000)
        return { source, at: latest?.at ?? 0, data: { state: 'stale' } }
      const copy = structuredClone(latest)
      if (declaration.kind === 'image') {
        const data = object(copy.data)
        copy.data = { w: Number(data.w), h: Number(data.h) }
      }
      if (!['image', 'grid'].includes(declaration.kind)) delete copy.bytes
      return { source, ...copy }
    })
    return { device: structuredClone(live.view), items }
  }
  online(link: DeviceLink): void {
    if (this.stopping) {
      link.close()
      return
    }
    const id = link.registration.device.id
    const prior = this.live.get(id)
    if (!prior && this.live.size >= 512) {
      link.close()
      return
    }
    const same = prior?.link === link
    if (prior && !same) {
      this.releaseSamples(prior)
      this.leases.delete(id)
    }
    const view: DeviceView = {
      id,
      revision: digest(link.registration),
      online: true,
      available: link.available,
      description: link.registration,
      state: same ? prior.view.state : {},
      sourceStates: same
        ? (prior.view.sourceStates ?? {})
        : Object.fromEntries((link.registration.sources ?? []).map((source) => [source.id, null])),
      health: 'ok',
      trust: 'uncertain',
      ...(link.registration.placement ? { position: link.registration.placement } : {}),
    }
    this.live.set(id, { link, view, samples: same ? prior.samples : new Map() })
    this.emit({ type: 'online', device: id })
    void this.persistOnline(link).catch(() => {
      link.close()
    })
  }
  private async persistOnline(link: DeviceLink): Promise<void> {
    for (const map of link.registration.maps ?? [])
      await this.ports.store.transaction((tx) => {
        const key = `map/${map.id}`
        const prior = tx.get(key)
        if (prior) {
          const previous = prior.value as DeviceMap
          if (
            digest(previous.anchor ?? null) !== digest(map.anchor ?? null) ||
            digest(previous.bounds ?? null) !== digest(map.bounds ?? null)
          )
            throw new MhsError('map-frame-conflict')
          const places = new Map((previous.places ?? []).map((p) => [p.id, p]))
          for (const place of map.places ?? []) places.set(place.id, place)
          if (places.size > 256) throw new MhsError('map-place-limit')
          tx.put(key, { ...previous, ...map, places: [...places.values()] } as Json, prior.revision)
        } else tx.put(key, map as Json, null)
      })
    await this.activity.append('connected', null, link.registration.device.id)
  }
  offline(device: string, link: DeviceLink): void {
    const live = this.live.get(device)
    if (!live || live.link !== link) return
    live.view.online = false
    live.view.available = false
    live.view.trust = 'lost'
    this.leases.delete(device)
    this.emit({ type: 'offline', device })
    void this.watches.tick(device).catch(() => {})
    void this.activity.append('disconnected', null, device).catch(() => {})
  }
  state(device: string, values: Record<string, Json>): void {
    const live = this.pick(device, false)
    for (const [key, value] of Object.entries(values)) {
      const field = live.view.description.state?.[key]
      if (field) {
        const checked = fieldValue(field, value)
        if (checked !== value) throw new MhsError('state-out-of-range')
        live.view.state[key] = checked
      } else if (key === 'problem' && (value === null || typeof value === 'string'))
        live.view.state[key] = value
      else if (key === 'faults' && Array.isArray(value) && value.every((v) => typeof v === 'string'))
        live.view.state[key] = value
      else throw new MhsError('unknown-state')
    }
    const prior = live.view.health
    let health: DeviceView['health'] =
      live.view.state.problem || (Array.isArray(live.view.state.faults) && live.view.state.faults.length)
        ? 'bad'
        : 'ok'
    for (const [key, field] of Object.entries(live.view.description.state ?? {})) {
      const value = live.view.state[key]
      if (!field.alert || typeof value !== 'number') continue
      const crossed = (limit: number) => (field.alert?.below ? value <= limit : value >= limit)
      if (crossed(field.alert.bad)) health = 'bad'
      else if (crossed(field.alert.warn) && health === 'ok') health = 'attention'
    }
    live.view.health = health
    this.emit({ type: 'state', device, values })
    if (prior !== health) void this.activity.append('health', health, device).catch(() => {})
    void this.watches.tick(device).catch(() => {})
  }
  observation(device: string, source: string, data: Json, bytes?: Uint8Array, mime?: string): void {
    const live = this.pick(device, false)
    const declaration = live.view.description.sources?.find((s) => s.id === source)
    if (!declaration) throw new MhsError('unknown-source')
    if (
      bytes &&
      (bytes.length > 16 << 20 || !['image', 'video', 'audio', 'points', 'grid'].includes(declaration.kind))
    )
      throw new MhsError('invalid-media')
    if (declaration.kind === 'image' && (!bytes || !['image/png', 'image/jpeg'].includes(mime ?? '')))
      throw new MhsError('invalid-image')
    validateObservation(declaration, data, bytes, mime)
    live.view.sourceStates ??= {}
    live.view.sourceStates[source] = true
    const jsonBytes = Buffer.byteLength(JSON.stringify(data))
    if (jsonBytes > 65536) throw new MhsError('oversize-data')
    const history = live.samples.get(source) ?? []
    const sample: Sample = {
      at: this.now(),
      data: structuredClone(data),
      ...(bytes ? { bytes: bytes.slice() } : {}),
      ...(mime ? { mime } : {}),
    }
    // Binary frames retain one latest sample, and all devices share a strict media budget.
    if (bytes) {
      for (const previous of history) {
        this.sampleBytes -= previous.bytes?.length ?? 0
        this.sampleJsonBytes -= Buffer.byteLength(JSON.stringify(previous.data))
      }
      history.length = 0
      if (this.sampleBytes + bytes.length > 16 << 20) return
    }
    if (this.sampleJsonBytes + jsonBytes > 8 << 20) return
    this.sampleBytes += bytes?.length ?? 0
    this.sampleJsonBytes += jsonBytes
    history.push(sample)
    while (history.length > 32) {
      const removed = history.shift()
      this.sampleBytes -= removed?.bytes?.length ?? 0
      if (removed) this.sampleJsonBytes -= Buffer.byteLength(JSON.stringify(removed.data))
    }
    live.samples.set(source, history)
    for (const listener of this.mediaListeners) {
      try {
        listener({ device, source, ...sample })
      } catch {
        /* Dropped subscriber frame. */
      }
    }
    if (declaration.kind === 'pose') {
      const pose = object(data)
      live.view.trust = pose.ok === true ? 'trusted' : 'uncertain'
      live.view.position = {
        map: String(pose.map),
        x: Number(pose.x),
        y: Number(pose.y),
        yaw: Number(pose.yaw),
      }
    }
    this.emit({ type: 'observation', device, source, data })
    void this.watches.observe(device, source, data).catch(() => {})
  }
  progress(device: string, call: string, data: Json): void {
    void this.journal
      .running(call, device, data)
      .then(() => {
        this.emit({ type: 'progress', device, call, data })
      })
      .catch(() => {})
  }
  private releaseSamples(live: Live): void {
    for (const samples of live.samples.values())
      for (const sample of samples) {
        this.sampleBytes -= sample.bytes?.length ?? 0
        this.sampleJsonBytes -= Buffer.byteLength(JSON.stringify(sample.data))
      }
  }
  async subscribeMedia(
    device: string,
    source: string,
    listener: (sample: MediaSample) => void,
  ): Promise<() => void> {
    await this.active()
    const live = this.pick(device)
    if (!live.view.description.sources?.some((s) => s.id === source)) throw new MhsError('unknown-source')
    const filtered = (sample: MediaSample) => {
      if (sample.device === device && sample.source === source) listener(sample)
    }
    this.mediaListeners.add(filtered)
    return () => this.mediaListeners.delete(filtered)
  }
  async keyframe(device: string, source: string): Promise<void> {
    await this.active()
    await this.pick(device).link.request('mhs/keyframe', { source })
  }
  subscribe(listener: (event: Json) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emit(event: Json): void {
    for (const fn of this.listeners) {
      try {
        fn(event)
      } catch {
        /* Subscriber cannot break device processing. */
      }
    }
  }
  async maps(): Promise<DeviceMap[]> {
    await this.active()
    const maps: DeviceMap[] = []
    await this.journal.each('map/', async (row) => {
      maps.push(row as DeviceMap)
    })
    return maps
  }
  async world(): Promise<unknown> {
    const maps = await this.maps()
    return maps.map((map) => ({
      ...map,
      entities: this.snapshot()
        .filter((view) => view.position?.map === map.id)
        .map((view) => ({
          device: view.id,
          ...view.position,
          ok: view.trust === 'trusted',
          online: view.online,
          zone: view.position ? (zoneAt(map, view.position) ?? null) : null,
        })),
    }))
  }
  async call(
    device: string | undefined,
    name: string,
    input: unknown,
    invocation: Invocation,
  ): Promise<Operation> {
    await this.active()
    const live = this.pick(device)
    const tool = live.view.description.tools?.find((t) => t.name === name)
    if (!tool) throw new MhsError('unknown-tool')
    const epoch = this.controlEpoch
    const notes: string[] = []
    const args = prepareArguments(tool.inputSchema, input ?? {}, notes)
    const subject = {
      operationId: invocation.operationId,
      action: 'call' as const,
      device: live.view.id,
      revision: live.view.revision,
      input: { tool: name, args, requested: object(input ?? {}) as Record<string, Json> },
    }
    await this.ports.authority.admit(subject, invocation.context)
    await this.active()
    if (this.pick(live.view.id).link !== live.link) throw new MhsError('stale-device')
    const accepted = await this.journal.accept(live.view.id, subject, invocation)
    if (!accepted.fresh) return accepted.operation
    try {
      if (this.stopping || epoch !== this.controlEpoch)
        return this.journal.finish(invocation.operationId, { status: 'interrupted', reason: 'stop' })
      const call = await live.link.call(invocation.operationId, name, args)
      void call.result
        .then(async (outcome) => {
          await this.journal.finish(invocation.operationId, {
            ...outcome,
            ...(notes.length ? { notes } : {}),
          })
          this.emit({ type: 'terminal', operationId: invocation.operationId })
          await this.activity.append(
            'operation',
            { operationId: invocation.operationId, status: outcome.status },
            live.view.id,
            invocation.sessionId,
          )
          await this.journal.flush()
        })
        .catch(() => {
          /* Terminal/outbox remain recoverable on retry. */
        })
      return call.accepted
        ? ((await this.journal.running(invocation.operationId, live.view.id)) ?? accepted.operation)
        : await this.journal.finish(invocation.operationId, {
            status: 'rejected',
            reason: call.reason ?? 'invalid',
          })
    } catch {
      return this.journal.finish(invocation.operationId, {
        status: 'unknown',
        reason: 'dispatch-unconfirmed',
      })
    }
  }
  async waitOperation(id: string, signal: AbortSignal, timeoutMs = 50_000): Promise<Operation | undefined> {
    signal.throwIfAborted()
    const current = await this.journal.read(id)
    if (!current || current.state === 'terminal') return current
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let dispose = () => {}
      const cleanup = () => {
        clearTimeout(timer)
        dispose()
        signal.removeEventListener('abort', abort)
      }
      const finish = () => {
        cleanup()
        resolve()
      }
      const abort = () => {
        cleanup()
        reject(new MhsError('cancelled'))
      }
      dispose = this.subscribe((event) => {
        const e = object(event)
        if (e.type === 'terminal' && e.operationId === id) finish()
      })
      timer = setTimeout(finish, Math.max(0, Math.min(timeoutMs, 50_000)))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else
        void this.journal.read(id).then((row) => {
          if (row?.state === 'terminal') finish()
        }, abort)
    })
    return this.journal.read(id)
  }
  async effect(
    action: 'set' | 'configure' | 'resume' | 'cancel',
    device: string,
    input: Json,
    invocation: Invocation,
  ): Promise<Operation> {
    await this.active()
    const live = this.pick(device)
    const epoch = this.controlEpoch
    if (action === 'set')
      for (const [key, value] of Object.entries(object(input))) {
        const field = live.view.description.state?.[key]
        if (!field?.writable || fieldValue(field, value) !== value) throw new MhsError('invalid-setting')
      }
    const subject = {
      operationId: invocation.operationId,
      action,
      device,
      revision: live.view.revision,
      input,
    }
    await this.ports.authority.admit(subject, invocation.context)
    await this.active()
    if (this.pick(device).link !== live.link) throw new MhsError('stale-device')
    const requestedSources = action === 'configure' ? object(object(input).sources ?? {}) : {}
    const accepted = await this.journal.accept(device, subject, invocation)
    if (!accepted.fresh) return accepted.operation
    try {
      if (this.stopping || epoch !== this.controlEpoch)
        return this.journal.finish(invocation.operationId, { status: 'interrupted', reason: 'stop' })
      const params = action === 'set' ? { values: input } : object(input)
      const data = await live.link.request(`mhs/${action}`, params)
      if (action === 'configure') {
        const applied = object(object(data).sources ?? {})
        live.view.sourceStates ??= {}
        for (const [id, options] of Object.entries(applied)) {
          if (
            live.view.description.sources?.some((source) => source.id === id) &&
            typeof object(options).on === 'boolean'
          )
            live.view.sourceStates[id] = object(options).on as boolean
        }
        this.emit({ type: 'configuration', device })
      }
      return await this.journal.finish(invocation.operationId, { status: 'done', data: data as Json })
    } catch {
      if (action === 'configure') {
        live.view.sourceStates ??= {}
        for (const id of Object.keys(requestedSources)) live.view.sourceStates[id] = null
        this.emit({ type: 'configuration', device })
      }
      return this.journal.finish(invocation.operationId, {
        status: 'unknown',
        reason: 'dispatch-unconfirmed',
      })
    }
  }
  async manualLease(
    device: string,
    invocation: Invocation,
  ): Promise<{ operationId: string; expiresAt: number }> {
    await this.active()
    const live = this.pick(device)
    const epoch = this.controlEpoch
    if (!live.view.description.manual) throw new MhsError('manual-unavailable')
    await this.ports.authority.admit(
      {
        operationId: invocation.operationId,
        action: 'manual',
        device,
        revision: live.view.revision,
        input: { durationMs: 30_000 },
      },
      invocation.context,
    )
    await this.active()
    if (this.pick(device).link !== live.link) throw new MhsError('stale-device')
    const subject = { action: 'manual', device, revision: live.view.revision, durationMs: 30_000 }
    const accepted = await this.journal.accept(device, subject, invocation)
    if (!accepted.fresh) {
      const expiresAt = Number(object(accepted.operation.outcome?.data ?? {}).expiresAt ?? 0)
      return { operationId: invocation.operationId, expiresAt }
    }
    const until = this.now() + 30_000
    await this.journal.finish(invocation.operationId, { status: 'done', data: { expiresAt: until } })
    if (this.stopping || epoch !== this.controlEpoch) throw new MhsError('stopped')
    this.leases.set(device, { operationId: invocation.operationId, until })
    return { operationId: invocation.operationId, expiresAt: until }
  }
  async manual(device: string, leaseId: string, axes: Record<string, number>): Promise<void> {
    await this.active()
    const lease = this.leases.get(device)
    if (!lease || lease.operationId !== leaseId || lease.until <= this.now())
      throw new MhsError('lease-expired')
    const live = this.pick(device)
    const manual = live.view.description.manual
    if (!manual || Object.values(axes).some((v) => !Number.isFinite(v))) throw new MhsError('invalid-axes')
    live.link.manual(
      Object.fromEntries(manual.axes.map((a) => [a.id, Math.max(a.min, Math.min(a.max, axes[a.id] ?? 0))])),
    )
  }
  async stop(
    device?: string,
  ): Promise<{ state: 'settled' | 'unknown'; devices: Record<string, 'stopped' | 'unknown'> }> {
    this.controlEpoch += 1
    const devices: Record<string, 'stopped' | 'unknown'> = {}
    const selected = device ? [this.pick(device, false)] : [...this.live.values()]
    await Promise.all(
      selected.map(async (live) => {
        this.leases.delete(live.view.id)
        try {
          if (live.view.description.manual) {
            try {
              live.link.manual({})
            } catch {
              /* Command Stop must still be attempted. */
            }
          }
          await live.link.request('mhs/stop', {})
          devices[live.view.id] = 'stopped'
        } catch {
          devices[live.view.id] = 'unknown'
        }
      }),
    )
    await this.ports.store.transaction((tx) => {
      const row = tx.get('last-stop')
      tx.put('last-stop', { at: this.now(), devices }, row?.revision ?? null)
    })
    await this.activity.append('stop', devices, device)
    return { state: Object.values(devices).includes('unknown') ? 'unknown' : 'settled', devices }
  }
  async shutdown(reason: 'disable' | 'upgrade' | 'exit' = 'exit'): Promise<{ state: 'settled' | 'unknown' }> {
    this.stopping = true
    try {
      const result = await this.stop()
      if (reason !== 'exit') await this.watches.interrupt(reason)
      await this.journal.recover()
      return { state: result.state }
    } finally {
      for (const live of this.live.values()) live.link.close()
      this.listeners.clear()
      this.mediaListeners.clear()
    }
  }
}
