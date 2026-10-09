import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { type RawData, type WebSocket, WebSocketServer } from 'ws'
import type {
  CallReply,
  CancelResult,
  ConfigureResult,
  Field,
  Holder,
  KeyframeResult,
  NerveData,
  PauseResult,
  ProgressParams,
  RegisterParams,
  ResultParams,
  ResumeResult,
  SetResult,
  SourceSetting,
  StateParams,
  StopResult,
  TimeResult,
  Tool,
} from '../gen/ts/mhs-v1.js'
import { prepareArguments } from './args.js'
import { problems, registerProblems } from './checks.js'

export const PROTOCOL = 'mhs/v1'
export const SUBPROTOCOL = 'mhs.v1'
export const COMMAND_PATH = '/ws/mhs'
export const NERVE_PATH = '/ws/nerve'
const MAX_COMMAND_BYTES = 64 * 1024
const MAX_NERVE_TEXT_BYTES = 1024 * 1024
const MAX_NERVE_BINARY_BYTES = 16 * 1024 * 1024

/** Close codes of spec 4.5. */
export const CLOSE = { replaced: 4001, badFirstMessage: 4002, badVersion: 4003 } as const

/** Limits of spec 4.4 and 11, in milliseconds. Tests shorten them. */
export interface Timing {
  /** Acceptance of a call (CALL-2). */
  accept: number
  /** Added to a tool's timeout before the hub gives up on its result. */
  grace: number
  /** Replies to cancel, stop, pause, resume, configure and keyframe (CTL-4). */
  control: number
  /** Interval between WebSocket pings. */
  ping: number
  /** How long a ping may go without a pong before the channel counts as lost (CONN-5). */
  pong: number
  /** Reply to mhs/time (TIME-2). */
  time: number
  /** Interval between clock synchronizations. */
  sync: number
}
const TIMING: Timing = {
  accept: 2000,
  grace: 5000,
  control: 2000,
  ping: 2000,
  pong: 3000,
  time: 500,
  sync: 60_000,
}

export interface SouthOptions {
  name?: string
  version?: string
  timing?: Partial<Timing>
  log?: (line: string) => void
  /** Sees every text message on both channels in both directions, for recording a session. */
  tap?: (device: string, text: string) => void
}

/** How a call ended: the device's result, or a rejection by the device or the hub. */
export type Outcome =
  | ResultParams
  | { call: string; status: 'rejected'; reason: string; detail?: string; holder?: Holder }

export interface CallHandle {
  /** The call id, also the JSON-RPC id of the request; empty when the hub rejected the call itself. */
  id: string
  /** The device's acceptance or rejection, or the hub's own rejection. */
  reply: Promise<CallReply>
  /** Exactly one outcome per call. */
  done: Promise<Outcome>
}

export interface CallOptions {
  meta?: Record<string, unknown>
  onProgress?: (progress: ProgressParams) => void
}

export interface DeviceInfo {
  id: string
  session: string
  since: number
  description: RegisterParams
  /** Registered, with the Nerve channel open if the device needs one (spec 4.3). */
  available: boolean
}

