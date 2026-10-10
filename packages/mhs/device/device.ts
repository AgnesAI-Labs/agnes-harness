/**
 * The device side of mhs/v1 in TypeScript, for browsers and Node (both have a global WebSocket).
 * It mirrors the Python agnes_mhs.Device: declare tools and sources, and the library speaks the
 * protocol (registration, reconnecting, argument checks, resources, cancel, stop, pause, the
 * manual deadman, state and settings, configure, keyframes, clock replies, audio clips, and mhs/ping
 * for liveness, since pages cannot send WebSocket pings).
 *
 *   const dev = new Device({ id: 'desk-lamp-01', kind: 'light', resources: { head: 'reject' } })
 *   dev.tool({ name: 'tilt', description: 'Tilt the lamp head.', timeout: 10, motion: true,
 *              params: { angle: { type: 'number', minimum: -45, maximum: 45 } }, required: ['angle'],
 *              uses: ['head'] }, async (call, { angle }) => { ...; await call.sleep(100); return 'tilted' })
 *   await dev.run('ws://127.0.0.1:4180')
 *
 * Section numbers refer to the MHS specification, or to MOS where marked.
 */
import { prepareArguments } from '../server/args.js'

const PROTOCOL = 'mhs/v1'
const SUBPROTOCOL = 'mhs.v1'
const CLOSE_REPLACED = 4001
const CLOSE_BAD_VERSION = 4003
const INTERRUPT_REASONS = ['stop', 'cancel', 'manual', 'estop', 'pause_timeout']
const PAUSE_WAIT = 1500 // ms a pausable tool has to reach a checkpoint, within the hub's 2 s (CTL-5)
const CLIPS_KEPT = 8 // at least the 4 most recent (STR-8)
const BACKLOG = 1 << 20 // bytes buffered on the Nerve socket before newer data waits (STR-6)
const PING_EVERY = 2000 // ms between mhs/ping requests (CONN-9)
const PING_LOST = 3000 // ms without a reply after which both channels count as lost

type Json = Record<string, unknown>
type Maybe<T> = T | Promise<T>

/** Throw from a tool to end its call with an error, or as interrupted for an interrupt reason. */
export class CallError extends Error {
  readonly status: string
  readonly data: Json | undefined
  constructor(
    readonly reason: string,
    readonly detail: string,
    options: { status?: string; data?: Json } = {},
  ) {
    super(detail)
    this.status = options.status ?? (INTERRUPT_REASONS.includes(reason) ? 'interrupted' : 'error')
    this.data = options.data
  }
}

/** Thrown inside a tool by checkpoint() and sleep() once its call was interrupted. */
export class Interrupted extends Error {}

export interface ToolOptions {
  name: string
  description: string
  timeout: number
  params?: Record<string, Json>
  required?: string[]
  uses?: string[]
  motion?: boolean
  readOnly?: boolean
  pausable?: boolean
  needs?: string[]
  ui?: Json
}

/** What a tool returns: nothing, a detail sentence, or detail with data and notes. */
export type ToolResult = undefined | string | { detail?: string; data?: Json; notes?: string[] }
// biome-ignore lint/suspicious/noExplicitAny: arguments are validated against the tool's schema at run time
export type ToolHandler = (call: Call, args: Record<string, any>) => Maybe<ToolResult | undefined>

export interface DeviceOptions {
  id: string
  kind: string
  name?: string
  model?: string
  vendor?: string
  firmware?: string
  mobile?: boolean
  radius?: number
  profile?: Json
  localization?: 'none' | 'self' | 'external' | 'fixed'
  /** Where a fixed device is installed (REG-4). */
  placement?: { map: string; x: number; y: number; yaw: number }
  /** Maps this device defines: frames and named places (MOS 3.5). */
  maps?: Json[]
  resources?: Record<string, 'reject' | 'queue'>
  manual?: {
    axes: { id: string; min: number; max: number; [key: string]: unknown }[]
    deadman_s: number
    [key: string]: unknown
  }
  /** State fields (10.1): field declarations, `writable` for settings the hub may change. */
  state?: Record<string, Json>
  ui?: Json
}

