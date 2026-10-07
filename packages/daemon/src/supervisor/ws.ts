import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage, STATUS_CODES } from 'node:http'
import { createServer } from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import { MAX_FRAME_BYTES } from '@agnes/protocol'
import { type WebSocket, WebSocketServer } from 'ws'
import type { RpcEndpoint } from '../local/endpoint.js'
import type { JsonRpcMessage } from '../rpc.js'
import { type RuntimeClientPorts, runtimeClientRoutes } from '../runtime/transport.js'

export const WS_MAX_MESSAGE_BYTES = MAX_FRAME_BYTES
const MAX_PENDING = 1_000
const MAX_BUFFERED_BYTES = MAX_FRAME_BYTES

function authorized(header: string | undefined, token: string): boolean {
  const given = header?.startsWith('Bearer ') ? header.slice(7) : ''
  return timingSafeEqual(
    createHash('sha256').update(given).digest(),
    createHash('sha256').update(token).digest(),
  )
}

function protocolBearer(header: string | undefined): string | undefined {
  return header
    ?.split(',')
    .map((value) => value.trim())
    .find((value) => value.startsWith('agnes-bearer.'))
    ?.slice('agnes-bearer.'.length)
}

function target(addr: string): { host: string; port: number } {
  let url: URL
  try {
    url = new URL(`https://${addr}`)
  } catch {
    throw new Error('invalid WebSocket listen address')
  }
  const port = Number(url.port)
  if (!url.hostname || !Number.isInteger(port) || port < 0 || port > 65_535 || url.pathname !== '/')
    throw new Error('invalid WebSocket listen address')
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port }
}

function bind(socket: WebSocket, endpoint: RpcEndpoint, onClose: () => void): void {
  let pending = 0
  let pendingBytes = 0
  let stopped = false
  const stop = (code = 1008) => {
    if (stopped) return
    stopped = true
    socket.close(code)
    void endpoint.close().catch(() => undefined)
  }
  const send = (message: JsonRpcMessage) => {
    if (stopped) return
    const text = JSON.stringify(message)
    if (socket.bufferedAmount + Buffer.byteLength(text, 'utf8') > MAX_BUFFERED_BYTES) return stop(1013)
    socket.send(text, (error) => {
      if (error) stop(1011)
    })
  }
  socket.on('message', (data, binary) => {
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
    if (binary || bytes.length > WS_MAX_MESSAGE_BYTES || pending >= MAX_PENDING)
      return stop(binary ? 1003 : 1009)
    if (pendingBytes + bytes.length > MAX_BUFFERED_BYTES) return stop(1013)
    let message: JsonRpcMessage
    try {
      message = JSON.parse(bytes.toString()) as JsonRpcMessage
    } catch {
      return stop(1007)
    }
    pending++
    pendingBytes += bytes.length
    void endpoint
      .handle(message)
      .then((reply) => {
        if (reply) send(reply)
      })
      .catch(() => stop(1011))
      .finally(() => {
        pending--
        pendingBytes -= bytes.length
      })
  })
  socket.once('close', () => {
    stopped = true
    void endpoint.close().finally(onClose).catch(onClose)
  })
  socket.on('error', () => stop(1011))
  void (async () => {
    try {
      for await (const notification of endpoint.notifications) send(notification)
    } catch {
      stop(1011)
    }
  })()
}

