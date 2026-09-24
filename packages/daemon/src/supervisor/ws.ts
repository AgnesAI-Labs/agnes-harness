import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import { type WebSocket, WebSocketServer } from 'ws'
import type { RpcEndpoint } from '../local/endpoint.js'
import type { JsonRpcMessage } from '../rpc.js'

export const WS_MAX_MESSAGE_BYTES = 2 * 1024 * 1024
const MAX_PENDING = 1_000
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024

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
  let stopped = false
  const stop = (code = 1008) => {
    if (stopped) return
    stopped = true
    socket.close(code)
    void endpoint.close().catch(() => undefined)
  }
  const send = (message: JsonRpcMessage) => {
    if (stopped || socket.bufferedAmount > MAX_BUFFERED_BYTES) return stop(1013)
    socket.send(JSON.stringify(message), (error) => {
      if (error) stop(1011)
    })
  }
  socket.on('message', (data, binary) => {
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
    if (binary || bytes.length > WS_MAX_MESSAGE_BYTES || pending >= MAX_PENDING)
      return stop(binary ? 1003 : 1009)
    let message: JsonRpcMessage
    try {
      message = JSON.parse(bytes.toString()) as JsonRpcMessage
    } catch {
      return stop(1007)
    }
    pending++
    void endpoint
      .handle(message)
      .then((reply) => {
        if (reply) send(reply)
      })
      .catch(() => stop(1011))
      .finally(() => pending--)
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
  } else if (!options.cert || !options.key) throw new Error('remote WebSocket requires TLS')
  if (!options.token) throw new Error('WebSocket token is required')
  const server = local ? createHttpServer() : createServer({ cert: options.cert, key: options.key })
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
  server.on('upgrade', (request, socket, head) => {
    if (stopping) {
      socket.destroy()
      return
    }
    if (local && (request.headers.origin !== options.localOrigin || request.headers.host !== expectedHost)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const bearer = protocolBearer(request.headers['sec-websocket-protocol'])
    if (
      !local &&
      !authorized(request.headers.authorization, options.token) &&
      !authorized(`Bearer ${bearer ?? ''}`, options.token)
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
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
    url: `${local ? 'ws' : 'wss'}://${printableHost}:${actual.port}`,
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
