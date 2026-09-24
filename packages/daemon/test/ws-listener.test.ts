import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { connect as connectTcp } from 'node:net'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { RpcEndpoint } from '../src/local/endpoint.js'
import { listenWebSocket, WS_MAX_MESSAGE_BYTES } from '../src/supervisor/ws.js'

function tls(): { cert: string; key: string } {
  return {
    cert: readFileSync(
      new URL('../../../tools/test-fixtures/tls/localhost-cert.pem', import.meta.url),
      'utf8',
    ),
    key: readFileSync(new URL('../../../tools/test-fixtures/tls/localhost-key.pem', import.meta.url), 'utf8'),
  }
}

const endpoint = (): RpcEndpoint => ({
  async handle(message) {
    if (!('id' in message) || message.id === undefined) return undefined
    return { jsonrpc: '2.0', id: message.id, result: { accepted: true } }
  },
  notifications: (async function* () {})(),
  async close() {},
})

const connect = (url: string, token: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      rejectUnauthorized: false,
      headers: { Authorization: `Bearer ${token}` },
    })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })

const within = <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 1_000)
    timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

describe('daemon WebSocket listener', () => {
  it('requires the lifecycle bearer, permits reconnect and disconnects an oversized message', async () => {
    const material = tls()
    const listener = await listenWebSocket({
      addr: '127.0.0.1:0',
      ...material,
      token: 'test-lifecycle-token',
      endpoint: () => ({ endpoint: endpoint(), onClose() {} }),
    })
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(listener.url, { rejectUnauthorized: false })
        socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
        socket.once('error', reject)
      })
      expect(status).toBe(401)

      const browser = await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(listener.url, ['agnes-v1', 'agnes-bearer.test-lifecycle-token'], {
          rejectUnauthorized: false,
        })
        socket.once('open', () => resolve(socket))
        socket.once('error', reject)
      })
      expect(browser.protocol).toBe('agnes-v1')
      browser.close()

      const first = await connect(listener.url, 'test-lifecycle-token')
      const reply = new Promise<string>((resolve) =>
        first.once('message', (data) => resolve(data.toString())),
      )
      first.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }))
      expect(JSON.parse(await reply)).toMatchObject({ result: { accepted: true } })
      first.close()

      const second = await connect(listener.url, 'test-lifecycle-token')
      const closed = new Promise<number>((resolve) => second.once('close', (code) => resolve(code)))
      second.send('x'.repeat(WS_MAX_MESSAGE_BYTES + 1))
      expect(await closed).toBe(1009)

      const admitted = await connect(listener.url, 'test-lifecycle-token')
      const address = new URL(listener.url)
      const badPeer = connectTcp({ host: address.hostname, port: Number(address.port) })
      badPeer.on('error', () => undefined)
      await within(once(badPeer, 'connect'), 'bad peer connect')
      await listener.stopAccepting()

      const replyAfterStop = once(admitted, 'message')
      admitted.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }))
      expect(JSON.parse(String((await within(replyAfterStop, 'reply after stop'))[0]))).toMatchObject({
        result: { accepted: true },
      })
      const admittedClosed = once(admitted, 'close')
      const closing = listener.close()
      expect(listener.close()).toBe(closing)
      await within(closing, 'listener close')
      await within(admittedClosed, 'admitted close')
      badPeer.destroy()
    } finally {
      await listener.close()
    }
  })
})

it('local Web accepts no-token browser upgrades but rejects wrong Origin and Host before creating an endpoint', async () => {
  let opened = 0
  const origin = 'http://127.0.0.1:4177'
  const listener = await listenWebSocket({
    addr: '127.0.0.1:0',
    localOrigin: origin,
    token: 'test-local-token',
    endpoint: () => {
      opened++
      return { endpoint: endpoint(), onClose() {} }
    },
  })
  const rejected = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(listener.url, { headers })
      socket.once('unexpected-response', (_req, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      socket.once('open', () => {
        socket.close()
        reject(new Error('unexpected authorization'))
      })
      socket.once('error', reject)
    })
  try {
    const browser = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(listener.url, ['agnes-v1'], { headers: { Origin: origin } })
      socket.once('open', () => resolve(socket))
      socket.once('error', reject)
    })
    browser.close()
    expect(await rejected({})).toBe(403)
    expect(await rejected({ Origin: 'http://evil.example' })).toBe(403)
    expect(await rejected({ Origin: origin, Host: 'evil.example' })).toBe(403)
    expect(opened).toBe(1)
  } finally {
    await listener.close()
  }
})

it('local identity mode cannot listen on a public address or trust a non-loopback origin', async () => {
  for (const [addr, origin] of [
    ['0.0.0.0:0', 'http://127.0.0.1:4177'],
    ['127.0.0.1:0', 'http://evil.example'],
  ]) {
    await expect(
      listenWebSocket({
        addr: addr as string,
        localOrigin: origin as string,
        token: 'test-token',
        endpoint: () => ({ endpoint: endpoint(), onClose() {} }),
      }),
    ).rejects.toThrow('literal loopback')
  }
})
