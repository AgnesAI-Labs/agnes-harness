import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { PLUGIN_STREAM_OPEN_PATH, PLUGIN_STREAM_PATH, validatePluginStreamOpen } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'

/** Same-origin launcher relay. The private worker capability is never included in a browser response. */
export function pluginStreamProxy(input: {
  client: Client
  origin: string
  profile: string
  initialize(): Promise<unknown>
  body(request: IncomingMessage): Promise<Record<string, unknown> | undefined>
}) {
  const sockets = new Set<Duplex>()
  let closed = false
  const allowed = (req: IncomingMessage) =>
    !closed &&
    req.headers.host === new URL(input.origin).host &&
    req.headers.origin === input.origin &&
    (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin')
  const endpoint = async () => {
    await input.initialize()
    return input.client.call<{ host: '127.0.0.1'; port: number; proof: string }>(
      '_agnes/v1/pluginStreams.endpoint',
      { origin: input.origin },
    )
  }
  return {
    async handleHttp(req: IncomingMessage, res: ServerResponse) {
      if (req.url !== PLUGIN_STREAM_OPEN_PATH) return false
      const refuse = () => {
        req.resume()
        if (!res.destroyed && !res.writableEnded)
          res
            .writeHead(403, { 'cache-control': 'no-store', 'content-type': 'application/json' })
            .end('{"error":"REFUSED"}')
      }
      if (
        !allowed(req) ||
        req.method !== 'POST' ||
        req.headers['x-agnes-stream-open'] !== '1' ||
        req.headers['content-type']?.split(';')[0] !== 'application/json'
      ) {
        refuse()
        return true
      }
      try {
        const body = await input.body(req),
          parsed = validatePluginStreamOpen(body)
        if (!parsed.ok || !parsed.value.client) throw new Error('invalid-stream-open')
        const call = parsed.value
        await input.initialize()
        if (closed || res.destroyed) {
          refuse()
          return true
        }
        const row = (
          await input.client.clientModules.list(
            input.profile,
            call.scope.kind === 'session' ? call.scope.sessionId : undefined,
          )
        ).rows.find((r) => r.rowId === call.client?.rowId)
        if (closed || res.destroyed) {
          refuse()
          return true
        }
        if (
          !row?.enabled ||
          row.phase !== 'ready' ||
          row.moduleName !== call.owner ||
          row.revision !== call.client?.revision ||
          row.contentDigest !== call.client?.contentDigest ||
          !row.streams?.includes(call.name) ||
          row.binding?.availability !== 'active' ||
          row.binding.profileId !== input.profile
        )
          throw new Error('stream-row-refused')
        const target = await endpoint()
        if (closed || res.destroyed) {
          refuse()
          return true
        }
        const upstream = httpRequest(
          {
            host: target.host,
            port: target.port,
            path: PLUGIN_STREAM_OPEN_PATH,
            method: 'POST',
            headers: {
              host: new URL(input.origin).host,
              origin: input.origin,
              'content-type': 'application/json',
              'x-agnes-stream-open': '1',
              'x-agnes-stream-proof': target.proof,
              'x-agnes-stream-row': Buffer.from(JSON.stringify(row)).toString('base64url'),
            },
          },
          (reply) => {
            res.writeHead(reply.statusCode ?? 503, {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            })
            reply.pipe(res)
          },
        )
        upstream.setTimeout(5000, () => upstream.destroy())
        upstream.on('error', refuse)
        res.once('close', () => upstream.destroy())
        upstream.end(JSON.stringify(call))
      } catch {
        refuse()
      }
      return true
    },
    async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      if (req.url !== PLUGIN_STREAM_PATH) return false
      const refuse = () => {
        if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      }
      if (!allowed(req) || req.method !== 'GET') {
        refuse()
        return true
      }
      try {
        const target = await endpoint()
        if (closed || socket.destroyed) {
          refuse()
          return true
        }
        const upstream = httpRequest({
          host: target.host,
          port: target.port,
          path: PLUGIN_STREAM_PATH,
          headers: {
            host: new URL(input.origin).host,
            origin: input.origin,
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-key': String(req.headers['sec-websocket-key'] ?? ''),
            'sec-websocket-version': '13',
            'x-agnes-stream-proof': target.proof,
          },
        })
        upstream.setTimeout(5000, () => upstream.destroy())
        upstream.once('upgrade', (reply, peer, upstreamHead) => {
          upstream.setTimeout(0)
          if (closed || socket.destroyed) {
            peer.destroy()
            return
          }
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${String(reply.headers['sec-websocket-accept'])}\r\n\r\n`,
          )
          sockets.add(socket)
          sockets.add(peer)
          if (upstreamHead.length) socket.write(upstreamHead)
          if (head.length) peer.write(head)
          socket.pipe(peer).pipe(socket)
          socket.once('close', () => {
            sockets.delete(socket)
            peer.destroy()
          })
          peer.once('close', () => {
            sockets.delete(peer)
            socket.destroy()
          })
          socket.on('error', () => peer.destroy())
          peer.on('error', () => socket.destroy())
        })
        upstream.once('response', () => {
          upstream.destroy()
          refuse()
        })
        upstream.once('error', refuse)
        socket.once('close', () => upstream.destroy())
        upstream.end()
      } catch {
        refuse()
      }
      return true
    },
    close() {
      closed = true
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    },
  }
}