export async function listenWebSocket(options: {
  addr: string
  cert?: string
  key?: string
  /** Explicit local mode: validated upgrade grants local single-user authority. */
  localOrigin?: string
  token: string
  endpoint(): { endpoint: RpcEndpoint; onClose(): void }
  /** Trusted backends for runtime client routes; every uninstalled operation refuses. */
  runtimeClient?: RuntimeClientPorts
  /** Private runtime HTTP listener. No WebSocket or legacy local-origin admission. */
  runtimeOnly?: { current(): Promise<boolean> }
}): Promise<{ url: string; stopAccepting(): Promise<void>; close(): Promise<void> }> {
  const { host, port } = target(options.addr)
  const local = options.localOrigin !== undefined
  if (local) {
    const origin = new URL(options.localOrigin as string)
    if (
      !['127.0.0.1', '::1'].includes(host) ||
      !['127.0.0.1', '[::1]'].includes(origin.hostname) ||
      origin.protocol !== 'http:' ||
      origin.origin !== options.localOrigin
    )
      throw new Error('local Web requires a literal loopback address and exact HTTP origin')
  } else if (options.runtimeOnly) {
    if (host !== '127.0.0.1' || port !== 0)
      throw new Error('runtime HTTP requires a random IPv4 loopback port')
  } else if (!options.cert || !options.key) throw new Error('remote WebSocket requires TLS')
  if (!options.token) throw new Error('WebSocket token is required')
  const server =
    local || options.runtimeOnly ? createHttpServer() : createServer({ cert: options.cert, key: options.key })
  const webSockets = new Set<WebSocket>()
  const transportSockets = new Set<Socket>()
  let stopping = false
  server.on('connection', (socket) => {
    if (stopping) {
      socket.destroy()
      return
    }
    transportSockets.add(socket)
    socket.once('close', () => transportSockets.delete(socket))
  })
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has('agnes-v1') ? 'agnes-v1' : false),
  })
  let expectedHost = ''
  // Upgrades and plain requests share one admission: local mode trusts only the exact page origin on
  // this host, remote mode needs the bearer.
  const refusal = (request: IncomingMessage): 401 | 403 | undefined => {
    if (local && (request.headers.origin !== options.localOrigin || request.headers.host !== expectedHost))
      return 403
    const bearer = protocolBearer(request.headers['sec-websocket-protocol'])
    if (
      !local &&
      !authorized(request.headers.authorization, options.token) &&
      !authorized(`Bearer ${bearer ?? ''}`, options.token)
    )
      return 401
    return undefined
  }
  const runtime = runtimeClientRoutes(options.runtimeClient ?? {})
  server.on('request', async (request, response) => {
    if (stopping) return void request.socket.destroy()
    if (options.runtimeOnly) {
      // Reject before parsing or consuming a body. Neither Origin nor WS protocol credentials
      // authorize this private HTTP capability; owner replacement and shutdown fence every read.
      const current = authorized(request.headers.authorization, options.token)
        ? await options.runtimeOnly.current().catch(() => false)
        : false
      if (!current || stopping) return void response.writeHead(401, { Connection: 'close' }).end()
      if (request.headers.host !== expectedHost || request.headers.origin !== undefined)
        return void response.writeHead(403, { Connection: 'close' }).end()
    }
    const status = options.runtimeOnly ? undefined : refusal(request)
    if (status) return void response.writeHead(status, { Connection: 'close' }).end()
    void runtime(request, response).then(
      (served) => {
        if (!served) response.writeHead(404).end()
      },
      () => {
        if (response.headersSent) response.destroy()
        else response.writeHead(500, { Connection: 'close' }).end()
      },
    )
  })
  server.on('upgrade', (request, socket, head) => {
    if (stopping) {
      socket.destroy()
      return
    }
    const status = options.runtimeOnly ? 403 : refusal(request)
    if (status) {
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`)
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request))
  })
  wss.on('connection', (ws) => {
    webSockets.add(ws)
    const connection = options.endpoint()
    bind(ws, connection.endpoint, () => connection.onClose())
    ws.once('close', () => webSockets.delete(ws))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const actual = server.address() as AddressInfo
  const printableHost = actual.family === 'IPv6' ? `[${actual.address}]` : actual.address
  expectedHost = `${printableHost}:${actual.port}`
  let closing: Promise<void> | undefined
  let serverClosed: Promise<void> | undefined
  const stopAccepting = (): Promise<void> => {
    stopping = true
    serverClosed ??= new Promise<void>((resolve) => server.close(() => resolve()))
    return Promise.resolve()
  }
  return {
    url: `${options.runtimeOnly ? 'http' : local ? 'ws' : 'wss'}://${printableHost}:${actual.port}`,
    stopAccepting,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        void stopAccepting()
        // This is the final socket phase, after the shutdown notice and worker drain. A peer that
        // ignores a WebSocket close handshake must not keep the daemon lock alive indefinitely.
        for (const ws of webSockets) ws.terminate()
        for (const socket of transportSockets) socket.destroy()
        // In noServer mode WSS owns no listener handle. Once every tracked transport is destroyed,
        // the HTTPS server close is the authoritative resource boundary; a stale WSS client record
        // must not hold the daemon lock indefinitely.
        wss.close()
        void serverClosed?.then(resolve)
      })),
  }
}
