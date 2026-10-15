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
import { Clips, clipSpec } from './clips.js'
import { SourceDemand } from './demand.js'
import { Events } from './events.js'
import { digest, Journal, type Operation } from './journal.js'
import { Localization } from './localization.js'
import { type Position, zoneAt } from './maps.js'
import type { MediaSample } from './media.js'
import type { Authority, BoundWakes, DeviceLink, Invocation, OwnedStore, SouthEvents } from './ports.js'
import { type ReadOptions, readSource, validateRead } from './reads.js'
import { Samples } from './samples.js'
import { Watches } from './watches.js'

export type JobSummary = Pick<
  Operation,
  'id' | 'device' | 'state' | 'label' | 'startedAt' | 'endedAt' | 'phase'
> & {
  progress?: number
  outcome?: Pick<NonNullable<Operation['outcome']>, 'status' | 'reason'>
}
export interface DeviceView {
  id: string
  revision: string
  online: boolean
  available: boolean
  description: DeviceLink['registration']
  state: Record<string, Json>
  sourceStates?: Record<string, boolean | null>
  /** Up to eight recent operations, without arguments, result payloads or wake/session identity. */
  jobs?: JobSummary[]
  health: 'ok' | 'attention' | 'bad'
  trust: 'trusted' | 'uncertain' | 'lost'
  position?: Position
  positionReason?: string
  fixed?: boolean
  zone?: string
}
type Live = {
  link: DeviceLink
  view: DeviceView
  samples: Samples
  demand: SourceDemand
  localization: Localization
}
export class Hub implements SouthEvents {
  readonly journal: Journal
  readonly activity: Activity
  readonly watches: Watches
  private readonly live = new Map<string, Live>()
  private readonly recentJobs = new Map<string, JobSummary[]>()
  private readonly videoResets = new Map<() => void, { device: string; source: string }>()
  private readonly mediaListeners = new Set<(sample: MediaSample) => void>()
  readonly events: Events
  private readonly clips = new Clips(() => this.now())
  private readonly readAbort = new AbortController()
  private completionFlush: ReturnType<typeof setTimeout> | undefined
  private stopping = false
  private controlEpoch = 0
  private readonly sampleBudget = { binary: 0, json: 0 }
  private readonly leases = new Map<string, { until: number; operationId: string }>()
  constructor(
    private readonly ports: {
      store: OwnedStore
      wakes: BoundWakes
      authority: Authority
      now?: () => number
    },
  ) {
    this.events = new Events(() => this.now())
    this.journal = new Journal(ports.store, ports.wakes, (operation) => this.remember(operation))
    this.activity = new Activity(ports.store, ports.now)
    this.watches = new Watches(
      this.journal,
      this.activity,
      () => this.snapshot(),
      ports.now,
      (device, source) => {
        const live = this.live.get(device)
        return live?.view.available ? live.demand.acquire(source, 1) : undefined
      },
    )
  }
  private remember(operation: Operation) {
    if (operation.kind !== 'action') return
    const data =
      operation.progress && typeof operation.progress === 'object' && !Array.isArray(operation.progress)
        ? operation.progress
        : {}
    const fraction = typeof operation.progress === 'number' ? operation.progress : data.fraction
    const job: JobSummary = {
      id: operation.id,
      device: operation.device,
      state: operation.state,
      ...(operation.label ? { label: operation.label } : {}),
      ...(operation.startedAt !== undefined ? { startedAt: operation.startedAt } : {}),
      ...(operation.endedAt !== undefined ? { endedAt: operation.endedAt } : {}),
      ...(operation.phase ? { phase: operation.phase } : {}),
      ...(typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1
        ? { progress: fraction }
        : {}),
      ...(operation.outcome
        ? {
            outcome: {
              status: operation.outcome.status,
              ...(operation.outcome.reason ? { reason: operation.outcome.reason } : {}),
            },
          }
        : {}),
    }
    const jobs = [job, ...(this.recentJobs.get(operation.device) ?? []).filter((row) => row.id !== job.id)]
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.id.localeCompare(b.id))
      .slice(0, 8)
    this.recentJobs.delete(operation.device)
    this.recentJobs.set(operation.device, jobs)
    if (this.recentJobs.size > 512) {
      const oldest = this.recentJobs.keys().next().value
      if (oldest) this.recentJobs.delete(oldest)
    }
    const live = this.live.get(operation.device)
    if (live) live.view.jobs = jobs
    this.emit({ type: 'operation', device: operation.device, operationId: operation.id })
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
    return [...this.live.values()].map((d) =>
      structuredClone({ ...d.view, ...d.localization.project(d.view.available) }),
    )
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
  async read(id?: string, sources: string[] = [], options: ReadOptions = {}) {
    validateRead(options)
    await this.active()
    const live = this.pick(id, false)
    const declarations = sources.map((source) => {
      const declaration = live.view.description.sources?.find((s) => s.id === source)
      if (!declaration) throw new MhsError('unknown-source')
      if (declaration.kind === 'video') throw new MhsError('video-not-model-input')
      return declaration
    })
    const signal = AbortSignal.any([this.readAbort.signal, ...(options.signal ? [options.signal] : [])])
    const releases = declarations.map((source) => live.demand.acquire(source.id))
    try {
      const items = await Promise.all(
        declarations.map((source) =>
          readSource(
            source,
            () => live.samples.get(source.id),
            (wake) => this.subscribe(wake),
            () => this.now(),
            { ...options, signal },
            () => live.samples.history(source.id),
          ),
        ),
      )
      await this.active()
      if (this.pick(live.view.id, false).link !== live.link) throw new MhsError('stale-device')
      return { device: this.snapshot().find((d) => d.id === live.view.id)!, items }
    } finally {
      for (const release of releases) release()
    }
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
      this.clips.revoke(id)
      this.watches.releaseDevice(id)
      prior.demand.close()
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
      jobs: this.recentJobs.get(id) ?? [],
      sourceStates: same
        ? (prior.view.sourceStates ?? {})
        : Object.fromEntries((link.registration.sources ?? []).map((source) => [source.id, null])),
      health: 'ok',
      trust: 'lost',
      ...(link.registration.placement ? { position: link.registration.placement } : {}),
    }
    const demand = same
      ? prior.demand
      : new SourceDemand(link, (states) => {
          const current = this.live.get(id)
          if (!current || current.link !== link) return
          current.view.sourceStates = { ...current.view.sourceStates, ...states }
          this.emit({ type: 'configuration', device: id })
        })
    const localization = same ? prior.localization : new Localization(link.registration, () => this.now())
    this.live.set(id, {
      link,
      view,
      demand,
      localization,
      samples: same ? prior.samples : new Samples(this.sampleBudget, () => this.now()),
    })
    if (link.available) {
      void demand.sync().catch(() => {})
      void this.watches.tick().catch(() => {})
    }
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
          const places = new Map((previous.places ?? []).map((p) => [p.id, p]))
          for (const place of map.places ?? []) places.set(place.id, place)
          if (places.size > 256) throw new MhsError('map-place-limit')
          tx.put(key, { ...map, places: [...places.values()] } as Json, prior.revision)
        } else tx.put(key, map as Json, null)
      })
    this.emit({ type: 'maps' })
    await this.activity.append('connected', null, link.registration.device.id)
  }
  offline(device: string, link: DeviceLink): void {
    const live = this.live.get(device)
    if (!live || live.link !== link) return
    this.clips.revoke(device)
    this.watches.releaseDevice(device)
    live.demand.close()
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
    const sample = live.samples.put(declaration, data, bytes, mime)
    if (!sample) return
    for (const listener of this.mediaListeners) {
      try {
        listener({ device, source, ...sample })
      } catch {
        /* Dropped subscriber frame. */
      }
    }
    live.localization.observe(declaration, data)
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
    live.samples.close()
  }
  async subscribeMedia(
    device: string,
    source: string,
    listener: (sample: MediaSample) => void,
    hz?: number,
  ): Promise<() => void> {
    await this.active()
    const live = this.pick(device)
    const declaration = live.view.description.sources?.find((s) => s.id === source)
    if (!declaration) throw new MhsError('unknown-source')
    const release = live.demand.acquire(source, hz)
    let last = -Infinity,
      key = declaration.kind !== 'video',
      closed = false
    const filtered = (sample: MediaSample) => {
      if (closed || sample.device !== device || sample.source !== source) return
      if (!key && object(sample.data).key !== true) return
      key = true
      // Encoded video frames are dependent: rate is configured at producer, never drop deltas here.
      if (declaration.kind !== 'video' && hz && sample.at - last < 1000 / hz) return
      last = sample.at
      listener(sample)
    }
    const reset = () => {
      key = false
    }
    if (declaration.kind === 'video') this.videoResets.set(reset, { device, source })
    this.mediaListeners.add(filtered)
    try {
      await live.demand.sync()
      if (declaration.kind === 'video') await this.keyframe(device, source)
    } catch (error) {
      this.mediaListeners.delete(filtered)
      this.videoResets.delete(reset)
      release()
      throw error
    }
    return () => {
      closed = true
      this.videoResets.delete(reset)
      this.mediaListeners.delete(filtered)
      this.videoResets.delete(reset)
      release()
    }
  }
  async keyframe(device: string, source: string): Promise<void> {
    await this.active()
    const live = this.pick(device)
    if (live.view.description.sources?.find((s) => s.id === source)?.kind !== 'video') return
    for (const [reset, binding] of this.videoResets)
      if (binding.device === device && binding.source === source) reset()
    await live.link.request('mhs/keyframe', { source })
  }
  subscribe(listener: (event: Json) => void, since?: string): () => void {
    return this.events.subscribe(listener, since)
  }
  private emit(event: Json): void {
    this.events.emit(event)
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
          ...(view.fixed ? { fixed: true } : {}),
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
      const releases = (tool.needs ?? []).map((source) => live.demand.acquire(source))
      const release = () => {
        for (const off of releases) off()
      }
      let call: Awaited<ReturnType<DeviceLink['call']>>
      try {
        await live.demand.sync()
        await this.active()
        if (epoch !== this.controlEpoch || this.pick(live.view.id).link !== live.link) {
          release()
          return this.journal.finish(invocation.operationId, { status: 'interrupted', reason: 'stop' })
        }
        call = await live.link.call(
          invocation.operationId,
          name,
          args,
          invocation.sessionId ? 'agent' : 'human',
        )
      } catch (error) {
        release()
        throw error
      }
      void call.result
        .finally(release)
        .then(async (outcome) => {
          await this.journal.finish(invocation.operationId, {
            ...outcome,
            ...(outcome.holder && 'call' in outcome.holder
              ? { holder: { ...outcome.holder, job: outcome.holder.call } }
              : {}),
            ...(notes.length ? { notes } : {}),
          })
          this.emit({ type: 'terminal', operationId: invocation.operationId })
          await this.activity.append(
            'operation',
            { operationId: invocation.operationId, status: outcome.status },
            live.view.id,
            invocation.sessionId,
          )
          this.completionFlush ??= setTimeout(() => {
            this.completionFlush = undefined
            void this.journal.flush().catch(() => {})
          }, 1000)
        })
        .catch(() => {
          /* Terminal/outbox remain recoverable on retry. */
        })
      return call.accepted
        ? ((await this.journal.running(invocation.operationId, live.view.id)) ?? accepted.operation)
        : await this.journal.finish(invocation.operationId, {
            status: 'rejected',
            reason: call.reason ?? 'invalid',
            ...(call.holder
              ? { holder: 'call' in call.holder ? { ...call.holder, job: call.holder.call } : call.holder }
              : {}),
            ...(call.needs ? { needs: call.needs } : {}),
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
    action: 'set' | 'configure' | 'pause' | 'resume' | 'cancel',
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
    const target = ['pause', 'resume', 'cancel'].includes(action)
      ? await this.journal.read(String(object(input).call))
      : undefined
    if (
      ['pause', 'resume', 'cancel'].includes(action) &&
      (!target || target.device !== device || target.kind !== 'action' || target.state === 'terminal')
    )
      throw new MhsError('job-not-running')
    const requestedSources = action === 'configure' ? object(object(input).sources ?? {}) : {}
    const accepted = await this.journal.accept(device, subject, invocation)
    if (!accepted.fresh) return accepted.operation
    try {
      if (this.stopping || epoch !== this.controlEpoch)
        return this.journal.finish(invocation.operationId, { status: 'interrupted', reason: 'stop' })
      const params = action === 'set' ? { values: input } : object(input)
      const data =
        action === 'configure'
          ? await live.demand.configure(requestedSources)
          : await live.link.request(`mhs/${action}`, params)
      if (target && (action === 'pause' || action === 'resume'))
        await this.journal.running(target.id, device, { state: action === 'pause' ? 'paused' : 'running' })
      if (action === 'configure') {
        const applied = object(object(data).sources ?? {})
        live.view.sourceStates ??= {}
        for (const [id, options] of Object.entries(applied)) {
          const on = object(options).on
          if (live.view.description.sources?.some((source) => source.id === id) && typeof on === 'boolean')
            live.view.sourceStates[id] = on
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
  async clipLease(device: string, input: Json, invocation: Invocation) {
    await this.active()
    const live = this.pick(device),
      spec = clipSpec(input),
      epoch = this.controlEpoch
    if (!live.link.clip) throw new MhsError('clip-unavailable')
    const subject = {
      operationId: invocation.operationId,
      action: 'clip' as const,
      device,
      revision: live.view.revision,
      input,
    }
    await this.ports.authority.admit(subject, invocation.context)
    await this.active()
    if (this.pick(device).link !== live.link || epoch !== this.controlEpoch)
      throw new MhsError('stale-device')
    const accepted = await this.journal.accept(device, subject, invocation)
    if (!accepted.fresh) throw new MhsError('clip-already-prepared')
    const expiresAt = this.now() + 30000
    this.clips.grant(invocation.operationId, device, live.view.revision, spec, expiresAt)
    await this.journal.finish(invocation.operationId, { status: 'done', data: { expiresAt } })
    return { operationId: invocation.operationId, expiresAt }
  }
  async clipChunk(device: string, leaseId: string, chunk: Uint8Array) {
    await this.active()
    const live = this.pick(device)
    const bytes = this.clips.append(leaseId, device, live.view.revision, chunk)
    return bytes ? this.sendClip(device, leaseId, bytes) : undefined
  }
  async sendClip(device: string, leaseId: string, bytes: Uint8Array) {
    await this.active()
    const live = this.pick(device)
    const spec = this.clips.consume(leaseId, device, live.view.revision, bytes)
    if (!live.link.clip) throw new MhsError('clip-unavailable')
    await live.link.clip(spec.id, spec.rate, spec.channels, bytes)
    return { id: spec.id, state: 'sent' }
  }
  revokeClip(device: string, leaseId?: string) {
    this.clips.revoke(device, leaseId)
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
    this.clips.revoke(device)
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
    clearTimeout(this.completionFlush)
    try {
      const result = await this.stop()
      if (reason !== 'exit') await this.watches.interrupt(reason)
      await this.journal.recover()
      return { state: result.state }
    } finally {
      for (const live of this.live.values()) live.link.close()
      this.readAbort.abort(new MhsError('disabled'))
      this.events.close()
      for (const live of this.live.values()) {
        live.demand.close()
        live.samples.close()
      }
      this.mediaListeners.clear()
      this.videoResets.clear()
    }
  }
}
