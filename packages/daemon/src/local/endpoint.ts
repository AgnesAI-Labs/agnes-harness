import { randomUUID } from 'node:crypto'
import {
  METHODS,
  type MethodName,
  type RpcError,
  rpcError,
  toRpcError,
  validateMethod,
} from '@agnes/protocol'
import {
  fail,
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  ok,
} from '../rpc.js'

/** UTF-8 size of the JSON frame that actually sits in the subscription queue. */
export function utf8JsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), 'utf8')
}

/** Per-connection ceiling on streamed text waiting to be written; past it previews are refused. */
export const PREVIEW_BUDGET = { events: 256, bytes: 2 * 1024 * 1024 }

export interface RpcEndpoint {
  handle(msg: JsonRpcMessage): Promise<JsonRpcMessage | undefined>
  notifications: AsyncIterable<JsonRpcMessage>
  close(): Promise<void>
}

export type AttachPrefs = {
  cursor: { fromSeq: number; generation: number }
  filter: { types?: string[]; lanes?: string[]; preview: boolean; acpUpdates: boolean }
}

// principalId is what the server established about this connection; clientId is a label the client
// sent. Anything that must be one-per-identity keys on principalId, so principalId is fixed when the
// connection is made and is not writable afterwards, while clientId is written by whatever the client
// said.
export type ConnectionState = {
  readonly principalId: string
  // A daemon supervisor serves one profile, but several supervisors/connections can coexist in
  // process in tests and embedders. Profile-wide notices use this server-established binding rather
  // than a client-supplied RPC field, so one page cannot subscribe itself to another profile.
  readonly profile?: string
  clientId: string
  initialized: boolean
  /** Set only after this connection successfully calls the authorized client-module roster RPC. */
  clientModuleNotices: boolean
  capabilities: { permission: boolean }
  attached: Map<string, AttachPrefs>
  // Set by authGate (local/auth.ts) once `initialize`'s credential has actually verified. Absent
  // rather than defaulted to 'local': a connection that never ran the gate (every test that talks to
  // a bare LocalEndpoint without registerAcp) should not silently read as authenticated.
  authKind?: 'local' | 'jwt' | 'source-auth' | 'portal-identity' | 'surface'
  credentialKind?: 'local' | 'jwt' | 'portal-identity' | 'sso' | 'channel'
  credential?: { kind: string } & Record<string, unknown>
  surface?: Readonly<{
    sourceId: string
    sourceAuthKeyId: string
    grants: ReadonlyArray<{ extension: string; name: string; range: string }>
  }>
}

export type LedgerActor = {
  id: string
  org: string
  role: string
  deptPath: string[]
  attrs: Record<string, string>
}

/**
 * The Actor written into the append-only ledger for anything this connection asks for. Minted here,
 * in one place, from principalId alone: clientId is a label the client wrote on itself, and a caller
 * that can name its own Actor can sign another identity's name to a permanent record. Both method
 * families mint through this, so there is one line to read and one line to change.
 */
export function connActor(conn: ConnectionState): LedgerActor {
  return { id: conn.principalId, org: 'local', role: 'owner', deptPath: [], attrs: {} }
}

export type CallContext = { conn: ConnectionState; clock: () => number; signal: AbortSignal }
export type Handler = (params: unknown, cx: CallContext) => Promise<unknown>

/**
 * Every value is enqueued and then pumped out, never handed straight to a waiting consumer. Handing
 * over directly would leave the backlog uncounted for exactly the consumer that is reading, so a
 * bounded feed could only ever trip against a fully idle reader - which is not what backpressure
 * means. Sizes are measured once, on the way in.
 */
class Queue<T> {
  private items: Array<{ v: T; n: number; preview: boolean }> = []
  private waiters: Array<(r: IteratorResult<T>) => void> = []
  private closed = false
  private bytes = 0
  private previews = 0
  private previewBytes = 0
  private previewOverflowed = false
  /** Called once each time previews that overflowed the budget have drained to half of it. */
  onPreviewLowWater: () => void = () => undefined

  push(v: T): void {
    if (this.closed) return
    const n = utf8JsonBytes(v)
    this.items.push({ v, n, preview: false })
    this.bytes += n
    this.pump()
  }

  /**
   * Streamed text rides the same ordered queue but is counted apart from everything else: it may be
   * refused under pressure, and it never counts toward the overload that cuts a subscription.
   */
  pushPreview(v: T): boolean {
    if (this.closed) return true
    const n = utf8JsonBytes(v)
    if (this.previews + 1 > PREVIEW_BUDGET.events || this.previewBytes + n > PREVIEW_BUDGET.bytes) {
      this.previewOverflowed = true
      return false
    }
    this.items.push({ v, n, preview: true })
    this.previews += 1
    this.previewBytes += n
    this.pump()
    return true
  }