export interface Clip {
  rate: number
  channels: number
  pcm: Uint8Array
  received: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** One running call, handed to the tool. */
export class Call {
  readonly motion: boolean
  readonly pausable: boolean
  readonly uses: string[]
  notes: string[] = []
  endReason: string | undefined
  readonly generation: number
  private readonly abort = new AbortController()
  private pauseRequested = false
  private atRest: (() => void) | undefined
  private resumed: Promise<void> = Promise.resolve()
  private resume: () => void = () => undefined
  private lastProgress = 0

  constructor(
    private readonly device: Device,
    readonly id: string,
    readonly name: string,
    readonly args: Json,
    decl: Json,
  ) {
    this.motion = decl.motion === true
    this.pausable = decl.pausable === true
    this.uses = (decl.uses as string[] | undefined) ?? []
    this.generation = device.generation
  }

  /** Aborted when the call is interrupted; pass it to fetches, timers, animations. */
  get signal(): AbortSignal {
    return this.abort.signal
  }

  get paused(): boolean {
    return this.pauseRequested
  }

  /** Reports progress; at most 2 per second are sent (CALL-4), the rest are dropped. */
  progress(update: { done?: number; total?: number; text?: string; data?: Json }): void {
    const now = performance.now()
    if (now - this.lastProgress < 500) return
    this.lastProgress = now
    this.device.notify(this, 'mhs/progress', { call: this.id, ...update })
  }

  /** Call often from a long tool. Throws Interrupted once the call is cancelled or stopped. While
   * paused, calls rest once (bring the motion to rest) and waits for resume. */
  async checkpoint(rest?: () => Maybe<void>): Promise<void> {
    if (this.abort.signal.aborted) throw new Interrupted(this.endReason)
    if (this.pauseRequested) {
      await rest?.()
      this.atRest?.()
      await Promise.race([this.resumed, this.aborted()])
    }
    await sleep(0)
    if (this.abort.signal.aborted) throw new Interrupted(this.endReason)
  }

  /** Waits, but throws Interrupted as soon as the call is interrupted. */
  async sleep(ms: number): Promise<void> {
    await Promise.race([sleep(ms), this.aborted()])
    if (this.abort.signal.aborted) throw new Interrupted(this.endReason)
  }

  /** Resolves when the call is interrupted. */
  aborted(): Promise<void> {
    const signal = this.abort.signal
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  }

  interrupt(reason: string): void {
    if (this.abort.signal.aborted) return
    this.endReason ??= reason
    this.abort.abort()
  }

  requestPause(): Promise<boolean> {
    this.pauseRequested = true
    this.resumed = new Promise((resolve) => {
      this.resume = resolve
    })
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), PAUSE_WAIT)
      this.atRest = () => {
        clearTimeout(timer)
        this.atRest = undefined
        resolve(true)
      }
    })
  }

  release(): void {
    this.pauseRequested = false
    this.atRest = undefined
    this.resume()
  }
}

/** A data source (MOS 3). send() streams one message when the hub wants this source. */
export class Source {
  readonly id: string
  readonly kind: string
  on = true
  hz: number | undefined
  bitrateKbps: number | undefined
  size: number[] | undefined
  /** The next picture of a video source must be a keyframe: the hub asked, or a picture was dropped (VID-7). */
  keyframeRequested = false
  /** The last message queued, whose seq and t a derived result names (MOS PER-4). */
  sent: Json | undefined
  /** Called with the applied settings after mhs/configure, for example to stop rendering. */
  onConfigure: ((applied: Json) => Maybe<void>) | undefined
  private seq = 0
  private last = -Infinity
  private needKey = false

  constructor(
    private readonly device: Device,
    readonly decl: Json,
  ) {
    this.id = decl.id as string
    this.kind = decl.kind as string
    this.bitrateKbps = (decl.bitrate_kbps as number[] | undefined)?.[0]
    this.size = decl.size as number[] | undefined
    this.hz = this.defaultHz()
  }

  /** Rates before the first mhs/configure (MOS 8). */
  private defaultHz(): number | undefined {
    if (this.kind === 'image') return 1
    if (this.kind === 'video') return 5
    const declared = this.decl.hz as number | undefined
    return declared === undefined ? undefined : Math.min(declared, 2)
  }

  /** Whether a message sent now would go out: the source is on and its rate allows it. */
  wants(): boolean {
    if (!this.on) return false
    return this.hz === undefined || performance.now() - this.last >= 900 / this.hz
  }

