import { afterEach, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { TransportClosed } from '../src/errors.js'
import { RpcConnection } from '../src/rpc.js'
import type { JsonRpcMessage, TransportFactory } from '../src/transport/types.js'
import { wsTransport } from '../src/transport/ws.node.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})
it('retires old transport callbacks and keeps request IDs monotonic', async () => {
  const generations: Array<{
    h: Parameters<TransportFactory>[0]
    sent: JsonRpcMessage[]
    close: ReturnType<typeof vi.fn>
  }> = []
  const factory: TransportFactory = async (h) => {
    const sent: JsonRpcMessage[] = []
    const close = vi.fn(async () => {
      h.onClose({ reason: 'closed' })
    })
    generations.push({ h, sent, close })
    return {
      kind: 'inproc',
      send: async (message) => {
        sent.push(message)
      },
      close,
    }
  }
  const onClose = vi.fn()
  const rpc = new RpcConnection(factory, { requestTimeoutMs: 1000, onClose })
  closes.push(() => rpc.close())
  await rpc.connect()
  const old = generations[0]
  if (!old) throw new Error('missing generation')
  const pending = rpc.request('old', {}).catch((error: unknown) => error)
  old.h.onClose({ reason: 'eof' })
  expect(await pending).toBeInstanceOf(TransportClosed)
  await rpc.connect()
  expect(old.close).toHaveBeenCalledOnce()
  const next = generations[1]
  if (!next) throw new Error('missing generation')
  const notice = vi.fn()
  rpc.onNotification(notice)
  const result = rpc.request('new', {})
  const frame = next.sent[0]
  if (!frame || !('id' in frame)) throw new Error('missing request')
  expect(frame.id).toBe(2)
  old.h.onMessage({ jsonrpc: '2.0', method: 'stale', params: {} })
  old.h.onMessage({ jsonrpc: '2.0', id: frame.id, result: 'stale' })
  old.h.onClose({ reason: 'error' })
  expect(rpc.connected).toBe(true)
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(notice).not.toHaveBeenCalled()
  next.h.onMessage({ jsonrpc: '2.0', id: frame.id, result: 'current' })
  expect(await result).toBe('current')
})
it('does not send an old permission response to a new real WebSocket connection', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  closes.push(async () => {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing socket')
  const received: unknown[] = []
  let count = 0
  server.on('connection', (socket) => {
    count++
    if (count === 1) socket.send(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'permission', params: {} }))
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      received.push(message)
      if (message.method === 'barrier')
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }))
    })
  })
  let resolvePermission!: (value: unknown) => void
  let started!: () => void
  const began = new Promise<void>((resolve) => {
    started = resolve
  })
  const decision = new Promise<unknown>((resolve) => {
    resolvePermission = resolve
  })
  let disconnected!: () => void
  const ended = new Promise<void>((resolve) => {
    disconnected = resolve
  })
  const rpc = new RpcConnection(wsTransport({ url: `ws://127.0.0.1:${address.port}` }), {
    requestTimeoutMs: 1000,
    onClose: disconnected,
  })
  closes.push(() => rpc.close())
  rpc.onServerRequest(async () => {
    started()
    return decision
  })
  await rpc.connect()
  await began
  for (const socket of server.clients) socket.terminate()
  await ended
  await rpc.connect()
  resolvePermission({ decision: 'allow' })
  await decision
  await Promise.resolve()
  await rpc.request('barrier', {})
  expect(count).toBe(2)
  expect(received).toHaveLength(1)
  expect(received[0]).toMatchObject({ method: 'barrier' })
})