  size(): { events: number; bytes: number } {
    return { events: this.items.length - this.previews, bytes: this.bytes }
  }

  previewSize(): { events: number; bytes: number } {
    return { events: this.previews, bytes: this.previewBytes }
  }

  private taken(it: { n: number; preview: boolean }): void {
    if (!it.preview) {
      this.bytes -= it.n
      return
    }
    this.previews -= 1
    this.previewBytes -= it.n
    if (
      this.previewOverflowed &&
      this.previews <= PREVIEW_BUDGET.events / 2 &&
      this.previewBytes <= PREVIEW_BUDGET.bytes / 2
    ) {
      this.previewOverflowed = false
      this.onPreviewLowWater()
    }
  }

  /**
   * Closing ends the stream but does not throw away what is already in it: a consumer still reads
   * every value that was pushed before the close, and only then sees `done`. The last notifications
   * of a session - a final turn/end among them - are the ones a client most needs, so they are
   * delivered rather than dropped. Pinned by a test that pushes, closes without reading, and then
   * drains.
   */
  close(): void {
    this.closed = true
    this.pump()
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  private pump(): void {
    while (this.waiters.length > 0 && this.items.length > 0) {
      const w = this.waiters.shift() as (r: IteratorResult<T>) => void
      const it = this.items.shift() as { v: T; n: number; preview: boolean }
      this.taken(it)
      w({ value: it.v, done: false })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const it = this.items.shift()
        if (it !== undefined) {
          this.taken(it)
          return Promise.resolve({ value: it.v, done: false })
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((res) => {
          this.waiters.push(res)
        })
      },
    }
  }
}

const isRpcError = (e: unknown): e is RpcError =>
  typeof e === 'object' &&
  e !== null &&
  typeof (e as RpcError).code === 'number' &&
  typeof (e as RpcError).message === 'string' &&
  'data' in e

export class LocalEndpoint implements RpcEndpoint {
  readonly conn: ConnectionState
  private readonly handlers = new Map<string, Handler>()
  private readonly out = new Queue<JsonRpcMessage>()
  private readonly lowWater = new Set<() => void>()
  private readonly inflight = new Map<
    JsonRpcId,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; settle: (fn: () => void) => void }
  >()
  private nextId = 1
  private closed = false
  private accepting = true
  private readonly lifecycle = new AbortController()
  readonly notifications: AsyncIterable<JsonRpcMessage> = this.out

  // principalId is required rather than defaulted: a caller that forgets one would otherwise put
  // every connection in a single shared bucket, and everything keyed one-per-identity would collapse
  // quietly and fail open. The local form passes 'local' itself.
  constructor(
    private readonly o: {
      clock: () => number
      principalId: string
      profile?: string
      audit?: (record: unknown) => void
    },
  ) {
    let principalId = o.principalId
    this.conn = Object.defineProperty(
      {
        ...(o.profile !== undefined ? { profile: o.profile } : {}),
        clientId: 'local',
        initialized: false,
        clientModuleNotices: false,
        capabilities: { permission: false },
        attached: new Map<string, AttachPrefs>(),
      },
      'principalId',
      { get: () => principalId, enumerable: true, configurable: false },
    ) as ConnectionState
    this.out.onPreviewLowWater = () => {
      for (const fn of [...this.lowWater]) {
        try {
          fn()
        } catch {
          // A failing resync is that feed's problem; the other feeds still get their turn.
        }
      }
    }
    this.establishPrincipal = (verifiedPrincipalId: string): void => {
      if (this.conn.initialized) throw new Error('connection identity is already established')
      principalId = verifiedPrincipalId
    }
  }

  /** Auth adapters may replace the transport placeholder only with a verified server-derived id. */
  readonly establishPrincipal: (principalId: string) => void

  register(method: MethodName, h: Handler): void {
    // Registration sites arrive from several places. A silent overwrite would let the last one win
    // and leave the earlier feature answering nothing, so a collision is refused instead.
    if (this.handlers.has(method)) throw new Error(`duplicate handler for ${method}`)
    this.handlers.set(method, h)
  }

  push(n: JsonRpcNotification): void {
    this.checkOutbound(n.method, n.params)
    // The queue is the one place that knows it is closed; a second check here would make that one
    // unreachable and therefore untested.
    this.out.push(n)
  }

