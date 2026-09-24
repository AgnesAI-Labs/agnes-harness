// The JSON-RPC connection: request correlation, answers to server-to-client requests,
// timeouts and close. This layer understands envelopes, not methods - method names and the
// schema checks on params and result belong to client.ts.
import { JSONRPC_ERRORS, type RpcError, rpcError } from '@agnes/protocol'
import { JsonRpcError, RequestTimeout, TransportClosed } from './errors.js'
import {
  type CloseInfo,
  classify,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type Transport,
  type TransportFactory,
} from './transport/types.js'

export type Disposer = () => void

// resolve and reject each wrap their own cleanup (clearing the timer, dropping the abort
// listener), so every exit is "take the pending entry and call it once" and no path can
// forget a clearTimeout.
type Pending = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export type RpcConnectionOptions = {
  requestTimeoutMs: number
  onClose?: (info: CloseInfo) => void
}

export type RequestOptions = {
  // null means no deadline at all. prompt travels this way: a turn is ended by the
  // transport noticing it is dead, not by a stopwatch on the request.
  timeoutMs?: number | null
  // Cancellation at this level drops the pending entry and rejects with signal.reason.
  // Session.prompt's signal is deliberately NOT passed down here: that one means "send
  // session/cancel and keep waiting", which is the opposite, and Session handles it.
  signal?: AbortSignal
}

export class RpcConnection {
  private transport: Transport | null = null
  private open = false
  // Terminal, and deliberately separate from `open`: a transport that dropped can be
  // brought back (Task 15), a connection the owner closed cannot. Without this latch a
  // request after close() walks straight back into doConnect() and builds a second
  // transport - which for stdio means respawning a child the owner believed was killed.
  private closed = false
  // The close is memoised rather than guarded by a flag: a second close() has to wait
  // for the first one's teardown, not report success while it is still running.
  private closingPromise: Promise<void> | null = null
  // The in-flight connect. Two concurrent connect() calls that each see `open === false`
  // build a transport each; the first is overwritten without being closed or unsubscribed
  // and keeps pouring messages into the same connection. Sharing one promise is what makes
  // connect idempotent.
  private connecting: Promise<void> | null = null
  // Monotonic, and never reset - not even across a reconnect (Task 15): a late response
  // carries the old connection's id, and a reset would let it collide with a request of the
  // same number on the new one.
  private nextId = 1
  private generation = 0
  private readonly pending = new Map<JsonRpcId, Pending>()
  private readonly notificationHandlers = new Set<(method: string, params: unknown) => void>()
  private serverRequestHandler: ((method: string, params: unknown) => Promise<unknown>) | null = null

  constructor(
    private readonly factory: TransportFactory,
    private readonly opts: RpcConnectionOptions,
  ) {}

  get connected(): boolean {
    return this.open
  }

