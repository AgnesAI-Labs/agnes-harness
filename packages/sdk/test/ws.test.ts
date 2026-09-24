import { once } from 'node:events'
import { createServer } from 'node:http'
import { MAX_FRAME_BYTES } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { ProtocolViolation, TransportClosed } from '../src/errors.js'
import { RpcConnection } from '../src/rpc.js'
import type { CloseInfo, Transport } from '../src/transport/types.js'
import { wsTransport as browserTransport } from '../src/transport/ws.js'
import { wsTransport } from '../src/transport/ws.node.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function server() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(wss, 'listening')
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of wss.clients) socket.terminate()
        wss.close(() => resolve())
      }),
  )
  const address = wss.address()
  if (!address || typeof address === 'string') throw new Error('missing test socket')
  return { wss, url: `ws://127.0.0.1:${address.port}` }
}
it('round-trips text JSON and rejects pending RPC on actual peer termination', async () => {
  const s = await server()
  s.wss.on('connection', (socket) =>
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString())
      if (request.method === 'drop') {
        socket.terminate()
        return
      }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.params }))
    }),
  )
  let closed: CloseInfo | undefined
  const rpc = new RpcConnection(wsTransport({ url: s.url }), {
    requestTimeoutMs: 1000,
    onClose: (info) => {
      closed = info
    },
  })
  cleanup.push(() => rpc.close())
  await rpc.connect()
  expect(await rpc.request('echo', { text: '你好' })).toEqual({ text: '你好' })
  await expect(rpc.request('drop', {})).rejects.toBeInstanceOf(TransportClosed)
  expect(closed?.reason).toBe('eof')
})
it('uses the global WebSocket browser path on a real loopback connection', async () => {
  const s = await server()
  s.wss.on('connection', (socket) =>
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString())
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'native' }))
    }),
  )
  const rpc = new RpcConnection(browserTransport({ url: s.url }), { requestTimeoutMs: 1000 })
  cleanup.push(() => rpc.close())
  await rpc.connect()
  expect(await rpc.request('echo', {})).toBe('native')
})
it('passes browser-compatible subprotocols without enabling browser headers', async () => {
  const s = await server()
  let protocol = ''
  s.wss.on('connection', (socket) => {
    protocol = socket.protocol
  })
  const transport = await browserTransport({ url: s.url, protocols: ['agnes-v1'] })({
    onMessage() {},
    onClose() {},
  })
  cleanup.push(() => transport.close())
  expect(protocol).toBe('agnes-v1')
})
it.each(['binary', 'invalid-json', 'invalid-utf8', 'oversize'])(
  'rejects actual inbound %s messages',
  async (mode) => {
    const s = await server()
    s.wss.on('connection', (socket) => {
      if (mode === 'binary') socket.send(Buffer.from('{"jsonrpc":"2.0","method":"x"}'))
      else if (mode === 'invalid-json') socket.send('secret malformed input')
      else if (mode === 'invalid-utf8') socket.send(Buffer.from([0xc3, 0x28]), { binary: false })
      else socket.send('中'.repeat(Math.ceil(MAX_FRAME_BYTES / 3)))
    })
    let resolve!: (info: CloseInfo) => void
    const ended = new Promise<CloseInfo>((done) => {
      resolve = done
    })
    const transport = await wsTransport({ url: s.url })({
      onMessage: () => {
        throw new Error('unexpected delivery')
      },
      onClose: resolve,
    })
    cleanup.push(() => transport.close())
    const info = await ended
    expect(info.reason).toBe('error')
    expect(info.error?.message).not.toContain('secret malformed input')
  },
)
it('measures outbound UTF-8 bytes before sending and leaves the socket usable after refusal', async () => {
  const s = await server()
  const received: string[] = []
  s.wss.on('connection', (socket) => socket.on('message', (raw) => received.push(raw.toString())))
  const transport = await wsTransport({ url: s.url })({ onMessage() {}, onClose() {} })
  cleanup.push(() => transport.close())
  await expect(
    transport.send({ jsonrpc: '2.0', method: 'x', params: '中'.repeat(Math.ceil(MAX_FRAME_BYTES / 3)) }),
  ).rejects.toBeInstanceOf(ProtocolViolation)
  expect(received).toEqual([])
  await transport.send({ jsonrpc: '2.0', method: 'ok' })
  await transport.close()
})
it('redacts a failed upgrade URL and can open a fresh factory afterwards', async () => {
  const http = createServer((_req, response) => {
    response.writeHead(403)
    response.end('peer secret')
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  cleanup.push(() => new Promise<void>((resolve) => http.close(() => resolve())))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('missing HTTP socket')
  const failure = await wsTransport({ url: `ws://127.0.0.1:${address.port}/?token=private-marker` })({
    onMessage() {},
    onClose() {},
  }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(TransportClosed)
  expect(String(failure)).not.toContain('private-marker')
  expect(String(failure)).not.toContain('peer secret')
  const s = await server()
  const transport: Transport = await wsTransport({ url: s.url })({ onMessage() {}, onClose() {} })
  cleanup.push(() => transport.close())
})

it('sends actual ping frames and treats a pong as liveness before a later half-open timeout', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: false })
  await once(wss, 'listening')
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of wss.clients) socket.terminate()
        wss.close(() => resolve())
      }),
  )
  let pings = 0
  wss.on('connection', (socket) =>
    socket.on('ping', () => {
      if (++pings === 1) socket.pong()
    }),
  )
  const address = wss.address()
  if (!address || typeof address === 'string') throw new Error('missing ping socket')
  let resolve!: (info: CloseInfo) => void
  const ended = new Promise<CloseInfo>((done) => {
    resolve = done
  })
  const transport = await wsTransport({ url: `ws://127.0.0.1:${address.port}`, pingIntervalMs: 20 })({
    onMessage() {},
    onClose: resolve,
  })
  cleanup.push(() => transport.close())
  expect((await ended).error?.message).toBe('WebSocket ping timeout')
  expect(pings).toBe(3)
})
