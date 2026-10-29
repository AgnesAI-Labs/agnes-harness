import { encodePluginStreamBinary } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPluginStreamsClient, type PluginStreamSocket } from '../src/plugin-streams.js'

class Socket implements PluginStreamSocket {
  bufferedAmount = 0
  binaryType = ''
  sent: (string | Uint8Array)[] = []
  closes = 0
  listeners = new Map<string, Set<(event: { data?: unknown; reason?: string }) => void>>()
  addEventListener(type: string, fn: (event: { data?: unknown; reason?: string }) => void) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(fn)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, fn: (event: { data?: unknown; reason?: string }) => void) {
    this.listeners.get(type)?.delete(fn)
  }
  emit(type: string, event: { data?: unknown; reason?: string } = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }
  send(data: string | Uint8Array) {
    this.sent.push(data)
  }
  close() {
    this.closes++
  }
}
afterEach(() => vi.useRealTimers())
function fixture(lane: 'media' | 'control' | 'events' = 'media') {
  const socket = new Socket(),
    abort = new AbortController()
  let url = ''
  const client = createPluginStreamsClient({
    origin: 'http://127.0.0.1:1234',
    owner: 'sample/plugin',
    client: {
      rowId: 'web:sample/plugin',
      revision: 'revision-one',
      contentDigest: `sha256-${'0'.repeat(64)}`,
    },
    scope: { kind: 'profile', profileId: 'one' },
    names: ['sample.frames'],
    signal: abort.signal,
    async open(input) {
      expect(input.owner).toBe('sample/plugin')
      return {
        ticket: 'synthetic-ticket',
        expiresAt: 10000,
        path: '/_agnes/plugin-stream',
        streamId: 7,
        lane,
      }
    },
    socket(address) {
      url = address
      return socket
    },
  })
  return {
    client,
    socket,
    abort,
    get url() {
      return url
    },
    async ready() {
      const pending = client.open('sample.frames', {})
      await Promise.resolve()
      await Promise.resolve()
      socket.emit('open')
      socket.emit('message', { data: JSON.stringify({ ready: true, streamId: 7 }) })
      return pending
    },
  }
}
describe('plugin streams SDK', () => {
  it('keeps tickets out of URLs, binds the allowlist and dispatches atomic binary frames', async () => {
    const f = fixture(),
      stream = await f.ready()
    expect(f.url).toBe('ws://127.0.0.1:1234/_agnes/plugin-stream')
    expect(f.socket.sent).toEqual(['{"ticket":"synthetic-ticket"}'])
    await expect(f.client.open('other.frames', {})).rejects.toThrow('not declared')
    const received: unknown[] = []
    stream.onFrame((frame) => received.push(frame))
    f.socket.emit('message', { data: encodePluginStreamBinary(7, 0, new Uint8Array([4, 5])).buffer })
    expect(received).toEqual([new Uint8Array([4, 5])])
    let disconnects = 0
    stream.onDisconnect(() => {
      disconnects++
    })
    f.abort.abort()
    f.socket.emit('close')
    await Promise.resolve()
    await Promise.resolve()
    expect(disconnects).toBe(1)
    expect(f.socket.closes).toBe(1)
    expect([...f.socket.listeners.values()].every((s) => s.size === 0)).toBe(true)
  })
  it('closes control on buffered overload and rejects foreign/replayed frames', async () => {
    const f = fixture('control'),
      stream = await f.ready()
    expect(stream.send({ stop: true })).toBe('accepted')
    f.socket.bufferedAmount = 32768
    expect(stream.send({ stop: true })).toBe('closed')
    for (const id of [7, 8]) {
      const c = fixture(),
        s = await c.ready()
      const bytes = encodePluginStreamBinary(id, 0, new Uint8Array([1]))
      c.socket.emit('message', { data: bytes.buffer })
      c.socket.emit('message', { data: bytes.buffer })
      expect(s.send({})).toBe('closed')
      expect(c.socket.closes).toBe(1)
    }
  })
  it('times out missing acknowledgement and refuses canceled opens', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      pending = f.client.open('sample.frames', {})
    const failure = expect(pending).rejects.toThrow('refused')
    await vi.advanceTimersByTimeAsync(5000)
    await failure
    const c = fixture()
    c.abort.abort()
    await expect(c.client.open('sample.frames', {})).rejects.toThrow()
  })
})