/** The latest message of a source, with its binary payload if it has one. */
export interface Latest {
  msg: NerveData
  binary?: Buffer
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface CallState {
  id: string
  tool: Tool
  notes: string[]
  onProgress: ((progress: ProgressParams) => void) | undefined
  resolveDone: (outcome: Outcome) => void
  /** Set once done has resolved, by the device's result or by the hub giving up. */
  settled: boolean
  timers: NodeJS.Timeout[]
}

type Json = Record<string, unknown>

const CONTROL_RESULTS: Record<
  string,
  'CancelResult' | 'StopResult' | 'PauseResult' | 'ResumeResult' | 'SetResult'
> = {
  'mhs/set': 'SetResult',
  'mhs/cancel': 'CancelResult',
  'mhs/stop': 'StopResult',
  'mhs/pause': 'PauseResult',
  'mhs/resume': 'ResumeResult',
}

/** The definition that checks a data payload of this kind (spec Appendix B.1). */
export function dataDef(kind: string): string | undefined {
  if (kind.startsWith('x_')) return 'CustomData'
  const known = ['image', 'video', 'scan', 'points', 'audio', 'imu', 'odometry', 'gnss', 'values', 'switch']
  const derived = ['text', 'detections', 'pose', 'grid', 'transcript', 'world']
  return [...known, ...derived].includes(kind) ? `${kind[0]?.toUpperCase()}${kind.slice(1)}Data` : undefined
}

/** PER-1: each value of a values or switch message has its field's declared type and enum. */
export function fieldProblems(fields: Record<string, Field>, data: Record<string, unknown>): string[] {
  const found: string[] = []
  for (const [name, value] of Object.entries(data)) {
    const field = fields[name]
    if (!field) {
      found.push(`${name} is not a declared field`)
      continue
    }
    const ok =
      field.type === 'integer'
        ? Number.isInteger(value)
        : field.type === 'number'
          ? typeof value === 'number'
          : typeof value === field.type
    if (!ok) found.push(`${name} must be ${field.type}`)
    else if (field.enum && !field.enum.includes(value as string))
      found.push(`${name} must be one of ${field.enum.join(', ')}`)
  }
  return found
}

/** Whether a device must open the Nerve channel: it has sources, manual control or clip tools (MHS 4.3). */
function needsNerve(d: RegisterParams): boolean {
  const clip = (d.tools ?? []).some((t) => 'clip' in (t.inputSchema.properties ?? {}))
  return (d.sources ?? []).length > 0 || d.manual !== undefined || clip
}

export type AlertLevel = 'ok' | 'warn' | 'bad'

/** Where a value stands against its field's declared alert levels (MOS 3.3). */
export function alertLevel(field: Field, value: unknown): AlertLevel {
  const alert = field.alert
  if (!alert || typeof value !== 'number') return 'ok'
  const past = (limit: number | undefined) =>
    limit !== undefined && (alert.below ? value <= limit : value >= limit)
  return past(alert.bad) ? 'bad' : past(alert.warn) ? 'warn' : 'ok'
}

/** A device's state as the hub keeps it (MHS 10.1): values, when each changed (hub clock), alert levels. */
export interface DeviceState {
  values: Record<string, unknown>
  updated: Record<string, number>
  levels: Record<string, AlertLevel>
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

/** One command channel: a device from the moment it connects until the channel closes. */
class Session {
  description: RegisterParams | undefined
  since = 0
  readonly calls = new Map<string, CallState>()
  readonly pending = new Map<string, Pending>()
  private next = 0

  /** Device clock minus hub clock, in seconds, from mhs/time (14.7). */
  offset: number | undefined
  /** Round trip of the best mhs/time sample, in seconds. */
  rtt: number | undefined
  syncTimer: NodeJS.Timeout | undefined

  constructor(
    readonly ws: WebSocket,
    readonly session: string,
    private readonly tap: ((device: string, text: string) => void) | undefined,
  ) {}

  get id(): string {
    return this.description?.device.id ?? '?'
  }

  newId(prefix: string): string {
    this.next += 1
    return `${prefix}${this.next}`
  }

  send(message: Json): void {
    if (this.ws.readyState !== this.ws.OPEN) return
    const text = JSON.stringify(message)
    this.tap?.(this.id, text)
    this.ws.send(text)
  }
}

/** One Nerve channel (spec 14.1). */
class Nerve {
  device: string | undefined
  /** A data message announced a binary frame (STR-3); the next frame must be it. */
  awaiting: NerveData | undefined
  readonly warned = new Set<string>()
  readonly latest = new Map<string, Latest>()

  constructor(readonly ws: WebSocket) {}
}

/**
 * The southbound side of a hub: accepts devices on the command and Nerve channels (spec 4, 5, 14),
 * forwards calls and control to them (7, 8), receives their data and enforces the hub's timeouts
 * (11). It knows nothing about clients; whoever embeds it calls its methods and listens to its events.
 *
 * Events: `online` (DeviceInfo) when a device becomes available, `offline` (id, reason) when it stops
 * being available, `progress` (device id, ProgressParams), `data` (device id, NerveData, binary or
 * undefined), `state` (device id, the changed values), `alert` (device id, field, AlertLevel, value)
 * when a state field crosses a declared alert level.
 */
export class South extends EventEmitter {
  private readonly timing: Timing
  private readonly wss: WebSocketServer
  private readonly nerveWss: WebSocketServer
  private readonly devicesById = new Map<string, Session>()
  private readonly nerves = new Map<string, Nerve>()
  private readonly available = new Set<string>()
  /** Kept after a device goes away, so its last known state can still be read. */
  private readonly states = new Map<string, DeviceState>()
  private readonly log: (line: string) => void
  private server: Server | undefined
  private sessions = 0