  /**
   * The result check, pointed the other way, for the frames this server sends of its own accord:
   * every notification pushed and the one request it raises.
   *
   * The scope is exactly the METHODS table, and it is worth being precise about what that leaves
   * out. A name the table does not carry goes out unmeasured - it has no schema to be measured
   * against, and deciding here which methods exist would make this a second such decision alongside
   * the table. So this is not "every outbound frame is checked"; it is "every outbound frame the
   * protocol describes is checked, and a name the protocol does not describe is not a frame the
   * protocol can vouch for".
   *
   * A source-text guard cannot do even this much. It can see how a name is spelled and not what
   * reaches the wire, so a backtick, a concatenation or a legitimate neighbour inside its window all
   * walk past it; and it only reads the directory it was pointed at. This reads the frame.
   */
  private checkOutbound(method: string, params: unknown): void {
    if (!(method in METHODS)) return
    const spec = METHODS[method as MethodName]
    // A c2s name carries a schema, but not one this side may fill: it is a question a client asks,
    // and a well-formed session/prompt pushed outbound is nonsense however well it validates.
    // handle() refuses the mirror image inbound with WRONG_DIRECTION, so this refuses rather than
    // validates - validating would let the shape decide something the direction already decided.
    if (spec.direction !== 's2c')
      throw rpcError('INTERNAL_ERROR', { code: 'OUTBOUND_WRONG_DIRECTION', method })
    const v = validateMethod(method as MethodName, 'params', params ?? {})
    if (!v.ok) throw rpcError('INTERNAL_ERROR', { code: 'OUTBOUND_INVALID', method, errors: v.errors })
  }

  /** Queues streamed text. False means it was refused because previews are over budget. */
  pushPreview(n: JsonRpcNotification): boolean {
    this.checkOutbound(n.method, n.params)
    return this.out.pushPreview(n)
  }

  /** Previews that were refused have drained; each listener may ask for a fresh snapshot. */
  onPreviewLowWater(fn: () => void): () => void {
    this.lowWater.add(fn)
    return () => {
      this.lowWater.delete(fn)
    }
  }

  /** Everything queued except streamed text: what the overload that cuts a subscription measures. */
  pending(): { events: number; bytes: number } {
    return this.out.size()
  }

  pendingPreviews(): { events: number; bytes: number } {
    return this.out.previewSize()
  }

  pendingRequests(): number {
    return this.inflight.size
  }

