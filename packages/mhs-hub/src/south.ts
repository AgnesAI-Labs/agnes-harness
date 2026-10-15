import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import {
  type Json,
  MhsError,
  type Outcome,
  object,
  type Registration,
  type ResourceHolder,
  validateCommand,
  validateNerveMessage,
  validateRegistration,
} from '@agnes/mhs-device'
import { type WebSocket, WebSocketServer } from 'ws'
import type { DeviceLink, SouthEvents } from './ports.js'

type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
class Link implements DeviceLink {
  nerve: WebSocket | undefined
  private readonly clips = new Map<string, Pending>()
  private next = 0
  private readonly pending = new Map<string, Pending>()
  private readonly results = new Map<
    string,
    { resolve(value: Outcome): void; timer: ReturnType<typeof setTimeout> }
  >()
  constructor(
    readonly registration: Registration,
    readonly cmd: WebSocket,
  ) {}
  get available(): boolean {
    return (
      this.cmd.readyState === 1 &&
      (!(this.registration.sources?.length || this.registration.manual) || this.nerve?.readyState === 1)
    )
  }
  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 2000,
    id = `hub-${++this.next}`,
  ): Promise<unknown> {
    if (this.cmd.readyState !== 1) return Promise.reject(new MhsError('offline'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        if (method === 'mhs/stop') this.close()
        if (method === 'mhs/pause') void this.expire(String(params.call))
        reject(new MhsError('timeout'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.cmd.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }
  reply(message: Record<string, unknown>): void {
    const id = String(message.id)
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new MhsError('device-error'))
    else pending.resolve(message.result)
  }
  outcome(params: Record<string, unknown>): void {
    const id = String(params.call)
    const entry = this.results.get(id)
    if (!entry || !['done', 'error', 'interrupted', 'unknown'].includes(String(params.status))) return
    clearTimeout(entry.timer)
    this.results.delete(id)
    // Only protocol outcome fields cross the device boundary.
    entry.resolve({
      status: params.status as Outcome['status'],
      ...(typeof params.reason === 'string' ? { reason: params.reason.slice(0, 64) } : {}),
      ...(typeof params.detail === 'string' ? { detail: params.detail.slice(0, 4096) } : {}),
      ...(params.data === undefined ? {} : { data: params.data as Json }),
    })
  }
  async call(
    id: string,
    name: string,
    args: Json,
    caller?: string,
  ): Promise<{
    accepted: boolean
    reason?: string
    holder?: ResourceHolder
    needs?: string[]
    result: Promise<Outcome>
  }> {
    const tool = this.registration.tools?.find((t) => t.name === name)
    const result = new Promise<Outcome>((resolve) => {
      const timer = setTimeout(
        () => {
          this.results.delete(id)
          void this.expire(id)
          resolve({ status: 'unknown', reason: 'timeout' })
        },
        ((tool?.timeout ?? 1) + 5) * 1000,
      )
      this.results.set(id, { resolve, timer })
    })
    try {
      const acceptance = object(
        await this.request(
          'mhs/call',
          { name, arguments: args, ...(caller ? { meta: { caller } } : {}) },
          2000,
          id,
        ),
      )
      if (acceptance.accepted !== true) {
        const entry = this.results.get(id)
        if (entry) {
          clearTimeout(entry.timer)
          this.results.delete(id)
          entry.resolve({
            status: 'rejected',
            reason: String(acceptance.reason ?? 'invalid'),
            ...rejection(acceptance),
          })
        }
      }
      return {
        accepted: acceptance.accepted === true,
        ...(typeof acceptance.reason === 'string' ? { reason: acceptance.reason } : {}),
        ...rejection(acceptance),
        result,
      }
    } catch (error) {
      const entry = this.results.get(id)
      if (entry) {
        clearTimeout(entry.timer)
        this.results.delete(id)
        entry.resolve({ status: 'unknown', reason: 'accept-timeout' })
      }
      void this.expire(id)
      throw error
    }
  }
  private async expire(id: string): Promise<void> {
    try {
      await this.request('mhs/cancel', { call: id }, 500)
    } catch {
      /* Stop is mandatory either way. */
    }
    try {
      await this.request('mhs/stop', {}, 1500)
    } catch {
      this.close()
    }
  }
  clip(id: string, rate: number, channels: number, pcm: Uint8Array): Promise<void> {
    const nerve = this.nerve
    if (
      nerve?.readyState !== 1 ||
      nerve.bufferedAmount > 1 << 20 ||
      this.clips.size >= 8 ||
      this.clips.has(id)
    )
      return Promise.reject(new MhsError('clip-unavailable'))
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clips.delete(id)
        reject(new MhsError('clip-unconfirmed'))
      }, 2000)
      this.clips.set(id, { resolve: () => resolve(), reject, timer })
      nerve.send(JSON.stringify({ type: 'clip', id, rate, channels }))
      nerve.send(pcm)
    })
  }
  clipReceived(id: string) {
    const pending = this.clips.get(id)
    if (!pending) return
    this.clips.delete(id)
    clearTimeout(pending.timer)
    pending.resolve({})
  }
  manual(axes: Record<string, number>): void {
    if (this.nerve?.readyState !== 1 || this.nerve.bufferedAmount > 32768) throw new MhsError('offline')
    this.nerve.send(JSON.stringify({ type: 'manual', axes }))
  }
  close(): void {
    this.cmd.close()
    this.nerve?.close()
  }
  lost(): void {
    for (const p of this.clips.values()) {
      clearTimeout(p.timer)
      p.reject(new MhsError('clip-unconfirmed'))
    }
    this.clips.clear()
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new MhsError('offline'))
    }
    this.pending.clear()
    for (const p of this.results.values()) {
      clearTimeout(p.timer)
      p.resolve({ status: 'unknown', reason: 'disconnect' })
    }
    this.results.clear()
  }
}
/** Device-only listener. Human/agent control is deliberately absent from this socket server. */
export class South {
  private readonly links = new Map<string, Link>()
  private readonly sockets = new Set<WebSocket>()
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 << 20 })
  private closing = false
  private server: Server | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  constructor(
    private readonly events: SouthEvents,
    private readonly admit: (request: IncomingMessage) => boolean = (request) => !request.headers.origin,
  ) {}
  async listen(port = 4180): Promise<{ host: '127.0.0.1'; port: number }> {
    if (this.server || this.closing) throw new MhsError('already-listening')
    const server = createServer((_req, response) => {
      response.writeHead(404)
      response.end()
    })
    this.server = server
    server.on('upgrade', (request, socket, head) => {
      if (this.closing || !this.admit(request) || !['/ws/mhs', '/ws/nerve'].includes(request.url ?? '')) {
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.attach(ws, request.url === '/ws/nerve'))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
    } catch (error) {
      this.server = undefined
      throw error
    }
    this.heartbeat = setInterval(() => {
      for (const ws of this.sockets) ws.ping()
    }, 2000)
    const address = server.address()
    if (!address || typeof address === 'string') throw new MhsError('listen-failed')
    return { host: '127.0.0.1', port: address.port }
  }
  private attach(ws: WebSocket, nerve: boolean): void {
    if (this.closing || this.sockets.size >= 128) {
      ws.close(1013)
      return
    }
    this.sockets.add(ws)
    let link: Link | undefined
    let closed = false
    let binary: { source: string; data: Json; bytes: number; mime?: string } | undefined
    const seqs = new Map<string, number>()
    let pong = Date.now()
    ws.on('pong', () => {
      pong = Date.now()
    })
    const liveness = setInterval(() => {
      if (Date.now() - pong > 5000) ws.terminate()
    }, 1000)
    const first = setTimeout(() => {
      if (!link) ws.close(4002)
    }, 5000)
    const send = (id: unknown, result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
    ws.on('message', (frame, isBinary) => {
      const raw = Array.isArray(frame) ? Buffer.concat(frame) : Buffer.from(frame as ArrayBuffer)
      try {
        if (isBinary) {
          if (!nerve || !link || !binary || raw.byteLength !== binary.bytes)
            throw new MhsError('invalid-binary')
          this.events.observation(
            link.registration.device.id,
            binary.source,
            binary.data,
            new Uint8Array(raw as Buffer),
            binary.mime,
          )
          binary = undefined
          return
        }
        if (raw.byteLength > (nerve ? 1 << 20 : 65536)) throw new MhsError('oversize')
        if (binary) throw new MhsError('missing-binary')
        const message = object(JSON.parse(raw.toString()))
        if (!nerve && message.method === 'mhs/register' && object(message.params).protocol !== 'mhs/v1') {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32001, message: 'unsupported-version' },
            }),
          )
          ws.close(4003)
          return
        }
        if (!nerve) validateCommand(message)
        else validateNerveMessage(message)
        if (!link) {
          if (nerve) {
            if (message.type !== 'hello' || typeof message.device !== 'string')
              throw new MhsError('invalid-hello')
            link = this.links.get(message.device)
            if (!link || link.nerve) throw new MhsError('unregistered')
            link.nerve = ws
            this.events.online(link)
          } else {
            if (
              message.jsonrpc !== '2.0' ||
              message.method !== 'mhs/register' ||
              typeof message.id !== 'string'
            )
              throw new MhsError('invalid-register')
            const registration = validateRegistration(message.params)
            const prior = this.links.get(registration.device.id)
            if (prior) {
              prior.cmd.close(4001)
              prior.nerve?.close(4001)
            }
            link = new Link(registration, ws)
            this.links.set(registration.device.id, link)
            send(message.id, {
              session: randomUUID(),
              hub: { name: 'Agnes MHS', version: '1.0.0' },
              time: Date.now() / 1000,
            })
            this.events.online(link)
          }
          clearTimeout(first)
          return
        }
        const device = link.registration.device.id
        if (nerve) {
          if (
            message.type !== 'data' ||
            typeof message.source !== 'string' ||
            !Number.isSafeInteger(message.seq) ||
            typeof message.t !== 'number' ||
            !Number.isFinite(message.t)
          )
            throw new MhsError('invalid-data')
          const source = link.registration.sources?.find((s) => s.id === message.source)
          if (!source || Number(message.seq) <= (seqs.get(source.id) ?? -1))
            throw new MhsError('invalid-source-sequence')
          seqs.set(source.id, Number(message.seq))
          if (message.bytes !== undefined) {
            if (
              !Number.isSafeInteger(message.bytes) ||
              Number(message.bytes) < 1 ||
              Number(message.bytes) > 16 << 20
            )
              throw new MhsError('invalid-binary')
            binary = {
              source: source.id,
              data: (message.data ?? null) as Json,
              bytes: Number(message.bytes),
              ...(typeof message.mime === 'string' ? { mime: message.mime } : {}),
            }
          } else this.events.observation(device, source.id, (message.data ?? null) as Json)
        } else {
          if (message.jsonrpc !== '2.0') throw new MhsError('invalid-rpc')
          if (typeof message.method !== 'string') {
            link.reply(message)
            return
          }
          const p = object(message.params ?? {})
          switch (message.method) {
            case 'mhs/clip-received':
              link.clipReceived(String(p.id))
              break
            case 'mhs/ping':
              send(message.id, {})
              break
            case 'mhs/state':
              this.events.state(device, object(p.values) as Record<string, Json>)
              break
            case 'mhs/result':
              link.outcome(p)
              break
            case 'mhs/progress':
              this.events.progress(device, String(p.call), (p.data ?? null) as Json)
              break
            default:
              throw new MhsError('unknown-method')
          }
        }
      } catch {
        ws.close(4002)
      }
    })
    ws.on('error', () => ws.close())
    ws.on('close', () => {
      if (closed) return
      closed = true
      clearTimeout(first)
      clearInterval(liveness)
      this.sockets.delete(ws)
      if (!link) return
      link.lost()
      link.close()
      if (this.links.get(link.registration.device.id) === link) {
        this.links.delete(link.registration.device.id)
        this.events.offline(link.registration.device.id, link)
      }
    })
  }
  async close(): Promise<void> {
    this.closing = true
    clearInterval(this.heartbeat)
    const server = this.server
    this.server = undefined
    const stopped = server ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve()
    await Promise.all(
      [...this.sockets].map(
        (ws) =>
          new Promise<void>((resolve) => {
            if (ws.readyState === 3) {
              resolve()
              return
            }
            ws.once('close', () => resolve())
            ws.terminate()
          }),
      ),
    )
    await stopped
  }
}

function rejection(value: Record<string, unknown>): { holder?: ResourceHolder; needs?: string[] } {
  const result: { holder?: ResourceHolder; needs?: string[] } = {}
  if (value.holder && typeof value.holder === 'object') {
    const holder = object(value.holder)
    if (holder.manual === true) result.holder = { manual: true }
    else if (typeof holder.call === 'string' && typeof holder.tool === 'string')
      result.holder = {
        call: holder.call.slice(0, 256),
        tool: holder.tool.slice(0, 64),
        ...(typeof holder.caller === 'string' ? { caller: holder.caller.slice(0, 128) } : {}),
      }
  }
  if (Array.isArray(value.needs) && value.needs.every((n) => typeof n === 'string'))
    result.needs = value.needs.slice(0, 64)
  return result
}
