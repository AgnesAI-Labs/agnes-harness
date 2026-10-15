import { validateObservation } from './observations.js'
import type { DeviceTool, Json, Observation, Outcome, Registration, ResourceHolder } from './schema.js'
import { fieldValue, MhsError, object, prepareArguments, validateRegistration } from './validation.js'

export interface Clip {
  rate: number
  channels: number
  pcm: Uint8Array
  receivedAt: number
}

export interface SafetyPort {
  /** Must arm an independent hardware/process watchdog; the JS timer alone is insufficient. */
  arm(deadmanMs: number): void
  stop(reason: string): Promise<void>
}
export interface CallContext {
  readonly id: string
  readonly signal: AbortSignal
  progress(data: Json): void
  checkpoint(rest?: () => Promise<void>): Promise<void>
}
export type ToolHandler = (args: Record<string, Json>, call: CallContext) => Promise<Json | undefined>
type Running = {
  id: string
  caller?: string
  tool: DeviceTool
  controller: AbortController
  paused: boolean
  pauseAck?: () => void
  resume?: () => void
  settled: Promise<Outcome>
}

/** Device-local safety and resource authority, shared by network and embedded adapters. */
export class Device {
  readonly description: Registration
  private readonly clips = new Map<string, Clip>()
  private readonly handlers = new Map<string, ToolHandler>()
  private readonly running = new Map<string, Running>()
  private readonly values: Record<string, Json> = { problem: null, faults: [] }
  private manualTimer: ReturnType<typeof setTimeout> | undefined
  private manualUntil = 0
  private stopped = false
  onObservation: ((observation: Observation, bytes?: Uint8Array) => boolean) | undefined
  onConfigure: ((sources: Record<string, Json>) => Promise<void>) | undefined
  onKeyframe: ((source: string) => Promise<void>) | undefined
  private readonly settings = new Map<string, Record<string, Json>>()
  private readonly publishedAt = new Map<string, number>()
  private readonly sequences = new Map<string, number>()
  publish(source: string, data: Json, bytes?: Uint8Array, mime?: string): boolean {
    const declaration = this.description.sources?.find((s) => s.id === source)
    if (!declaration) throw new MhsError('unknown-source')
    validateObservation(declaration, data, bytes, mime)
    const settings = this.settings.get(source)
    if (settings?.on === false) return false
    const hz = Number(
      settings?.hz ??
        (declaration.kind === 'image'
          ? 1
          : declaration.kind === 'video'
            ? 5
            : Math.min(declaration.hz ?? 0, 2)),
    )
    const now = performance.now()
    if (hz > 0 && now - (this.publishedAt.get(source) ?? -Infinity) < 1000 / hz) return false
    this.publishedAt.set(source, now)
    const seq = (this.sequences.get(source) ?? -1) + 1
    this.sequences.set(source, seq)
    return (
      this.onObservation?.(
        {
          type: 'data',
          source,
          seq,
          t: Date.now() / 1000,
          data,
          ...(bytes ? { bytes: bytes.length } : {}),
          ...(mime ? { mime } : {}),
        },
        bytes,
      ) ?? false
    )
  }
  onManual: ((axes: Record<string, number>) => Promise<void>) | undefined
  onState: ((values: Record<string, Json>) => void) | undefined
  onProgress: ((id: string, data: Json) => void) | undefined