  request(
    method: string,
    params: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    // A request written to a closed queue reaches no client, and no response can arrive to settle it,
    // so raising one after close is refused here rather than parked on a promise forever.
    if (this.closed) return Promise.reject(rpcError('INTERNAL_ERROR', { code: 'CLOSED', method }))
    // A listener added to a signal that has already fired never runs, so a request raised on an
    // already-aborted signal would park forever with a live timer behind it. It is refused up front,
    // which is the same defect the test provider had and the same shape of fix.
    if (opts.signal?.aborted) return Promise.reject(rpcError('INTERNAL_ERROR', { code: 'ABORTED', method }))
    const id = `s2c-${this.nextId++}`
    return new Promise((resolve, reject) => {
      // Checked and written out first, because both of these can throw - a params the method's own
      // schema forbids, or one that cannot be measured at all (a circular or BigInt-bearing value) -
      // and a throw after the entry, the timer and the listener were registered would leave all
      // three behind with nothing able to remove them.
      this.checkOutbound(method, params)
      this.out.push({ jsonrpc: '2.0', id, method, params })
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      // One place removes the entry, clears the timer and drops the abort listener, so a request that
      // got its answer leaves no live timer and no listener behind. The early return below is
      // unreachable while every fn is a bare resolve or reject: the first settle deletes the entry
      // and removes both direct closures, so nothing can call it twice. An fn that carries an effect
      // of its own would break that, and no test would notice.
      const settle = (fn: () => void): void => {
        // Map.delete is the claim: whoever deletes the entry owns the settlement, so a late timer and
        // a late answer cannot both fire, and no second flag is needed to make it idempotent.
        if (!this.inflight.delete(id)) return
        if (timer) clearTimeout(timer)
        if (onAbort) opts.signal?.removeEventListener('abort', onAbort)
        fn()
      }
      this.inflight.set(id, { resolve, reject, settle })
      if (opts.timeoutMs !== undefined)
        timer = setTimeout(
          () => settle(() => reject(rpcError('INTERNAL_ERROR', { code: 'TIMEOUT', method }))),
          opts.timeoutMs,
        )
      if (opts.signal) {
        onAbort = () => settle(() => reject(rpcError('INTERNAL_ERROR', { code: 'ABORTED', method })))
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  async handle(msg: JsonRpcMessage): Promise<JsonRpcMessage | undefined> {
    if (isResponse(msg)) {
      const r = this.inflight.get(msg.id)
      if (r) r.settle(() => (msg.error ? r.reject(msg.error) : r.resolve(msg.result)))
      return undefined
    }
    // A request is a strict subtype of a notification - it is a notification plus an id - so a
    // negative isNotification() would take the request arm away too and leave `never`. The union that
    // is actually left after a response is ruled out is stated once here, as an annotation rather
    // than an assertion so a fourth envelope shape would be a type error instead of being waved
    // through. From here the id alone decides whether anything goes back.
    const call: JsonRpcRequest | JsonRpcNotification = msg
    const id = isRequest(call) ? call.id : undefined
    // One ternary, one place: a notification has no response form, so every refusal below either
    // becomes an error response or becomes nothing at all.
    const no = (e: RpcError): JsonRpcMessage | undefined => (id === undefined ? undefined : fail(id, e))
    if (this.closed) return no(rpcError('INVALID_REQUEST', { code: 'CLOSED' }))
    if (!this.accepting) return no(rpcError('INVALID_REQUEST', { code: 'SHUTTING_DOWN' }))
    // The gate is the method table itself. Registering a method that protocol adds later needs no
    // change here, and no count of it is written down anywhere in this package.
    if (!(call.method in METHODS)) return no(rpcError('METHOD_NOT_FOUND', { method: call.method }))
    // Direction sits in the same table entry as everything else the dispatcher reads, so it is read
    // here rather than left to whether a handler happens to be registered under the name.
    if (METHODS[call.method as MethodName].direction !== 'c2s')
      return no(rpcError('METHOD_NOT_FOUND', { method: call.method, code: 'WRONG_DIRECTION' }))
    if (call.method !== 'initialize' && !this.conn.initialized)
      return no(rpcError('INVALID_REQUEST', { code: 'NOT_INITIALIZED' }))
    const v = validateMethod(call.method as MethodName, 'params', call.params ?? {})
    if (!v.ok) return no(toRpcError(v.errors))
    const h = this.handlers.get(call.method)
    if (!h) return no(rpcError('METHOD_NOT_FOUND', { method: call.method, code: 'NOT_REGISTERED' }))
    try {
      const result = await h(call.params ?? {}, {
        conn: this.conn,
        clock: this.o.clock,
        signal: this.lifecycle.signal,
      })
      if (id === undefined) return undefined
      // Results are checked against the same table the params were. Without this the one side of the
      // contract the server owns is the side nothing enforces: a handler returning a shape its result
      // schema forbids - `{ ok: true }` where the table says Empty - ships a violation the client has
      // to reject and this side never hears about. It is answered as our fault, not as the caller's.
      if (METHODS[call.method as MethodName].result) {
        const rv = validateMethod(call.method as MethodName, 'result', result ?? {})
        if (!rv.ok)
          return fail(
            id,
            rpcError('INTERNAL_ERROR', { code: 'RESULT_INVALID', method: call.method, errors: rv.errors }),
          )
      }
      return ok(id, result)
    } catch (e) {
      if (id === undefined) return undefined
      if (isRpcError(e)) return fail(id, e)
      const diagnosticId = randomUUID()
      // Never persist params, exception messages, stacks or arbitrary exception properties.
      let errorCode = 'UNKNOWN'
      let persisted = false
      try {
        const code =
          e && typeof e === 'object' ? Object.getOwnPropertyDescriptor(e, 'code')?.value : undefined
        errorCode =
          ['EPERM', 'EACCES', 'ENOENT', 'EBUSY', 'ENOSPC', 'ETIMEDOUT', 'EIO'].find(
            (known) => known === code,
          ) ?? 'UNKNOWN'
        this.o.audit?.({
          kind: 'daemon.request_failed',
          detail: { diagnosticId, method: call.method, errorCode },
        })
        persisted = this.o.audit !== undefined
      } catch {
        /* Diagnostic failures must not replace the original RPC failure. */
      }
      return fail(
        id,
        rpcError('INTERNAL_ERROR', {
          code: 'INTERNAL',
          ...(persisted ? { diagnosticId } : this.o.audit ? { diagnosticUnavailable: true } : {}),
        }),
      )
    }
  }

  /** Refuse new client calls while leaving the outbound queue open for the shutdown notice. */
  stopIntake(): void {
    this.accepting = false
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.accepting = false
    this.closed = true
    this.lifecycle.abort(new DOMException('The endpoint was closed', 'AbortError'))
    for (const r of [...this.inflight.values()])
      r.settle(() => r.reject(rpcError('INTERNAL_ERROR', { code: 'CLOSED' })))
    this.out.close()
  }
}