  /** Queues one message; false when it was not wanted. An unsent older message of this source is
   * replaced (STR-6) and its seq skipped (STR-1); after a dropped video picture, pictures are held
   * back until a keyframe (VID-7). */
  send(data: Json, binary?: Uint8Array, extra: { t?: number; of_seq?: number; lag?: number } = {}): boolean {
    if (!this.wants()) return false
    if (this.kind === 'video' && this.needKey && !data.key) {
      this.seq += 1
      return false
    }
    this.last = performance.now()
    const msg: Json = { type: 'data', source: this.id, seq: this.seq, t: extra.t ?? Date.now() / 1000, data }
    this.seq += 1
    if (binary !== undefined) msg.bin = true
    if (extra.of_seq !== undefined) msg.of_seq = extra.of_seq
    if (extra.lag !== undefined) msg.lag = extra.lag
    this.sent = msg
    if (this.kind === 'video' && data.key) {
      this.needKey = false
      this.keyframeRequested = false
    }
    if (this.device.queue(this, msg, binary) && this.kind === 'video') {
      this.needKey = true
      this.keyframeRequested = true
    }
    return true
  }

  configure(setting: Json): Json {
    if (typeof setting.on === 'boolean') this.on = setting.on
    const declared = this.decl.hz as number | undefined
    if (typeof setting.hz === 'number' && setting.hz > 0)
      this.hz = declared ? Math.min(setting.hz, declared) : setting.hz
    const span = this.decl.bitrate_kbps as number[] | undefined
    if (typeof setting.bitrate_kbps === 'number' && span)
      this.bitrateKbps = Math.max(span[0] ?? 0, Math.min(span[1] ?? Infinity, setting.bitrate_kbps))
    const sizes = (this.decl.sizes as number[][] | undefined) ?? []
    const size = setting.size
    if (Array.isArray(size) && sizes.some((s) => s[0] === size[0] && s[1] === size[1]))
      this.size = size as number[]
    const applied: Json = { on: this.on }
    if (this.hz !== undefined) applied.hz = this.hz
    if (this.bitrateKbps !== undefined) applied.bitrate_kbps = this.bitrateKbps
    if (this.size !== undefined && sizes.length > 0) applied.size = this.size
    return applied
  }
}

interface Tool {
  decl: Json
  handler: ToolHandler
}

/** One device: its description, tools and sources, and its two connections to a hub. */
export class Device {
  readonly id: string
  /** Zero all motion (CTL-3, SAFE-2). */
  onStop: (() => Maybe<void>) | undefined
  /** Clamped axes; zeros after the deadman (9). */
  onManual: ((axes: Record<string, number>) => Maybe<void>) | undefined
  /** Snapshot added to every result (7.3). */
  after: (() => Json) | undefined
  /** Why a tool cannot run now, or undefined (7.1). */
  unsafe: ((tool: string) => string | undefined) | undefined
  /** Applies a writable state field the hub set (10.1); returns the value in effect, or undefined to keep it. */
  onSet: ((name: string, value: unknown) => Maybe<unknown>) | undefined
  /** Increases with every command connection; a call's messages go only to the connection it came from. */
  generation = 0
  log: (line: string) => void = () => undefined

  private readonly options: DeviceOptions
  private readonly tools = new Map<string, Tool>()
  private readonly sources = new Map<string, Source>()
  private readonly calls = new Map<string, Call>()
  private readonly holders = new Map<string, Json>()
  private releaseWaiters: (() => void)[] = []
  private readonly clips = new Map<string, Clip>()
  private readonly outbox = new Map<string, [Json, Uint8Array | undefined]>()
  private cmd: WebSocket | undefined
  private nerve: WebSocket | undefined
  private readonly values: Json = { problem: null, faults: [] }
  private pong: ((id: unknown) => void) | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private finished = false
  private manualLast = 0
  private manualNonzero = 0
  private manualMoving = false
  private timers: ReturnType<typeof setInterval>[] = []

  constructor(options: DeviceOptions) {
    this.options = options
    this.id = options.id
  }

  // Declaring

  /** Declares a tool (6.1). The handler gets the Call and the checked arguments. */
  tool(options: ToolOptions, handler: ToolHandler): void {
    const schema: Json = { type: 'object' }
    if (options.params) schema.properties = options.params
    if (options.required?.length) schema.required = options.required
    const decl: Json = {
      name: options.name,
      description: options.description,
      inputSchema: schema,
      timeout: options.timeout,
    }
    if (options.uses?.length) decl.uses = options.uses
    if (options.needs?.length) decl.needs = options.needs
    if (options.ui) decl.ui = options.ui
    if (options.motion) decl.motion = true
    if (options.readOnly) decl.readOnly = true
    if (options.pausable) decl.pausable = true
    this.tools.set(options.name, { decl, handler })
  }

