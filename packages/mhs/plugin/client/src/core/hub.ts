/**
 * One connection to AgnesHub's /ws/hub (hub-api.md section 3): hello as a person's page, numbered
 * requests with a 10 s timeout, notifications, and binary frames that follow their `hub/data` item.
 * It reconnects on its own, from 0.5 s doubling to 5 s.
 */
import type { Json } from './types.js'

const TIMEOUT_MS = 10_000
const RETRY_MS = { first: 500, max: 5000 }

export type Conn = 'connecting' | 'open' | 'closed'

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class HubError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

export class HubClient {
  conn: Conn = 'connecting'
  private ws: WebSocket | undefined
  private nextId = 0
  private readonly pending = new Map<string, Pending>()
  private readonly handlers = new Map<string, Set<(params: Json) => void>>()
  private readonly connListeners = new Set<(conn: Conn) => void>()
  /** The `hub/data` params waiting for their binary frame. */
  private waitingBinary: Json | undefined
  private retry = RETRY_MS.first
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(
    readonly url: string,
    private readonly client = { name: 'devices-panel', version: '0.1' },
  ) {
    this.open()
  }

  /** Called with every notification of this method. */
  on(method: string, handler: (params: Json) => void): () => void {
    const set = this.handlers.get(method) ?? new Set()
    set.add(handler)
    this.handlers.set(method, set)
    return () => set.delete(handler)
  }

  /** Called on every change of the connection, after hello on open. */
  onConn(listener: (conn: Conn) => void): () => void {
    this.connListeners.add(listener)
    return () => this.connListeners.delete(listener)
  }

  request<T = Json>(method: string, params: Json = {}): Promise<T> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected to AgnesHub'))
    return this.send(ws, method, params) as Promise<T>
  }

  notify(method: string, params: Json): void {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.ws?.close()
  }

  private send(ws: WebSocket, method: string, params: Json): Promise<unknown> {
    this.nextId += 1
    const id = String(this.nextId)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  private setConn(conn: Conn): void {
    this.conn = conn
    for (const listener of [...this.connListeners]) listener(conn)
  }

  private open(): void {
    if (this.closed) return
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch {
      this.later()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      this.send(ws, 'hub/hello', { role: 'ui', client: this.client }).then(
        () => {
          this.retry = RETRY_MS.first
          this.setConn('open')
        },
        () => ws.close(),
      )
    }
    ws.onmessage = (e) => this.receive(e.data)
    ws.onclose = () => {
      if (this.ws !== ws) return
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('connection to AgnesHub lost'))
        this.pending.delete(id)
      }
      this.waitingBinary = undefined
      this.setConn('closed')
      this.later()
    }
  }

  private later(): void {
    if (this.closed) return
    this.timer = setTimeout(() => this.open(), this.retry)
    this.retry = Math.min(this.retry * 2, RETRY_MS.max)
  }

  private receive(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      const params = this.waitingBinary
      this.waitingBinary = undefined
      if (params) this.dispatch('hub/data', { ...params, binary: data })
      return
    }
    let msg: {
      id?: string
      method?: string
      params?: Json
      result?: unknown
      error?: { code: number; message: string }
    }
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(String(msg.id))
      if (!p) return
      this.pending.delete(String(msg.id))
      clearTimeout(p.timer)
      if (msg.error) p.reject(new HubError(msg.error.code, msg.error.message))
      else p.resolve(msg.result)
      return
    }
    if (!msg.method) return
    const params = msg.params ?? {}
    if (msg.method === 'hub/data' && (params.item as Json | undefined)?.bin) {
      this.waitingBinary = params
      return
    }
    this.dispatch(msg.method, params)
  }

  private dispatch(method: string, params: Json): void {
    for (const handler of [...(this.handlers.get(method) ?? [])]) handler(params)
  }
}