  async connect(): Promise<void> {
    if (this.closed) throw new TransportClosed({ reason: 'closed' })
    if (this.open) return
    this.connecting ??= this.doConnect().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async doConnect(): Promise<void> {
    const generation = ++this.generation
    const previous = this.transport
    if (previous) {
      await previous.close()
      this.transport = null
      if (this.closed) throw new TransportClosed({ reason: 'closed' })
    }
    // The factory itself can start pumping messages (inproc's notification iterator,
    // stdio's stdout read loop) while this.transport is still unassigned - an answer to a
    // server-to-client request would have nowhere to go, and a close would be lost. Both
    // are buffered and released in arrival order once the assignment has happened.
    const early: JsonRpcMessage[] = []
    const earlyClose: CloseInfo[] = []
    let ready = false
    let ended = false
    const transport = await this.factory({
      onMessage: (msg) => {
        if (generation !== this.generation || ended || this.closed) return
        if (ready) this.dispatch(msg, generation)
        else early.push(msg)
      },
      onClose: (info) => {
        if (generation !== this.generation || ended) return
        ended = true
        if (ready) this.handleClose(info)
        else earlyClose.push(info)
      },
    })
    this.transport = transport
    this.open = true
    // Drained by index, and `ready` is set only afterwards: a message fed back in during
    // the drain joins the tail of the same queue and is taken by the same loop, in arrival
    // order. Nothing is reordered or delivered twice by construction, rather than by an
    // argument about which microtask the feedback lands on.
    for (let i = 0; i < early.length; i++) {
      const m = early[i]
      if (m && !this.closed) this.dispatch(m, generation)
    }
    ready = true
    const first = earlyClose[0]
    if (first) this.handleClose(first)
  }

  async request<T>(method: string, params: unknown, opts: RequestOptions = {}): Promise<T> {
    if (this.closed || !this.transport || !this.open) throw new TransportClosed({ reason: 'closed' })
    const transport = this.transport
    const signal = opts.signal
    if (signal?.aborted) throw signal.reason
    const id = this.nextId++
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => this.takePending(id)?.reject(signal?.reason as Error)
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, {
        method,
        resolve: (value) => {
          cleanup()
          resolve(value as T)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
      })
      const timeoutMs = opts.timeoutMs === undefined ? this.opts.requestTimeoutMs : opts.timeoutMs
      if (timeoutMs !== null)
        timer = setTimeout(() => {
          this.takePending(id)?.reject(new RequestTimeout(method, timeoutMs))
        }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      transport.send(msg).catch((error: Error) => {
        this.takePending(id)?.reject(error)
      })
    })
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.closed || !this.transport || !this.open) throw new TransportClosed({ reason: 'closed' })
    await this.transport.send({ jsonrpc: '2.0', method, params })
  }

  onNotification(h: (method: string, params: unknown) => void): Disposer {
    this.notificationHandlers.add(h)
    return () => {
      this.notificationHandlers.delete(h)
    }
  }

  // A single handler, last registration wins: the only server-to-client requests today are
  // the session/request_permission family, and the client fans those out to the sessions.
  // This layer does not multiplex.
  onServerRequest(h: (method: string, params: unknown) => Promise<unknown>): Disposer {
    this.serverRequestHandler = h
    return () => {
      if (this.serverRequestHandler === h) this.serverRequestHandler = null
    }
  }

  close(): Promise<void> {
    this.closed = true
    this.closingPromise ??= this.doClose()
    return this.closingPromise
  }

  private async doClose(): Promise<void> {
    // A factory may already have spawned a child before doConnect assigns this.transport. Closing
    // in that same tick must wait for the owned transport, not cache a completed no-op forever.
    if (this.connecting) await this.connecting.catch(() => undefined)
    // The reference outlives handleClose deliberately: a transport that reported its own
    // EOF still owns whatever it was built on (a child process, an endpoint), and closing
    // the connection is the only thing left that can hand that back.
    const transport = this.transport
    this.transport = null
    if (!transport) return
    // The `finally` is not decoration: if transport.close() throws and the bookkeeping is
    // skipped, every pending request hangs forever and `connected` stays true - a
    // connection that is silently dead. The accounting happens either way; the error
    // still propagates.
    try {
      await transport.close()
    } finally {
      // Transports normally report their own close; this is the fallback for one that
      // did not (a transport that already did has left `open` false).
      if (this.open) this.handleClose({ reason: 'closed' })
    }
  }

  private takePending(id: JsonRpcId): Pending | undefined {
    const p = this.pending.get(id)
    if (p) this.pending.delete(id)
    return p
  }

  private dispatch(msg: JsonRpcMessage, generation: number): void {
    if (generation !== this.generation || this.closed) return
    switch (classify(msg)) {
      case 'response': {
        const r = msg as JsonRpcResponse
        // A response nobody is waiting for - late after a timeout, or an id the server got
        // wrong - is dropped rather than thrown: a throw kills the whole read loop.
        const p = this.takePending(r.id)
        if (!p) return
        if (r.error) p.reject(new JsonRpcError(r.error))
        else p.resolve(r.result)
        return
      }
      case 'notification': {
        const n = msg as { method: string; params?: unknown }
        for (const h of this.notificationHandlers) h(n.method, n.params)
        return
      }
      case 'request': {
        const req = msg as JsonRpcRequest
        const transport = this.transport
        const reply = (body: { result?: unknown } | { error: RpcError }) => {
          if (!this.open || this.closed || generation !== this.generation || transport !== this.transport)
            return
          transport?.send({ jsonrpc: '2.0', id: req.id, ...body }).catch(() => undefined)
        }
        const handler = this.serverRequestHandler
        if (!handler) {
          reply({ error: rpcError('METHOD_NOT_FOUND') })
          return
        }
        handler(req.method, req.params).then(
          (result) => reply({ result }),
          (e: unknown) =>
            reply({
              // A JsonRpcError from the handler goes back as it is (e.rpc is the lossless
              // wire shape); anything else becomes INTERNAL_ERROR, so no internal message
              // or stack leaks to the peer.
              error:
                e instanceof JsonRpcError
                  ? e.rpc
                  : {
                      code: JSONRPC_ERRORS.INTERNAL_ERROR,
                      message: 'INTERNAL_ERROR',
                      data: { code: 'INTERNAL_ERROR' },
                    },
            }),
        )
      }
    }
  }

  private handleClose(info: CloseInfo): void {
    if (!this.open) return
    this.open = false
    for (const id of [...this.pending.keys()]) this.takePending(id)?.reject(new TransportClosed(info))
    this.opts.onClose?.(info)
  }
}