  /** Declares a data source (MOS 3.1); meta holds hz, mount, fields and the kind's metadata. */
  source(id: string, kind: string, description: string, meta: Json = {}): Source {
    const source = new Source(this, { id, kind, description, ...meta })
    this.sources.set(id, source)
    return source
  }

  /** The params of mhs/register (5). */
  description(): Json {
    const o = this.options
    const device: Json = { id: o.id, kind: o.kind, mobile: o.mobile ?? false }
    for (const key of ['name', 'model', 'vendor', 'firmware', 'radius'] as const)
      if (o[key] !== undefined) device[key] = o[key]
    const d: Json = { protocol: PROTOCOL, device, localization: o.localization ?? 'none' }
    if (o.profile) d.profile = o.profile
    if (o.placement) d.placement = o.placement
    if (o.maps?.length) d.maps = o.maps
    if (o.resources && Object.keys(o.resources).length) d.resources = o.resources
    if (this.sources.size) d.sources = [...this.sources.values()].map((s) => s.decl)
    if (this.tools.size) d.tools = [...this.tools.values()].map((t) => t.decl)
    if (o.manual) d.manual = o.manual
    if (o.state && Object.keys(o.state).length) d.state = o.state
    if (o.ui) d.ui = o.ui
    return d
  }

  /** An audio clip the hub sent (MOS 2.3), if it is still kept. */
  clip(id: string): Clip | undefined {
    return this.clips.get(id)
  }

  /** The current state values, including problem and faults (10.1). */
  get state(): Json {
    return { ...this.values }
  }

  /** Changes state values; the changed ones go to the hub at once (STATE-2). */
  update(values: Json): void {
    const changed: Json = {}
    for (const [name, value] of Object.entries(values)) {
      if (!(name in (this.options.state ?? {})) && name !== 'problem' && name !== 'faults')
        throw new Error(`${name} is not a declared state field`)
      if (JSON.stringify(this.values[name]) === JSON.stringify(value)) continue
      this.values[name] = value
      changed[name] = value
    }
    if (Object.keys(changed).length > 0)
      this.sendCommand({
        jsonrpc: '2.0',
        method: 'mhs/state',
        params: { t: Date.now() / 1000, values: changed },
      })
  }

  /** One sentence when operators should know something is wrong, otherwise null. */
  get problem(): string | null {
    return this.values.problem as string | null
  }

  set problem(value: string | null) {
    this.update({ problem: value })
  }

  get faults(): string[] {
    return [...(this.values.faults as string[])]
  }

  set faults(value: string[]) {
    this.update({ faults: [...value] })
  }

  // Running

  /** Connects to the hub at url (ws://host:port) and keeps both channels up until the device is
   * replaced (CONN-8), refused, or close() is called. */
  async run(url: string): Promise<void> {
    const base = url.replace(/\/$/, '')
    this.finished = false
    const loops = [this.commandLoop(`${base}/ws/mhs`)]
    if (this.needsNerve()) loops.push(this.nerveLoop(`${base}/ws/nerve`))
    if (this.options.manual) this.timers.push(setInterval(() => this.deadman(), 50))
    await loops[0]
    this.finished = true
    this.nerve?.close()
    await Promise.all(loops)
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
  }

  /** Disconnects for good, for example when a page unloads. */
  close(): void {
    this.finished = true
    this.cmd?.close()
    this.nerve?.close()
  }

  private needsNerve(): boolean {
    const clip = [...this.tools.values()].some(
      (t) => 'clip' in (((t.decl.inputSchema as Json).properties as Json) ?? {}),
    )
    return this.sources.size > 0 || this.options.manual !== undefined || clip
  }

  private async commandLoop(url: string): Promise<void> {
    let delay = 500
    while (!this.finished) {
      const { code, registered, refused } = await this.commandConnection(url)
      await this.commandLost()
      if (refused || code === CLOSE_REPLACED || code === CLOSE_BAD_VERSION) {
        this.log(
          `${this.id}: ${refused ? 'registration refused' : code === CLOSE_REPLACED ? 'replaced' : 'version refused'}; not reconnecting`,
        )
        return
      }
      if (registered) delay = 500
      if (this.finished) return
      await sleep(delay)
      delay = Math.min(delay * 2, 5000)
    }
  }