  constructor(private readonly options: SouthOptions = {}) {
    super()
    this.timing = { ...TIMING, ...options.timing }
    this.log = options.log ?? (() => undefined)
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_COMMAND_BYTES,
      handleProtocols: (offered) => (offered.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    })
    this.wss.on('connection', (ws) => this.accept(ws))
    this.nerveWss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_NERVE_BINARY_BYTES,
      handleProtocols: (offered) => (offered.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    })
    this.nerveWss.on('connection', (ws) => this.acceptNerve(ws))
  }

  /** Takes a WebSocket upgrade if its path is a hub channel; returns false otherwise. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = new URL(req.url ?? '/', 'http://hub').pathname
    const wss = path === COMMAND_PATH ? this.wss : path === NERVE_PATH ? this.nerveWss : undefined
    if (!wss) return false
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    return true
  }

  /**
   * Listens on its own HTTP server; useful when nothing else owns the port. `more` takes other
   * WebSocket paths on the same port, such as AgnesHub's /ws/hub; `request` answers plain HTTP
   * requests, which otherwise get 404.
   */
  async listen(
    port: number,
    host = '127.0.0.1',
    more?: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean,
    request: RequestListener = (_, res) => res.writeHead(404).end(),
  ): Promise<AddressInfo> {
    const server = createServer(request)
    server.on('upgrade', (req, socket, head) => {
      if (!this.handleUpgrade(req, socket, head) && !more?.(req, socket, head)) socket.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, resolve)
    })
    this.server = server
    return server.address() as AddressInfo
  }

  async close(): Promise<void> {
    for (const ws of [...this.wss.clients, ...this.nerveWss.clients]) ws.terminate()
    this.wss.close()
    this.nerveWss.close()
    const server = this.server
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  devices(): DeviceInfo[] {
    return [...this.devicesById.values()].map((s) => this.info(s))
  }

  /** The latest message of a source, if any arrived on the current Nerve channel. */
  latest(device: string, source: string): Latest | undefined {
    return this.nerves.get(device)?.latest.get(source)
  }

  /** A device's state (MHS 10.1), the last known one if the device is gone. */
  state(device: string): DeviceState | undefined {
    return this.states.get(device)
  }

  /**
   * Changes writable state fields (MHS 10.1). Fields that are unknown, not writable or of the wrong
   * type are refused here; the device clamps the rest and replies with the values in effect.
   */
  async set(device: string, values: Record<string, unknown>): Promise<SetResult> {
    const fields = (this.devicesById.get(device)?.description?.state ?? {}) as Record<
      string,
      Field & { writable?: boolean }
    >
    const refused: Record<string, string> = {}
    const send: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(values)) {
      const field = fields[name]
      const wrong = field ? fieldProblems({ [name]: field }, { [name]: value }) : []
      if (!field) refused[name] = 'not a state field'
      else if (!field.writable) refused[name] = 'not writable'
      else if (wrong.length > 0) refused[name] = wrong[0] as string
      else send[name] = value
    }
    if (Object.keys(send).length === 0) return { values: {}, refused }
    const result = (await this.control(device, 'mhs/set', { values: send }, false)) as SetResult
    const all = { ...refused, ...(result.refused ?? {}) }
    return Object.keys(all).length > 0 ? { ...result, refused: all } : result
  }

  /** The round trip to a device from its last clock synchronization, in seconds. */
  rtt(device: string): number | undefined {
    return this.devicesById.get(device)?.rtt
  }

  /** A device time in hub time, using the offset from mhs/time; unchanged before the first sync. */
  hubTime(device: string, t: number): number {
    return t - (this.devicesById.get(device)?.offset ?? 0)
  }

  /** Sets which sources stream and how (14.5); resolves with what the device applied (STR-4). */
  configure(device: string, sources: Record<string, SourceSetting>): Promise<ConfigureResult> {
    return this.control(device, 'mhs/configure', { sources }, false) as Promise<ConfigureResult>
  }

  /** Asks for a keyframe of each video source (14.4). */
  keyframe(device: string, sources: string[]): Promise<KeyframeResult> {
    return this.control(device, 'mhs/keyframe', { sources }, false) as Promise<KeyframeResult>
  }

  /**
   * Measures the device clock (14.7) three times and keeps the sample with the shortest round trip.
   * Returns the offset (device minus hub) and that round trip, in seconds.
   */
  async syncClock(device: string): Promise<{ offset: number; rtt: number }> {
    const s = this.devicesById.get(device)
    if (!s) throw new Error(`${device} is not connected`)
    let best: { offset: number; rtt: number } | undefined
    for (let i = 0; i < 3; i++) {
      const sent = Date.now() / 1000
      const raw = await this.request(s, s.newId('t'), 'mhs/time', {}, this.timing.time).catch(() => undefined)
      const received = Date.now() / 1000
      if (raw === undefined || problems('TimeResult', raw).length > 0) continue
      const sample = { offset: (raw as TimeResult).t - (sent + received) / 2, rtt: received - sent }
      if (!best || sample.rtt < best.rtt) best = sample
    }
    if (!best) throw new Error(`${device} did not answer mhs/time`)
    s.offset = best.offset
    s.rtt = best.rtt
    return best
  }

  /** Sends manual input on the Nerve channel (9); false if the channel is not open. */
  manual(device: string, axes: Record<string, number>): boolean {
    return this.sendNerve(device, { type: 'manual', axes })
  }

  /** Sends an audio clip, 16-bit little-endian PCM (14.8); false if the channel is not open. */
  clip(device: string, id: string, rate: number, channels: number, pcm: Buffer): boolean {
    if (!this.sendNerve(device, { type: 'clip', id, rate, channels })) return false
    this.nerves.get(device)?.ws.send(pcm)
    return true
  }

  /** Calls a tool (spec 7). Arguments are validated and clamped first (6.4). */
  call(device: string, name: string, args: unknown, options: CallOptions = {}): CallHandle {
    const s = this.devicesById.get(device)
    if (!s?.description) return rejectedByHub('offline', `${device} is not connected`)
    const tool = s.description.tools?.find((t) => t.name === name)
    if (!tool) return rejectedByHub('invalid', `${device} has no tool ${name}`)
    const prepared = prepareArguments(tool.inputSchema, args)
    if (!prepared.ok) return rejectedByHub('invalid', prepared.detail)

    const id = s.newId('c')
    let resolveReply: (reply: CallReply) => void = () => undefined
    let resolveDone: (outcome: Outcome) => void = () => undefined
    const reply = new Promise<CallReply>((r) => {
      resolveReply = r
    })
    const done = new Promise<Outcome>((r) => {
      resolveDone = r
    })
    const state: CallState = {
      id,
      tool,
      notes: prepared.notes,
      onProgress: options.onProgress,
      resolveDone,
      settled: false,
      timers: [],
    }
    s.calls.set(id, state)
    const params: Json = { name, arguments: prepared.args }
    if (options.meta) params.meta = options.meta
    this.request(s, id, 'mhs/call', params, this.timing.accept)
      .then((raw) => {
        const found = problems('CallReply', raw)
        if (found.length > 0) {
          this.log(`${s.id}: invalid reply to ${id}: ${found.join('; ')}`)
          resolveReply({
            accepted: false,
            status: 'rejected',
            reason: 'invalid',
            detail: 'the device sent an invalid reply',
          })
          this.finish(s, state, error(id, 'failed', 'the device sent an invalid reply to the call'))
          this.sendControl(s, 'mhs/cancel', { call: id })
          return
        }
        const r = raw as CallReply
        resolveReply(r)
        if (!r.accepted) {
          const rejected: Outcome = { call: id, status: 'rejected', reason: r.reason }
          if (r.detail !== undefined) rejected.detail = r.detail
          if ('holder' in r) rejected.holder = r.holder
          this.finish(s, state, rejected, true)
          return
        }
        // Spec 11: the tool's timeout plus grace, then cancel, then stop.
        state.timers.push(
          setTimeout(
            () => {
              this.finish(s, state, error(id, 'timeout', `${name} did not finish within ${tool.timeout} s`))
              this.sendControl(s, 'mhs/cancel', { call: id })
              state.timers.push(
                setTimeout(() => {
                  if (s.calls.has(id)) this.sendControl(s, 'mhs/stop', {})
                }, this.timing.control),
              )
            },
            tool.timeout * 1000 + this.timing.grace,
          ),
        )
      })
      .catch((e: Error) => {
        // No acceptance in time (CALL-2): stop the device, record a timeout.
        const detail = s.ws.readyState === s.ws.OPEN ? `${name} was not accepted in time` : e.message
        resolveReply({ accepted: false, status: 'rejected', reason: 'offline', detail })
        if (s.ws.readyState === s.ws.OPEN) this.sendControl(s, 'mhs/stop', {})
        this.finish(s, state, error(id, 'timeout', detail), true)
      })
    return { id, reply, done }
  }

  cancel(device: string, call: string): Promise<CancelResult> {
    return this.control(device, 'mhs/cancel', { call }, true) as Promise<CancelResult>
  }

  /** Stops every motion of a device (8.2). Calls that are not motion continue. */
  stop(device: string): Promise<StopResult> {
    return this.control(device, 'mhs/stop', {}, true) as Promise<StopResult>
  }

  pause(device: string, call: string): Promise<PauseResult> {
    return this.control(device, 'mhs/pause', { call }, false).catch(() => ({
      paused: false,
    })) as Promise<PauseResult>
  }

  resume(device: string, call: string): Promise<ResumeResult> {
    return this.control(device, 'mhs/resume', { call }, false).catch(() => ({
      resumed: false,
    })) as Promise<ResumeResult>
  }

  private info(s: Session): DeviceInfo {
    return {
      id: s.id,
      session: s.session,
      since: s.since,
      description: s.description as RegisterParams,
      available: this.available.has(s.id),
    }
  }

  /** Emits online or offline when a device's availability changes (spec 4.3). */
  private updateAvailability(id: string, reason = ''): void {
    const s = this.devicesById.get(id)
    const nerve = this.nerves.get(id)
    const now = s?.description !== undefined && (!needsNerve(s.description) || nerve !== undefined)
    if (now === this.available.has(id)) return
    if (now && s) {
      this.available.add(id)
      this.log(`${id}: available`)
      this.emit('online', this.info(s))
    } else {
      this.available.delete(id)
      this.log(`${id}: unavailable (${reason})`)
      this.emit('offline', id, reason)
    }
  }

  private sendNerve(device: string, message: Json): boolean {
    const nerve = this.nerves.get(device)
    if (!nerve || nerve.ws.readyState !== nerve.ws.OPEN) return false
    const text = JSON.stringify(message)
    this.options.tap?.(device, text)
    nerve.ws.send(text)
    return true
  }

  /**
   * A control request with the 2 s reply limit (spec 11). For cancel and stop, a device that does
   * not reply loses its command channel, so it stops by itself (SAFE-2).
   */
  private async control(
    device: string,
    method: string,
    params: Json,
    closeOnTimeout: boolean,
  ): Promise<unknown> {
    const s = this.devicesById.get(device)
    if (!s) throw new Error(`${device} is not connected`)
    const result = await this.request(s, s.newId('x'), method, params, this.timing.control).catch(
      (e: Error) => {
        if (closeOnTimeout && s.ws.readyState === s.ws.OPEN) {
          this.log(`${s.id}: no reply to ${method}; closing its command channel`)
          s.ws.close(1011, `no reply to ${method}`)
        }
        throw e
      },
    )
    const found = problems(CONTROL_RESULTS[method] ?? 'Empty', result)
    if (found.length > 0) throw new Error(`invalid reply to ${method}: ${found.join('; ')}`)
    return result
  }

  /** Fire and forget, for the hub's own follow-ups (cancel after a timeout, stop after no acceptance). */
  private sendControl(s: Session, method: string, params: Json): void {
    this.request(s, s.newId('x'), method, params, this.timing.control).catch(() => {
      if (s.ws.readyState === s.ws.OPEN && (method === 'mhs/stop' || method === 'mhs/cancel'))
        s.ws.close(1011)
    })
  }

  private request(s: Session, id: string, method: string, params: Json, timeout: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (s.ws.readyState !== s.ws.OPEN) return reject(new Error(`${s.id} is not connected`))
      const timer = setTimeout(() => {
        s.pending.delete(id)
        reject(new Error(`no reply to ${method} within ${timeout} ms`))
      }, timeout)
      s.pending.set(id, { resolve, reject, timer })
      s.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private finish(s: Session, state: CallState, outcome: Outcome, forget = false): void {
    if (!state.settled) {
      state.settled = true
      // The hub's own notes (clamped or defaulted arguments) come first.
      if (outcome.status !== 'rejected' && state.notes.length > 0)
        outcome.notes = [...state.notes, ...(outcome.notes ?? [])]
      state.resolveDone(outcome)
    }
    // A call the hub gave up on stays known until the device's result, so a later stop is only
    // sent while it may still be running.
    if (forget) {
      for (const t of state.timers) clearTimeout(t)
      s.calls.delete(state.id)
    }
  }

  private accept(ws: WebSocket): void {
    this.sessions += 1
    const s = new Session(ws, `s${this.sessions}`, this.options.tap)
    this.keepAlive(ws)
    ws.on('message', (data, isBinary) => this.onMessage(s, data, isBinary))
    ws.on('close', (code) => this.onClose(s, code))
    ws.on('error', (e) => this.log(`command channel error: ${e.message}`))
  }

  /** Pings every 2 s; a channel without a pong for 3 s is lost (spec 4.4, CONN-5). */
  private keepAlive(ws: WebSocket): void {
    let waitingSince = 0
    ws.on('pong', () => {
      waitingSince = 0
    })
    const timer = setInterval(
      () => {
        if (waitingSince && Date.now() - waitingSince > this.timing.pong) return ws.terminate()
        if (!waitingSince) {
          waitingSince = Date.now()
          ws.ping()
        }
      },
      Math.min(this.timing.ping, this.timing.pong / 2),
    )
    ws.on('close', () => clearInterval(timer))
  }

  private onMessage(s: Session, data: RawData, isBinary: boolean) {
    let msg: unknown
    try {
      if (isBinary) throw new RpcError(-32700, 'the command channel takes text frames only')
      const text = data.toString()
      if (s.description) this.options.tap?.(s.id, text)
      msg = JSON.parse(text)
    } catch (e) {
      s.send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: e instanceof RpcError ? e.message : 'not JSON' },
      })
      if (!s.description) s.ws.close(CLOSE.badFirstMessage)
      return
    }
    if (!isObject(msg) || msg.jsonrpc !== '2.0') {
      s.send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a JSON-RPC 2.0 message' } })
      if (!s.description) s.ws.close(CLOSE.badFirstMessage)
      return
    }
    if (!s.description) return this.onFirstMessage(s, msg)
    if (typeof msg.method === 'string') {
      // A device that cannot send WebSocket pings asks with mhs/ping instead (CONN-9).
      if (msg.method === 'mhs/ping' && 'id' in msg) return s.send({ jsonrpc: '2.0', id: msg.id, result: {} })
      if ('id' in msg) return s.send({ jsonrpc: '2.0', id: msg.id, error: methodError(msg.method) })
      return this.onNotification(s, msg.method, msg.params)
    }
    this.onResponse(s, msg)
  }

  /** The first message must be mhs/register (CONN-2). */
  private onFirstMessage(s: Session, msg: Json) {
    const fail = (code: number, message: string, close: number, data?: unknown) => {
      s.send({
        jsonrpc: '2.0',
        id: typeof msg.id === 'string' ? msg.id : null,
        error: { code, message, data },
      })
      this.log(`registration refused: ${message}`)
      s.ws.close(close)
    }
    if (msg.method !== 'mhs/register' || typeof msg.id !== 'string')
      return fail(-32600, 'the first message must be the request mhs/register', CLOSE.badFirstMessage)
    const params = msg.params
    if (isObject(params) && typeof params.protocol === 'string' && params.protocol !== PROTOCOL)
      return fail(
        -32001,
        `unsupported protocol version ${params.protocol}; this hub speaks ${PROTOCOL}`,
        CLOSE.badVersion,
      )
    const found = problems('RegisterParams', params)
    if (found.length === 0) found.push(...registerProblems(params as RegisterParams))
    if (found.length > 0)
      return fail(-32602, `invalid device description: ${found[0]}`, CLOSE.badFirstMessage, {
        problems: found,
      })

    s.description = params as RegisterParams
    s.since = Date.now() / 1000
    this.options.tap?.(s.id, JSON.stringify(msg))
    const old = this.devicesById.get(s.id)
    if (old) {
      this.log(`${s.id}: replaced by a newer connection`)
      this.dropDevice(old, 'replaced')
      old.ws.close(CLOSE.replaced, 'replaced by a newer connection with the same device id')
    }
    this.devicesById.set(s.id, s)
    // A new registration starts a fresh state; the device sends all of it next (STATE-1).
    this.states.set(s.id, { values: {}, updated: {}, levels: {} })
    s.send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        session: s.session,
        hub: { name: this.options.name ?? 'agnes-hub', version: this.options.version ?? '0.0.0' },
        time: Date.now() / 1000,
      },
    })
    this.log(`${s.id}: registered (${s.session})`)
    this.updateAvailability(s.id)
    const sync = () => this.syncClock(s.id).catch((e: Error) => this.log(`${s.id}: ${e.message}`))
    void sync()
    s.syncTimer = setInterval(sync, this.timing.sync)
  }

  private onNotification(s: Session, method: string, params: unknown) {
    if (method === 'mhs/state') return this.onState(s, params)
    if (method === 'mhs/progress') {
      const found = problems('ProgressParams', params)
      if (found.length > 0) return this.log(`${s.id}: invalid progress: ${found.join('; ')}`)
      const p = params as ProgressParams
      const state = s.calls.get(p.call)
      if (!state || state.settled) return
      state.onProgress?.(p)
      this.emit('progress', s.id, p)
      return
    }
    if (method === 'mhs/result') {
      const call = isObject(params) && typeof params.call === 'string' ? params.call : undefined
      const state = call === undefined ? undefined : s.calls.get(call)
      if (!state) return this.log(`${s.id}: result for unknown call ${call}`)
      const found = problems('ResultParams', params)
      const outcome =
        found.length === 0
          ? (params as ResultParams)
          : error(state.id, 'failed', 'the device sent an invalid result')
      if (found.length > 0) this.log(`${s.id}: invalid result: ${found.join('; ')}`)
      this.finish(s, state, outcome, true)
      return
    }
    this.log(`${s.id}: unknown notification ${method}`)
  }

  /** Merges a state change (STATE-2), checking each value against its declaration. */
  private onState(s: Session, params: unknown) {
    const found = problems('StateParams', params)
    if (found.length > 0) return this.log(`${s.id}: invalid state: ${found.join('; ')}`)
    const { t, values } = params as StateParams
    const fields = (s.description?.state ?? {}) as Record<string, Field>
    const state = this.states.get(s.id) ?? { values: {}, updated: {}, levels: {} }
    const changed: Record<string, unknown> = {}
    const wrong: string[] = []
    for (const [name, value] of Object.entries(values)) {
      const issue =
        name === 'problem'
          ? value === null || typeof value === 'string'
            ? undefined
            : 'problem must be a sentence or null'
          : name === 'faults'
            ? Array.isArray(value)
              ? undefined
              : 'faults must be a list'
            : fieldProblems(fields, { [name]: value })[0]
      if (issue) {
        wrong.push(issue)
        continue
      }
      changed[name] = value
      state.values[name] = value
      state.updated[name] = this.hubTime(s.id, t)
      const field = fields[name]
      if (!field) continue
      const level = alertLevel(field, value)
      if (level !== (state.levels[name] ?? 'ok')) this.emit('alert', s.id, name, level, value)
      state.levels[name] = level
    }
    this.states.set(s.id, state)
    if (wrong.length > 0) this.log(`${s.id}: state: ${wrong.join('; ')}`)
    if (Object.keys(changed).length > 0) this.emit('state', s.id, changed)
  }

  private onResponse(s: Session, msg: Json) {
    const id = typeof msg.id === 'string' ? msg.id : undefined
    const pending = id === undefined ? undefined : s.pending.get(id)
    if (!pending || id === undefined)
      return this.log(`${s.id}: response to unknown request ${String(msg.id)}`)
    s.pending.delete(id)
    clearTimeout(pending.timer)
    if (isObject(msg.error)) pending.reject(new Error(String(msg.error.message ?? 'error')))
    else pending.resolve(msg.result)
  }

  private onClose(s: Session, code: number): void {
    for (const p of s.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(`${s.id} disconnected`))
    }
    s.pending.clear()
    clearInterval(s.syncTimer)
    if (this.devicesById.get(s.id) === s) this.dropDevice(s, `command channel closed (${code})`)
  }

  /** A lost command channel interrupts every running call (spec 17.2). */
  private dropDevice(s: Session, reason: string): void {
    for (const state of [...s.calls.values()])
      this.finish(
        s,
        state,
        { call: state.id, status: 'interrupted', reason: 'disconnect', detail: `${s.id} disconnected` },
        true,
      )
    if (this.devicesById.get(s.id) === s) {
      this.devicesById.delete(s.id)
      this.updateAvailability(s.id, reason)
    }
  }

  private acceptNerve(ws: WebSocket): void {
    const n = new Nerve(ws)
    this.keepAlive(ws)
    ws.on('message', (data, isBinary) => this.onNerveMessage(n, data, isBinary))
    ws.on('close', () => {
      if (n.device === undefined || this.nerves.get(n.device) !== n) return
      this.nerves.delete(n.device)
      this.updateAvailability(n.device, 'Nerve channel closed')
    })
    ws.on('error', (e) => this.log(`Nerve channel error: ${e.message}`))
  }

  private onNerveMessage(n: Nerve, data: RawData, isBinary: boolean) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[])
    if (n.awaiting) {
      const msg = n.awaiting
      n.awaiting = undefined
      if (isBinary) return this.deliver(n, msg, bytes)
      this.warn(n, msg.source, `${msg.source}: the binary frame announced by bin did not follow (STR-3)`)
    }
    if (isBinary) return this.warn(n, 'binary', 'binary frame without a data message announcing it')
    if (bytes.length > MAX_NERVE_TEXT_BYTES) return n.ws.close(1009, 'text frame over 1 MiB (MSG-5)')
    let msg: unknown
    try {
      msg = JSON.parse(bytes.toString())
    } catch {
      return this.warn(n, 'json', 'a Nerve message that is not JSON')
    }
    if (n.device === undefined) return this.onHello(n, msg)
    this.options.tap?.(n.device, bytes.toString())
    const type = isObject(msg) ? msg.type : undefined
    if (type === 'data') return this.onData(n, msg as Json)
    this.warn(n, `type:${String(type)}`, `unknown Nerve message type ${String(type)}`)
  }

  /** The first Nerve message must be hello (CONN-4); a newer channel replaces an older one. */
  private onHello(n: Nerve, msg: unknown): void {
    if (problems('NerveHello', msg).length > 0) {
      this.log('Nerve channel refused: the first message must be hello')
      n.ws.close(CLOSE.badFirstMessage)
      return
    }
    const device = (msg as { device: string }).device
    n.device = device
    this.options.tap?.(device, JSON.stringify(msg))
    const old = this.nerves.get(device)
    this.nerves.set(device, n)
    if (old) old.ws.close(CLOSE.replaced, 'replaced by a newer connection with the same device id')
    this.log(`${device}: Nerve channel open`)
    this.updateAvailability(device)
  }

  private onData(n: Nerve, msg: Json) {
    const found = problems('NerveData', msg)
    if (found.length > 0) return this.warn(n, 'data', `invalid data: ${found.join('; ')}`)
    const data = msg as NerveData
    const sources = this.devicesById.get(n.device ?? '')?.description?.sources ?? []
    const source = sources.find((x) => x.id === data.source)
    if (!source) return this.warn(n, data.source, `data for undeclared source ${data.source}`)
    const def = dataDef(source.kind)
    const payload = def === undefined ? [] : problems(def as 'CustomData', data.data)
    if (payload.length === 0 && (source.kind === 'values' || source.kind === 'switch'))
      payload.push(...fieldProblems((source as { fields: Record<string, Field> }).fields, data.data))
    if (payload.length > 0)
      return this.warn(
        n,
        data.source,
        `${data.source}: invalid ${source.kind} payload: ${payload.join('; ')}`,
      )
    if (data.bin) n.awaiting = data
    else this.deliver(n, data)
  }

  private deliver(n: Nerve, msg: NerveData, binary?: Buffer): void {
    const latest: Latest = binary === undefined ? { msg } : { msg, binary }
    n.latest.set(msg.source, latest)
    this.emit('data', n.device, msg, binary)
  }

  /** Logs a problem once per source and channel, so a bad stream does not flood the log. */
  private warn(n: Nerve, key: string, line: string): void {
    if (n.warned.has(key)) return
    n.warned.add(key)
    this.log(`${n.device ?? '?'}: ${line}`)
  }
}

function methodError(method: string): { code: number; message: string } {
  return method === 'mhs/register'
    ? { code: -32600, message: 'already registered; reconnect to register again (REG-3)' }
    : { code: -32601, message: `unknown method ${method}` }
}

function error(call: string, reason: string, detail: string): Outcome {
  return { call, status: 'error', reason, detail } as Outcome
}

function rejectedByHub(reason: 'offline' | 'invalid', detail: string): CallHandle {
  const reply: CallReply = { accepted: false, status: 'rejected', reason: reason as 'invalid', detail }
  return {
    id: '',
    reply: Promise.resolve(reply),
    done: Promise.resolve({ call: '', status: 'rejected', reason, detail }),
  }
}
