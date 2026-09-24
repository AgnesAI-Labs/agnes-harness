import { once } from 'node:events'
import { duplexPair } from 'node:stream'
import { expect, it, vi } from 'vitest'
import type { RpcEndpoint } from '../src/local/endpoint.js'
import { bindConnection } from '../src/supervisor/connection.js'
import { encodeFrame } from '../src/supervisor/framing.js'
import { WorkerLink } from '../src/supervisor/worker-link.js'

it('handles split UTF-8 RPC frames and flushes a terminal error through a plain Duplex', async () => {
  const [server, peer] = duplexPair()
  const handle = vi.fn<RpcEndpoint['handle']>(async (message) => {
    if (!('id' in message) || message.id === undefined) return undefined
    return { jsonrpc: '2.0', id: message.id, result: '中文回复' }
  })
  const close = vi.fn(async () => {})
  const onClose = vi.fn()
  const endpoint: RpcEndpoint = {
    handle,
    close,
    notifications: (async function* () {})(),
  }
  const connection = bindConnection(server, endpoint, { onClose })
  try {
    const frame = encodeFrame({ jsonrpc: '2.0', id: 1, method: '中文请求' })
    const cut = frame.indexOf(Buffer.from('中')) + 1
    const response = once(peer, 'data')
    peer.write(frame.subarray(0, cut))
    expect(handle).not.toHaveBeenCalled()
    peer.write(frame.subarray(cut))
    expect(JSON.parse((await response)[0].toString())).toEqual({ jsonrpc: '2.0', id: 1, result: '中文回复' })
    expect(handle).toHaveBeenCalledOnce()
    const terminal = once(peer, 'data')
    peer.write('null\n')
    expect(JSON.parse((await terminal)[0].toString())).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600 },
    })
    await connection.closed
    expect(server.destroyed).toBe(true)
    expect(close).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  } finally {
    server.destroy()
    peer.destroy()
    await connection.closed
  }
})

it('settles worker replies and rejects outstanding work when a plain Duplex closes', async () => {
  const [server, peer] = duplexPair()
  const link = new WorkerLink(server, { onEvent() {}, async onRequest() {} })
  try {
    const outgoing = once(peer, 'data')
    const reply = link.command('ping', {}, { timeoutMs: 1000 })
    const request = JSON.parse((await outgoing)[0].toString())
    const frame = encodeFrame({ kind: 'reply', requestId: request.requestId, result: '中文结果' })
    peer.write(frame.subarray(0, 7))
    peer.write(frame.subarray(7))
    await expect(reply).resolves.toBe('中文结果')
    const pending = link.command('ping', {}, { timeoutMs: 1000 })
    const rejected = expect(pending).rejects.toThrow('worker link closed')
    server.destroy()
    await rejected
    expect(link.alive).toBe(false)
  } finally {
    server.destroy()
    peer.destroy()
  }
})
