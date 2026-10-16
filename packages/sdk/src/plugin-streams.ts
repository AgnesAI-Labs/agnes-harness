import {
  decodePluginStreamBinary,
  encodePluginStreamBinary,
  inspectJsonData,
  type JsonValue,
  PLUGIN_STREAM_OPEN_PATH,
  PLUGIN_STREAM_PATH,
  PLUGIN_STREAM_SOURCE_PATH,
  type PluginStreamOpen,
  type StreamScope,
  validatePluginStreamGrant,
  validatePluginStreamJsonFrame,
} from '@agnes/protocol'

export type PluginStreamFrame = Uint8Array | JsonValue
export interface PluginStreamConnection {
  send(frame: PluginStreamFrame): 'accepted' | 'dropped' | 'closed'
  onFrame(fn: (frame: PluginStreamFrame) => void): () => void
  onDrop(fn: (info: { reason: 'backpressure'; count: number }) => void): () => void
  onDisconnect(fn: (info: { reason: string }) => void | Promise<void>): () => void
  close(reason: string): void
}
export interface PluginStreamSocket {
  readonly bufferedAmount: number
  binaryType: string
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    fn: (event: { data?: unknown; reason?: string }) => void,
  ): void
  removeEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    fn: (event: { data?: unknown; reason?: string }) => void,
  ): void
}
/** Host binds owner, scope and immutable allowlist. The browser cannot select an upstream URL. */
export function createPluginStreamsClient(options: {
  origin: string
  owner: string
  /** Immutable host roster identity. Required on the browser path. */
  client?: PluginStreamOpen['client']
  scope: StreamScope
  names: readonly string[]
  signal: AbortSignal
  /** Node Surface uses its authenticated source+subject adapter and never forges browser Origin. */
  source?: boolean
  fetch?: typeof fetch
  socket?: (url: string) => PluginStreamSocket
  open?: (input: PluginStreamOpen, signal: AbortSignal) => Promise<unknown>
}) {
  const origin = new URL(options.origin)
  if (origin.origin !== options.origin || !['http:', 'https:'].includes(origin.protocol))
    throw new Error('invalid stream origin')
  if (options.source && (!options.open || !options.socket))
    throw new Error('source streams require authenticated adapters')
  if (!options.source && !options.client) throw new Error('browser streams require a verified client row')
  const client = options.client ? structuredClone(options.client) : undefined
  const names = new Set(options.names)
  const scope = structuredClone(options.scope)
  return {
    async open(
      name: string,
      input: JsonValue,
      request: { signal?: AbortSignal; controlOperationId?: string } = {},
    ): Promise<PluginStreamConnection> {
      if (!names.has(name)) throw new Error('stream is not declared')
      const signal = request.signal ? AbortSignal.any([options.signal, request.signal]) : options.signal
      signal.throwIfAborted()
      const params: PluginStreamOpen = {
        owner: options.owner,
        name,
        scope,
        input,
        ...(client ? { client } : {}),
        ...(request.controlOperationId ? { controlOperationId: request.controlOperationId } : {}),
      }
      const open =
        options.open ??
        (async (body: PluginStreamOpen, signal: AbortSignal) => {
          const response = await (options.fetch ?? fetch)(`${origin.origin}${PLUGIN_STREAM_OPEN_PATH}`, {
            method: 'POST',
            credentials: 'same-origin',
            signal,
            headers: { 'content-type': 'application/json', 'x-agnes-stream-open': '1' },
            body: JSON.stringify(body),
          })
          if (!response.ok) throw new Error('stream admission refused')
          return response.json() as Promise<unknown>
        })
      const result = validatePluginStreamGrant(await open(params, signal))
      if (!result.ok) throw new Error('invalid stream grant')
      signal.throwIfAborted()
      const grant = result.value
      const url = new URL(options.source ? PLUGIN_STREAM_SOURCE_PATH : PLUGIN_STREAM_PATH, origin)
      url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = (options.socket ?? ((address) => new WebSocket(address) as unknown as PluginStreamSocket))(
        url.href,
      )
      ws.binaryType = 'arraybuffer'
      const frames = new Set<(frame: PluginStreamFrame) => void>()
      const disconnects = new Set<(info: { reason: string }) => void | Promise<void>>()
      let closed = false,
        ready = false,
        reason = 'closed',
        sequence = 0,
        received = -1
      let resolve!: (stream: PluginStreamConnection) => void
      let reject!: (error: Error) => void
      const pending = new Promise<PluginStreamConnection>((yes, no) => {
        resolve = yes
        reject = no
      })
      const timer = setTimeout(() => finish('expired'), 5000)
      const off = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', aborted)
        ws.removeEventListener('open', opened)
        ws.removeEventListener('message', message)
        ws.removeEventListener('close', disconnected)
        ws.removeEventListener('error', failed)
      }
      function finish(why: string, fromPeer = false): void {
        if (closed) return
        closed = true
        reason = why
        off()
        if (!ready) reject(new Error('stream connection refused'))
        if (!fromPeer) {
          try {
            ws.close(1000, 'closed')
          } catch {
            /* Already closed. */
          }
        }
        for (const fn of disconnects)
          void Promise.resolve()
            .then(() => fn({ reason }))
            .catch(() => undefined)
        frames.clear()
        disconnects.clear()
      }
      const stream: PluginStreamConnection = Object.freeze({
        send(frame: PluginStreamFrame) {
          if (closed || !ready) return 'closed'
          if (grant.lane !== 'control' && !grant.producer) {
            finish('protocol')
            return 'closed'
          }
          try {
            if (sequence > 0xffffffff) {
              finish('reopen')
              return 'closed'
            }
            let data: string | Uint8Array
            if (frame instanceof Uint8Array)
              data = encodePluginStreamBinary(grant.streamId, sequence++, frame)
            else {
              const checked = inspectJsonData(frame, 4096)
              if (!checked.ok) throw new Error('invalid frame')
              data = JSON.stringify({
                version: 1,
                streamId: grant.streamId,
                sequence: sequence++,
                kind: 'json',
                data: checked.value,
              })
            }
            const bytes =
              typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength
            if (bytes > (grant.producer ? (grant.maxFrameBytes ?? 4096) : 4096)) {
              finish('protocol')
              return 'closed'
            }
            if (ws.bufferedAmount + bytes > (grant.producer ? (grant.maxBufferedBytes ?? 32768) : 32768)) {
              finish('overloaded')
              return 'closed'
            }
            ws.send(data)
            return 'accepted'
          } catch {
            finish('unavailable')
            return 'closed'
          }
        },
        onFrame(fn: (frame: PluginStreamFrame) => void) {
          if (!closed) frames.add(fn)
          return () => {
            frames.delete(fn)
          }
        },
        onDrop() {
          return () => {}
        },
        onDisconnect(fn: (info: { reason: string }) => void | Promise<void>) {
          if (closed)
            void Promise.resolve()
              .then(() => fn({ reason }))
              .catch(() => undefined)
          else disconnects.add(fn)
          return () => {
            disconnects.delete(fn)
          }
        },
        close: () => finish('closed'),
      })
      function opened(): void {
        if (closed) return
        try {
          ws.send(JSON.stringify({ ticket: grant.ticket }))
        } catch {
          finish('unavailable')
        }
      }
      function message(event: { data?: unknown }): void {
        if (closed) return
        try {
          if (!ready) {
            if (typeof event.data !== 'string' || event.data.length > 4096) throw new Error()
            const ack: unknown = JSON.parse(event.data)
            if (
              !ack ||
              typeof ack !== 'object' ||
              !('ready' in ack) ||
              ack.ready !== true ||
              !('streamId' in ack) ||
              ack.streamId !== grant.streamId
            )
              throw new Error()
            ready = true
            clearTimeout(timer)
            resolve(stream)
            return
          }
          let id: number, seq: number, data: PluginStreamFrame
          if (event.data instanceof ArrayBuffer || event.data instanceof Uint8Array) {
            const frame = decodePluginStreamBinary(
              event.data instanceof Uint8Array ? event.data : new Uint8Array(event.data),
            )
            id = frame.streamId
            seq = frame.sequence
            data = frame.payload
          } else {
            if (typeof event.data !== 'string') throw new Error()
            const frame = validatePluginStreamJsonFrame(JSON.parse(event.data))
            if (!frame.ok) throw new Error()
            id = frame.value.streamId
            seq = frame.value.sequence
            data = frame.value.data
          }
          if (id !== grant.streamId || seq <= received || (grant.lane !== 'media' && seq !== received + 1))
            throw new Error()
          received = seq
          for (const fn of frames) fn(data)
        } catch {
          finish('protocol')
        }
      }
      function disconnected(event: { reason?: string }): void {
        const safe = [
          'closed',
          'revoked',
          'expired',
          'overloaded',
          'protocol',
          'unavailable',
          'reopen',
        ].includes(event.reason ?? '')
          ? (event.reason ?? 'closed')
          : 'closed'
        finish(safe, true)
      }
      function failed(): void {
        finish('unavailable')
      }
      function aborted(): void {
        finish('closed')
      }
      ws.addEventListener('open', opened)
      ws.addEventListener('message', message)
      ws.addEventListener('close', disconnected)
      ws.addEventListener('error', failed)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
      return pending
    },
  }
}