  constructor(
    description: Registration,
    private readonly safety?: SafetyPort,
  ) {
    this.description = validateRegistration(description)
    for (const source of this.description.sources ?? [])
      this.settings.set(source.id, {
        on: source.kind === 'pose',
        ...(source.kind === 'pose' ? { hz: 1 } : {}),
      })
  }
  async configure(input: unknown): Promise<{ sources: Record<string, Json> }> {
    const sources = object(input)
    const applied: Record<string, Json> = {}
    for (const [id, options] of Object.entries(sources)) {
      const source = this.description.sources?.find((s) => s.id === id)
      if (!source) throw new MhsError('unknown-source')
      const requested = object(options)
      if (typeof requested.on !== 'boolean') throw new MhsError('invalid-configure')
      const next: Record<string, Json> = { on: requested.on }
      if (requested.hz !== undefined) {
        if (typeof requested.hz !== 'number' || !Number.isFinite(requested.hz) || requested.hz <= 0)
          throw new MhsError('invalid-configure')
        next.hz = Math.min(requested.hz, source.hz ?? requested.hz)
      }
      if (requested.bitrate_kbps !== undefined) {
        if (
          source.kind !== 'video' ||
          typeof requested.bitrate_kbps !== 'number' ||
          !Number.isFinite(requested.bitrate_kbps)
        )
          throw new MhsError('invalid-configure')
        next.bitrate_kbps = Math.max(
          source.bitrate_kbps?.[0] ?? 1,
          Math.min(source.bitrate_kbps?.[1] ?? requested.bitrate_kbps, requested.bitrate_kbps),
        )
      }
      if (requested.size !== undefined) {
        if (
          !Array.isArray(requested.size) ||
          requested.size.length !== 2 ||
          requested.size.some((v) => typeof v !== 'number' || !Number.isFinite(v)) ||
          !source.sizes?.length
        )
          throw new MhsError('invalid-configure')
        const size = requested.size as number[]
        next.size =
          [...source.sizes].sort(
            (a, b) =>
              Math.abs(a[0] - Number(size[0])) +
              Math.abs(a[1] - Number(size[1])) -
              Math.abs(b[0] - Number(size[0])) -
              Math.abs(b[1] - Number(size[1])),
          )[0] ?? []
      }
      applied[id] = next
    }
    await this.onConfigure?.(applied)
    for (const [id, settings] of Object.entries(applied))
      this.settings.set(id, settings as Record<string, Json>)
    return { sources: applied }
  }
  receiveClip(id: string, rate: number, channels: number, pcm: Uint8Array): void {
    if (
      !id ||
      id.length > 256 ||
      !Number.isInteger(rate) ||
      rate < 1 ||
      rate > 384000 ||
      !Number.isInteger(channels) ||
      channels < 1 ||
      channels > 8 ||
      !pcm.length ||
      pcm.length > 16 << 20 ||
      pcm.length % (2 * channels) !== 0
    )
      throw new MhsError('invalid-clip')
    this.clips.delete(id)
    this.clips.set(id, { rate, channels, pcm: pcm.slice(), receivedAt: Date.now() })
    while (this.clips.size > 8) {
      const first = this.clips.keys().next().value
      if (first) this.clips.delete(first)
    }
  }
  clip(id: string): Clip | undefined {
    const clip = this.clips.get(id)
    if (!clip || Date.now() - clip.receivedAt > 60_000) {
      this.clips.delete(id)
      return undefined
    }
    return { ...clip, pcm: clip.pcm.slice() }
  }
  tool(name: string, handler: ToolHandler): this {
    if (!this.description.tools?.some((t) => t.name === name) || this.handlers.has(name))
      throw new MhsError('invalid-tool')
    this.handlers.set(name, handler)
    return this
  }
  update(values: Record<string, Json>): void {
    const next: Record<string, Json> = {}
    for (const [key, value] of Object.entries(values)) {
      const field = this.description.state?.[key]
      if (field) next[key] = fieldValue(field, value)
      else if (key === 'problem' && (value === null || typeof value === 'string')) next[key] = value
      else if (key === 'faults' && Array.isArray(value) && value.every((v) => typeof v === 'string'))
        next[key] = value
      else throw new MhsError('invalid-state')
    }
    Object.assign(this.values, next)
    this.onState?.(structuredClone(next))
  }
  state(): Record<string, Json> {
    return structuredClone(this.values)
  }
  set(values: Record<string, Json>): { values: Record<string, Json>; refused: string[] } {
    const accepted: Record<string, Json> = {}
    const refused: string[] = []
    for (const [key, value] of Object.entries(values)) {
      const field = this.description.state?.[key]
      if (!field?.writable) {
        refused.push(key)
        continue
      }
      try {
        accepted[key] = fieldValue(field, value)
      } catch {
        refused.push(key)
      }
    }
    this.update(accepted)
    return { values: accepted, refused }
  }
  call(
    id: string,
    name: string,
    input: unknown,
    caller?: string,
  ): {
    accepted: boolean
    reason?: string
    holder?: ResourceHolder
    needs?: string[]
    result?: Promise<Outcome>
  } {
    const tool = this.description.tools?.find((t) => t.name === name)
    const handler = this.handlers.get(name)
    if (!tool || !handler || this.running.has(id)) return { accepted: false, reason: 'invalid' }
    const notes: string[] = []
    let args: Record<string, Json>
    try {
      args = object(prepareArguments(tool.inputSchema, input, notes)) as Record<string, Json>
    } catch {
      return { accepted: false, reason: 'invalid' }
    }
    if (
      this.stopped ||
      this.values.problem ||
      (Array.isArray(this.values.faults) && this.values.faults.length > 0) ||
      (tool.motion && !this.safety)
    )
      return { accepted: false, reason: 'unsafe' }
    const needs = (tool.needs ?? []).filter((id) => this.settings.get(id)?.on === false)
    if (needs.length) return { accepted: false, reason: 'needs', needs }
    const clipId = args.clip
    if (typeof clipId === 'string' && !this.clip(clipId)) return { accepted: false, reason: 'missing-clip' }
    const conflicts = [...this.running.values()].filter((r) =>
      r.tool.uses?.some((x) => tool.uses?.includes(x)),
    )
    if (tool.motion && this.manualUntil > performance.now())
      return { accepted: false, reason: 'busy', holder: { manual: true } }
    const holder = conflicts.find((r) =>
      r.tool.uses?.some((x) => tool.uses?.includes(x) && this.description.resources?.[x] === 'reject'),
    )
    if (holder)
      return {
        accepted: false,
        reason: 'busy',
        holder: {
          call: holder.id,
          tool: holder.tool.name,
          ...(holder.caller ? { caller: holder.caller } : {}),
        },
      }
    const controller = new AbortController()
    // Register before yielding so a second call sees queued resource ownership too.
    const entry: Running = {
      id,
      ...(caller ? { caller } : {}),
      tool,
      controller,
      paused: false,
      settled: Promise.resolve({ status: 'unknown' }),
    }
    this.running.set(id, entry)
    const timeout = setTimeout(() => controller.abort('timeout'), tool.timeout * 1000)
    const interrupted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener(
        'abort',
        () => reject(new MhsError(String(controller.signal.reason))),
        { once: true },
      ),
    )
    const context: CallContext = {
      id,
      signal: controller.signal,
      progress: (data) => {
        if (!controller.signal.aborted) this.onProgress?.(id, data)
      },
      checkpoint: async (rest) => {
        controller.signal.throwIfAborted()
        if (tool.motion) this.safety?.arm(2000)
        if (entry.paused) {
          if (rest) await rest()
          else if (tool.motion) await this.safety?.stop('pause')
          this.onProgress?.(id, { state: 'paused' })
          entry.pauseAck?.()
          await Promise.race([
            new Promise<void>((r) => {
              entry.resume = r
            }),
            interrupted,
          ])
          this.onProgress?.(id, { state: 'running' })
        }
        controller.signal.throwIfAborted()
      },
    }
    const work = async (): Promise<Outcome> => {
      try {
        await Promise.race([Promise.all(conflicts.map((r) => r.settled)), interrupted])
        controller.signal.throwIfAborted()
        if (tool.motion) this.safety?.arm(2000)
        const data = await Promise.race([handler(args, context), interrupted])
        return { status: 'done', ...(data === undefined ? {} : { data }), ...(notes.length ? { notes } : {}) }
      } catch {
        const reason = controller.signal.aborted ? String(controller.signal.reason) : 'failed'
        if (tool.motion) {
          try {
            await this.safety?.stop(reason)
          } catch {
            this.stopped = true
            return { status: 'unknown', reason: 'stop-unconfirmed' }
          }
        }
        return { status: reason === 'timeout' || reason === 'failed' ? 'error' : 'interrupted', reason }
      } finally {
        clearTimeout(timeout)
        this.running.delete(id)
      }
    }
    entry.settled = work()
    return { accepted: true, result: entry.settled }
  }
  async stop(reason = 'stop'): Promise<void> {
    this.manualUntil = 0
    clearTimeout(this.manualTimer)
    // Zero first; aborting cooperative handlers alone never proves that motors stopped.
    try {
      await this.safety?.stop(reason)
      await this.onManual?.(Object.fromEntries((this.description.manual?.axes ?? []).map((a) => [a.id, 0])))
    } catch (error) {
      this.stopped = true
      throw error
    } finally {
      for (const call of this.running.values()) if (call.tool.motion) call.controller.abort(reason)
    }
  }
  async cancel(id: string): Promise<void> {
    const call = this.running.get(id)
    try {
      if (call?.tool.motion) await this.safety?.stop('cancel')
    } finally {
      call?.controller.abort('cancel')
    }
  }
  async pause(id: string): Promise<void> {
    const call = this.running.get(id)
    if (!call?.tool.pausable) throw new MhsError('not-pausable')
    call.paused = true
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        call.controller.abort('pause_timeout')
        reject(new MhsError('pause-timeout'))
      }, 1500)
      call.pauseAck = () => {
        clearTimeout(timer)
        resolve()
      }
      call.controller.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new MhsError('interrupted'))
        },
        { once: true },
      )
    })
  }
  resume(id: string): void {
    const call = this.running.get(id)
    if (call) {
      call.paused = false
      call.resume?.()
    }
  }
  async manual(input: unknown): Promise<void> {
    const manual = this.description.manual
    if (this.stopped || !manual || !this.safety || !this.onManual) throw new MhsError('unsafe')
    const supplied = object(input)
    if (Object.values(supplied).some((v) => typeof v !== 'number' || !Number.isFinite(v)))
      throw new MhsError('invalid')
    const axes = Object.fromEntries(
      manual.axes.map((a) => [a.id, Math.max(a.min, Math.min(a.max, Number(supplied[a.id] ?? 0)))]),
    )
    if (Object.values(axes).some((v) => v !== 0)) {
      await this.safety.stop('manual')
      for (const call of this.running.values()) if (call.tool.motion) call.controller.abort('manual')
      this.manualUntil = performance.now() + manual.deadman_s * 1000
    }
    this.safety.arm(manual.deadman_s * 1000)
    clearTimeout(this.manualTimer)
    this.manualTimer = setTimeout(() => {
      void this.stop('deadman').catch(() => {
        this.stopped = true
      })
    }, manual.deadman_s * 1000)
    await this.onManual(axes)
  }
  async disconnect(): Promise<void> {
    this.clips.clear()
    this.stopped = true
    try {
      await this.stop('disconnect')
    } finally {
      for (const call of this.running.values()) call.controller.abort('disconnect')
    }
  }
  reconnect(): void {
    if (this.running.size) throw new MhsError('still-stopping')
    this.stopped = false
  }
}
