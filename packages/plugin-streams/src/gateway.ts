import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  PLUGIN_STREAM_MAX_BYTES,
  PLUGIN_STREAM_OPEN_PATH,
  PLUGIN_STREAM_PATH,
  PLUGIN_STREAM_SOURCE_OPEN_PATH,
  PLUGIN_STREAM_SOURCE_PATH,
  validatePluginStreamOpen,
} from '@agnes/protocol'
import { WebSocketServer } from 'ws'
import { type PluginStreamBroker, PluginStreamError, type StreamPrincipal } from './broker.js'

export type PluginStreamGateway = {
  handleHttp(request: IncomingMessage, response: ServerResponse): Promise<boolean>
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean>
  close(): void
}
/** The authentication adapter resolves a live user connection (cookie/Portal subject), not source-auth alone. */
export function createPluginStreamGateway(options: {
  origin: string
  broker: PluginStreamBroker
  authenticate(request: IncomingMessage, signal: AbortSignal): Promise<StreamPrincipal | null>
  /** Node-only source-auth plus separately admitted user subject. Browser Origin is forbidden here. */
  source?: boolean
}): PluginStreamGateway {
  const origin = new URL(options.origin)
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.origin !== options.origin ||
    origin.username ||
    origin.password
  )
    throw new TypeError('exact stream origin required')
  const openPath = options.source ? PLUGIN_STREAM_SOURCE_OPEN_PATH : PLUGIN_STREAM_OPEN_PATH
  const socketPath = options.source ? PLUGIN_STREAM_SOURCE_PATH : PLUGIN_STREAM_PATH
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: PLUGIN_STREAM_MAX_BYTES,
    perMessageDeflate: false,
  })
  let pending = 0
  let closed = false
  const lifetime = new AbortController()
  const connections = new Set<Duplex>()
  const allowed = (request: IncomingMessage) =>
    !closed &&
    (options.source ? request.headers.origin === undefined : request.headers.origin === origin.origin) &&
    request.headers.host === origin.host &&
    (!request.headers['sec-fetch-site'] || request.headers['sec-fetch-site'] === 'same-origin')
  async function authenticated(
    request: IncomingMessage,
    signal: AbortSignal,
  ): Promise<StreamPrincipal | null> {
    // Authentication and admission cannot hold an upgrade/body slot forever even if an adapter ignores abort.
    return Promise.race([
      options.authenticate(request, signal),
      new Promise<null>((resolve) => {
        if (signal.aborted) resolve(null)
        else signal.addEventListener('abort', () => resolve(null), { once: true })
      }),
    ])
  }
  return {
    async handleHttp(request, response) {
      if (request.url !== openPath) return false
      const reply = (status: number, body: unknown) => {
        if (response.destroyed || response.writableEnded) return
        response.writeHead(status, {
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=utf-8',
          'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
        })
        response.end(JSON.stringify(body))
      }
      if (
        !allowed(request) ||
        request.method !== 'POST' ||
        (!options.source && request.headers['x-agnes-stream-open'] !== '1') ||
        request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json'
      ) {
        request.resume()
        reply(403, { error: 'REFUSED' })
        return true
      }
      if (pending >= 64) {
        request.resume()
        reply(429, { error: 'OVERLOADED' })
        return true
      }
      pending++
      const abort = new AbortController()
      const signal = AbortSignal.any([lifetime.signal, abort.signal])
      const deadline = setTimeout(() => {
        abort.abort()
        reply(408, { error: 'REFUSED' })
        request.destroy()
      }, 5000)
      deadline.unref?.()
      const disconnected = () => abort.abort()
      response.once('close', disconnected)
      try {
        const principal = await authenticated(request, signal)
        if (!principal || signal.aborted) {
          request.resume()
          reply(401, { error: 'REFUSED' })
          return true
        }
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += bytes.byteLength
          if (size > 65536) {
            request.resume()
            reply(413, { error: 'INVALID' })
            return true
          }
          chunks.push(bytes)
        }
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const parsed = validatePluginStreamOpen(input)
        if (!parsed.ok || (!options.source && !parsed.value.client)) throw new PluginStreamError('REFUSED')
        const grant = await Promise.race([
          options.broker.open(principal, input, signal),
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(new PluginStreamError('REFUSED'))
            else
              signal.addEventListener('abort', () => reject(new PluginStreamError('REFUSED')), { once: true })
          }),
        ])
        if (!signal.aborted) reply(200, grant)
      } catch (error) {
        reply(error instanceof PluginStreamError && error.code === 'OVERLOADED' ? 429 : 403, {
          error: error instanceof PluginStreamError ? error.code : 'REFUSED',
        })
      } finally {
        clearTimeout(deadline)
        response.removeListener('close', disconnected)
        abort.abort()
        pending--
      }
      return true
    },
    async handleUpgrade(request, socket, head) {
      if (request.url !== socketPath) return false
      const reject = () => {
        if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      }
      if (!allowed(request) || request.method !== 'GET' || pending >= 64) {
        reject()
        return true
      }
      pending++
      const abort = new AbortController()
      const signal = AbortSignal.any([lifetime.signal, abort.signal])
      const deadline = setTimeout(() => {
        abort.abort()
        socket.destroy()
      }, 5000)
      deadline.unref?.()
      const disconnected = () => abort.abort()
      socket.once('close', disconnected)
      try {
        const principal = await authenticated(request, signal)
        if (!principal || signal.aborted || socket.destroyed) {
          reject()
          return true
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          connections.add(socket)
          let closeTimer: ReturnType<typeof setTimeout> | undefined
          const peer = {
            get bufferedAmount() {
              return ws.bufferedAmount
            },
            send(data: string | Uint8Array, done: (error?: Error) => void) {
              ws.send(data, done)
            },
            close(code: number, reason: string) {
              ws.close(code, reason)
              closeTimer ??= setTimeout(() => ws.terminate(), 1000)
              closeTimer.unref?.()
            },
          }
          ws.once('close', () => {
            if (closeTimer) clearTimeout(closeTimer)
            connections.delete(socket)
          })
          ws.on('error', () => {})
          let stream: ReturnType<PluginStreamBroker['connect']>
          try {
            stream = options.broker.connect(principal, peer)
          } catch {
            return
          }
          ws.on('message', (data, binary) => {
            const bytes = Buffer.isBuffer(data)
              ? data
              : Array.isArray(data)
                ? Buffer.concat(data)
                : Buffer.from(data)
            stream.receive(bytes, binary)
          })
          ws.once('close', () => {
            if (closeTimer) clearTimeout(closeTimer)
            connections.delete(socket)
            stream.disconnect()
          })
          ws.on('error', () => stream.disconnect())
        })
      } catch {
        reject()
      } finally {
        clearTimeout(deadline)
        socket.removeListener('close', disconnected)
        abort.abort()
        pending--
      }
      return true
    },
    close() {
      if (closed) return
      closed = true
      lifetime.abort()
      options.broker.close()
      for (const socket of connections) socket.destroy()
      connections.clear()
      wss.close()
    },
  }
}

/** Separate Node path: its adapter must verify source-auth, anti-replay and a user-subject grant.
 * Source identity alone must return null. A browser can never enter this path by supplying Origin. */
export function createSourcePluginStreamGateway(options: {
  origin: string
  broker: PluginStreamBroker
  authenticate(request: IncomingMessage, signal: AbortSignal): Promise<StreamPrincipal | null>
}): PluginStreamGateway {
  return createPluginStreamGateway({ ...options, source: true })
}