  private commandConnection(url: string): Promise<{ code: number; registered: boolean; refused: boolean }> {
    return new Promise((resolve) => {
      let registered = false
      let refused = false
      let ws: WebSocket
      try {
        ws = new WebSocket(url, SUBPROTOCOL)
      } catch {
        resolve({ code: 1006, registered, refused })
        return
      }
      ws.onopen = () => {
        this.generation += 1
        ws.send(
          JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'mhs/register', params: this.description() }),
        )
      }
      ws.onmessage = (event) => {
        let msg: Json
        try {
          msg = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (!registered) {
          if (msg.id === '1' && msg.method === undefined) {
            const error = msg.error as Json | undefined
            if (error) {
              refused = error.code === -32001 || error.code === -32602
              this.log(`${this.id}: registration failed: ${String(error.message)}`)
              ws.close()
              return
            }
            registered = true
            this.cmd = ws
            this.log(`${this.id}: registered`)
            this.sendFullState()
            this.keepAlive(ws)
            return
          }
          // Before registration completes, only stop is answered (CONN-3, CTL-2).
          if (msg.method === 'mhs/stop') {
            void Promise.resolve(this.onStop?.()).then(() =>
              ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopped: [] } })),
            )
          }
          return
        }
        if (msg.method === undefined) this.pong?.(msg.id)
        else this.onCommand(msg)
      }
      ws.onclose = (event) => resolve({ code: event.code, registered, refused })
      ws.onerror = () => undefined
    })
  }

  /** STATE-1: every declared field and both standard fields, right after registration. */
  private sendFullState(): void {
    const values: Json = {}
    for (const [name, value] of Object.entries(this.values)) if (value !== undefined) values[name] = value
    const missing = Object.keys(this.options.state ?? {}).filter((name) => !(name in values))
    if (missing.length) this.log(`${this.id}: state fields without a value yet: ${missing.join(', ')}`)
    this.sendCommand({ jsonrpc: '2.0', method: 'mhs/state', params: { t: Date.now() / 1000, values } })
  }

  /** CONN-9: mhs/ping every 2 s; no reply within 3 s means both channels are lost. */
  private keepAlive(ws: WebSocket): void {
    let next = 0
    let sent = -Infinity
    let waiting: string | undefined
    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return clearInterval(timer)
      const now = performance.now()
      if (waiting && now - sent > PING_LOST) {
        clearInterval(timer)
        this.log(`${this.id}: no reply to mhs/ping; reconnecting`)
        ws.close()
        this.nerve?.close()
        return
      }
      if (waiting || now - sent < PING_EVERY) return
      next += 1
      waiting = `ping${next}`
      sent = now
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: waiting, method: 'mhs/ping', params: {} }))
    }, 250)
    this.pong = (id) => {
      if (id === waiting) waiting = undefined
    }
  }

  /** SAFE-2: stop all motion and end every call; their results cannot be sent any more. */
  private async commandLost(): Promise<void> {
    this.cmd = undefined
    if (this.calls.size === 0) return
    await this.halt()
    for (const call of this.calls.values()) call.interrupt('disconnect')
  }

  private async halt(): Promise<void> {
    try {
      await this.onStop?.()
    } catch (e) {
      this.log(`${this.id}: onStop failed: ${String(e)}`)
    }
  }

  private sendCommand(message: Json): void {
    if (this.cmd?.readyState === WebSocket.OPEN) this.cmd.send(JSON.stringify(message))
  }

  private reply(id: unknown, result: Json): void {
    this.sendCommand({ jsonrpc: '2.0', id, result })
  }

  /** Sends a call's notification on the connection the call came from, if it is still open. */
  notify(call: Call, method: string, params: Json): void {
    if (call.generation === this.generation) this.sendCommand({ jsonrpc: '2.0', method, params })
  }

  private onCommand(msg: Json): void {
    const method = msg.method
    const id = msg.id
    const params = (msg.params as Json | undefined) ?? {}
    if (typeof method !== 'string' || id === undefined) return
    const handlers: Record<string, (id: unknown, params: Json) => Promise<void>> = {
      'mhs/call': (i, p) => this.onCall(i, p),
      'mhs/cancel': (i, p) => this.onCancel(i, p),
      'mhs/stop': (i) => this.onStopRequest(i),
      'mhs/pause': (i, p) => this.onPause(i, p),
      'mhs/resume': (i, p) => this.onResume(i, p),
      'mhs/configure': (i, p) => this.onConfigure(i, p),
      'mhs/keyframe': (i, p) => this.onKeyframe(i, p),
      'mhs/time': async (i) => this.reply(i, { t: Date.now() / 1000 }),
      'mhs/set': (i, p) => this.onSetRequest(i, p),
    }
    const handler = handlers[method]
    if (!handler) {
      this.sendCommand({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } })
      return
    }
    void handler(id, params)
  }

  // Calls (7, 8)

  private async onCall(id: unknown, params: Json): Promise<void> {
    const reject = (reason: string, detail: string, holder?: Json) => {
      const result: Json = { accepted: false, status: 'rejected', reason, detail }
      if (holder) result.holder = holder
      this.reply(id, result)
    }
    const name = params.name
    const tool = typeof name === 'string' ? this.tools.get(name) : undefined
    if (!tool) return reject('invalid', `no tool ${String(name)}`)
    // biome-ignore lint/suspicious/noExplicitAny: the declaration is the tool's own InputSchema
    const prepared = prepareArguments(tool.decl.inputSchema as any, params.arguments ?? {})
    if (!prepared.ok) return reject('invalid', prepared.detail)
    const reason = this.unsafe?.(name as string)
    if (reason) return reject('unsafe', reason)
    for (const resource of (tool.decl.uses as string[] | undefined) ?? []) {
      const holder = this.holders.get(resource)
      if (holder && this.options.resources?.[resource] === 'reject') {
        const what = holder.manual ? 'manual control' : `${holder.tool} (${holder.call})`
        return reject('busy', `${resource} held by ${what}`, holder)
      }
    }
    const call = new Call(this, String(id), name as string, prepared.args, tool.decl)
    call.notes = prepared.notes
    this.calls.set(call.id, call)
    this.reply(id, { accepted: true })
    void this.runCall(call, tool)
  }

  private async runCall(call: Call, tool: Tool): Promise<void> {
    const held: string[] = []
    let outcome: Json
    try {
      for (const resource of call.uses) {
        while (this.holders.has(resource)) {
          await Promise.race([
            new Promise<void>((resolve) => this.releaseWaiters.push(resolve)),
            call.aborted(),
          ])
          if (call.signal.aborted) throw new Interrupted()
        }
        this.holders.set(resource, { call: call.id, tool: call.name })
        held.push(resource)
      }
      // The result goes out as soon as the call is interrupted; the handler stops at its next
      // checkpoint or sleep.
      const running = Promise.resolve(tool.handler(call, call.args))
      running.catch(() => undefined)
      const value = await Promise.race([
        running,
        call.aborted().then(() => Promise.reject(new Interrupted())),
      ])
      outcome = { status: 'done', detail: `${call.name} done` }
      if (typeof value === 'string') outcome.detail = value
      else if (value && typeof value === 'object') {
        for (const key of ['detail', 'data', 'notes'] as const)
          if (value[key] !== undefined) outcome[key] = value[key]
      }
    } catch (e) {
      if (e instanceof Interrupted || call.signal.aborted) {
        const reason = call.endReason ?? 'cancel'
        outcome = { status: 'interrupted', reason, detail: `${call.name} interrupted (${reason})` }
      } else if (e instanceof CallError) {
        outcome = { status: e.status, reason: e.reason, detail: e.detail }
        if (e.data) outcome.data = e.data
      } else {
        this.log(`${this.id}: tool ${call.name} failed: ${String(e)}`)
        outcome = { status: 'error', reason: 'failed', detail: `${call.name} failed: ${String(e)}` }
      }
    } finally {
      for (const resource of held)
        if (this.holders.get(resource)?.call === call.id) this.holders.delete(resource)
      this.wakeWaiters()
      this.calls.delete(call.id)
    }
    const notes = [...call.notes, ...((outcome.notes as string[] | undefined) ?? [])]
    if (notes.length) outcome.notes = notes
    if (this.after) {
      try {
        outcome.after = this.after()
      } catch (e) {
        this.log(`${this.id}: after failed: ${String(e)}`)
      }
    }
    this.notify(call, 'mhs/result', { call: call.id, ...outcome })
  }

  private wakeWaiters(): void {
    const waiters = this.releaseWaiters
    this.releaseWaiters = []
    for (const wake of waiters) wake()
  }

  private async onCancel(id: unknown, params: Json): Promise<void> {
    const call = this.calls.get(String(params.call))
    call?.interrupt('cancel')
    this.reply(id, { cancelled: call !== undefined })
  }

  /** CTL-3: zero motion first, then interrupt every motion call, then reply. */
  private async onStopRequest(id: unknown): Promise<void> {
    await this.halt()
    const stopped = [...this.calls.values()].filter((c) => c.motion)
    for (const call of stopped) call.interrupt('stop')
    this.reply(id, { stopped: stopped.map((c) => c.id) })
  }

  private async onPause(id: unknown, params: Json): Promise<void> {
    const call = this.calls.get(String(params.call))
    if (!call?.pausable || call.paused) return this.reply(id, { paused: false })
    const atRest = await call.requestPause()
    if (!atRest) {
      call.release()
      return this.reply(id, { paused: false })
    }
    this.reply(id, { paused: true })
    this.notify(call, 'mhs/progress', { call: call.id, state: 'paused' })
  }

  private async onResume(id: unknown, params: Json): Promise<void> {
    const call = this.calls.get(String(params.call))
    if (!call?.paused) return this.reply(id, { resumed: false })
    call.release()
    this.reply(id, { resumed: true })
    this.notify(call, 'mhs/progress', { call: call.id, state: 'running' })
  }

  /** STATE-3: only writable fields, checked and clamped like arguments; STATE-4: never moves. */
  private async onSetRequest(id: unknown, params: Json): Promise<void> {
    const applied: Json = {}
    const notes: string[] = []
    const refused: Record<string, string> = {}
    for (const [name, value] of Object.entries((params.values as Json | undefined) ?? {})) {
      const decl = this.options.state?.[name]
      if (!decl?.writable) {
        refused[name] = decl ? 'not writable' : 'not a state field'
        continue
      }
      const param: Json = { type: decl.type }
      if (decl.min !== undefined) param.minimum = decl.min
      if (decl.max !== undefined) param.maximum = decl.max
      if (decl.enum !== undefined) param.enum = decl.enum
      // biome-ignore lint/suspicious/noExplicitAny: a one-field schema built from the declaration
      const prepared = prepareArguments(
        { type: 'object', properties: { [name]: param }, required: [name] } as any,
        {
          [name]: value,
        },
      )
      if (!prepared.ok) {
        refused[name] = prepared.detail
        continue
      }
      let next = prepared.args[name]
      try {
        const result = await this.onSet?.(name, next)
        if (result !== undefined) next = result
      } catch (e) {
        refused[name] = `could not apply: ${String(e)}`
        continue
      }
      applied[name] = next
      notes.push(...prepared.notes)
    }
    const reply: Json = { values: applied }
    if (notes.length) reply.notes = notes
    if (Object.keys(refused).length) reply.refused = refused
    this.reply(id, reply)
    if (Object.keys(applied).length) this.update(applied)
  }

  // Streams (MOS)

  private async onConfigure(id: unknown, params: Json): Promise<void> {
    const applied: Json = {}
    for (const [sourceId, setting] of Object.entries((params.sources as Json | undefined) ?? {})) {
      const source = this.sources.get(sourceId)
      if (!source || typeof setting !== 'object' || setting === null) continue
      applied[sourceId] = source.configure(setting as Json)
      try {
        await source.onConfigure?.(applied[sourceId] as Json)
      } catch (e) {
        this.log(`${this.id}: onConfigure of ${sourceId} failed: ${String(e)}`)
      }
    }
    this.reply(id, { sources: applied })
  }

  private async onKeyframe(id: unknown, params: Json): Promise<void> {
    const asked = ((params.sources as string[] | undefined) ?? []).filter(
      (s) => this.sources.get(s)?.kind === 'video',
    )
    for (const sourceId of asked) {
      const source = this.sources.get(sourceId)
      if (source) source.keyframeRequested = true
    }
    this.reply(id, { sources: asked })
  }

  /** Puts a message in the outbox; true if it replaced an unsent one (a drop). */
  queue(source: Source, msg: Json, binary: Uint8Array | undefined): boolean {
    const dropped = this.outbox.delete(source.id)
    if (this.nerve?.readyState !== WebSocket.OPEN) return true
    this.outbox.set(source.id, [msg, binary])
    this.scheduleFlush()
    return dropped
  }

  private scheduleFlush(): void {
    if (this.flushTimer === undefined) this.flushTimer = setTimeout(() => this.flush(), 0)
  }

  /** Sends the newest message of each source while the socket keeps up. */
  private flush(): void {
    this.flushTimer = undefined
    const ws = this.nerve
    if (ws?.readyState !== WebSocket.OPEN) return
    for (const [sourceId, [msg, binary]] of this.outbox) {
      if (ws.bufferedAmount > BACKLOG) {
        this.flushTimer = setTimeout(() => this.flush(), 10)
        return
      }
      this.outbox.delete(sourceId)
      ws.send(JSON.stringify(msg))
      if (binary) ws.send(binary as Uint8Array<ArrayBuffer>)
    }
  }

  private async nerveLoop(url: string): Promise<void> {
    let delay = 500
    while (!this.finished) {
      const code = await new Promise<number>((resolve) => {
        let ws: WebSocket
        try {
          ws = new WebSocket(url, SUBPROTOCOL)
        } catch {
          resolve(1006)
          return
        }
        ws.binaryType = 'arraybuffer'
        let pendingClip: Json | undefined
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'hello', device: this.id }))
          this.nerve = ws
          delay = 500
          this.scheduleFlush()
        }
        ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            if (pendingClip) this.keepClip(pendingClip, new Uint8Array(event.data))
            pendingClip = undefined
            return
          }
          let msg: Json
          try {
            msg = JSON.parse(String(event.data))
          } catch {
            return
          }
          if (msg.type === 'manual') void this.onManualInput((msg.axes as Json | undefined) ?? {})
          else if (msg.type === 'clip') pendingClip = msg
        }
        ws.onclose = (event) => resolve(event.code)
        ws.onerror = () => undefined
      })
      this.nerve = undefined
      if (code === CLOSE_REPLACED || this.finished) return
      await sleep(delay)
      delay = Math.min(delay * 2, 5000)
    }
  }

  private keepClip(msg: Json, pcm: Uint8Array): void {
    this.clips.set(String(msg.id), {
      rate: Number(msg.rate),
      channels: Number(msg.channels ?? 1),
      pcm,
      received: Date.now() / 1000,
    })
    while (this.clips.size > CLIPS_KEPT) this.clips.delete(this.clips.keys().next().value as string)
  }

  // Manual control (9)

  private async onManualInput(axes: Json): Promise<void> {
    const manual = this.options.manual
    if (!manual) return
    const values: Record<string, number> = {}
    for (const axis of manual.axes) {
      const v = axes[axis.id]
      values[axis.id] = Math.max(
        axis.min,
        Math.min(axis.max, typeof v === 'number' && Number.isFinite(v) ? v : 0),
      ) // MAN-1, MAN-2
    }
    const now = performance.now()
    this.manualLast = now
    if (Object.values(values).some((v) => v !== 0)) {
      this.manualNonzero = now
      this.manualMoving = true
      for (const call of this.calls.values()) if (call.motion) call.interrupt('manual') // MAN-3
      for (const resource of this.motionResources()) this.holders.set(resource, { manual: true })
    }
    await this.onManual?.(values)
  }

  private motionResources(): Set<string> {
    const out = new Set<string>()
    for (const tool of this.tools.values())
      if (tool.decl.motion) for (const r of (tool.decl.uses as string[] | undefined) ?? []) out.add(r)
    return out
  }

  /** MAN-4: no manual message for deadman_s stops manual motion; holds end deadman_s after the
   * last non-zero input. */
  private deadman(): void {
    const manual = this.options.manual
    if (!manual) return
    const deadman = manual.deadman_s * 1000
    const now = performance.now()
    if (this.manualMoving && now - this.manualLast > deadman) {
      this.manualMoving = false
      void this.onManual?.(Object.fromEntries(manual.axes.map((a) => [a.id, 0])))
    }
    const held = [...this.holders].filter(([, h]) => h.manual).map(([r]) => r)
    if (held.length && now - this.manualNonzero > deadman) {
      for (const resource of held) this.holders.delete(resource)
      this.wakeWaiters()
    }
  }
}
