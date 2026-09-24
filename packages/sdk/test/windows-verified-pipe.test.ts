import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { windowsProcessStartTimeSync } from '@agnes/system-node'
import { listenWindowsPipe } from '@agnes/system-node/windows-pipe'
import { afterEach, describe, expect, it } from 'vitest'
import { TransportClosed } from '../src/errors.js'
import { createClient, unixTransport } from '../src/index.node.js'
import { memoryJournal } from '../src/journal.js'
import { RpcConnection } from '../src/rpc.js'
import { encodeFrame, FrameDecoder } from '../src/transport/jsonl.js'

const windows = process.platform === 'win32' // guards-allow-platform: actual authenticated native Windows transport.
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function server(onConnection: (stream: Duplex) => void) {
  const path = `\\\\.\\pipe\\sdk-verified-${randomUUID()}`
  const start = windowsProcessStartTimeSync(process.pid)
  if (!start) throw new Error('Current process identity unavailable')
  const listener = await listenWindowsPipe(path, 4, onConnection)
  cleanup.push(() => listener.close())
  return { path, serverIdentity: { pid: process.pid, processStartId: `win32:${process.pid}:${start}` } }
}

describe.skipIf(!windows)('verified Windows SDK connection', () => {
  it.each(['\\\\.\\pipe\\unverified', '\\\\?\\pipe\\unverified', '//./pipe/unverified', '/ordinary-path'])(
    'rejects missing trusted identity before connecting: %s',
    (path) => {
      expect(() => unixTransport({ path })).toThrow('requires a verified server identity')
      expect(() => createClient({ journal: memoryJournal(), transport: { kind: 'unix', path } })).toThrow(
        'requires a verified server identity',
      )
    },
  )
  it('does not allow ambiguous static and resolving identities', () => {
    const identity = { pid: 123, processStartId: 'win32:123:456' }
    expect(() =>
      unixTransport({
        path: '\\\\.\\pipe\\ambiguous',
        serverIdentity: identity,
        resolveServerIdentity: async () => identity,
      }),
    ).toThrow('either')
  })
  it('uses the default Node client factory for handshake and validated calls', async () => {
    const target = await server((stream) => {
      const decoder = new FrameDecoder()
      stream.on('data', (bytes: Buffer) => {
        for (const frame of decoder.push(bytes)) {
          if (!('method' in frame) || !('id' in frame)) continue
          stream.write(
            encodeFrame({
              jsonrpc: '2.0',
              id: frame.id,
              result:
                frame.method === 'initialize'
                  ? { protocolVersion: 1, agentCapabilities: {} }
                  : {
                      profile: {
                        name: 'p',
                        resolvedProfileHash: null,
                        presets: { default: 'p', allowed: ['p'] },
                      },
                      families: [],
                    },
            }),
          )
        }
      })
    })
    const client = createClient({ journal: memoryJournal(), transport: { kind: 'unix', ...target } })
    cleanup.push(() => client.close())
    expect(await client.call('_agnes/v1/apis.list', {})).toMatchObject({
      profile: { name: 'p' },
      families: [],
    })
  })

  it.each(['pid', 'processStartId'] as const)(
    'refuses wrong %s without fallback or application bytes',
    async (field) => {
      let received = 0
      const target = await server((stream) =>
        stream.on('data', (bytes: Buffer) => {
          received += bytes.length
        }),
      )
      if (field === 'pid') target.serverIdentity.pid++
      else target.serverIdentity.processStartId = '0'
      const notices: unknown[] = []
      await expect(
        unixTransport(target)({ onMessage() {}, onClose: (info) => notices.push(info) }),
      ).rejects.toBeInstanceOf(TransportClosed)
      expect(received).toBe(0)
      expect(notices).toHaveLength(1)
      expect(JSON.stringify(notices)).not.toContain(target.path)
    },
  )

  it.each(['drop', 'truncated'])('settles pending requests on %s', async (mode) => {
    const target = await server((stream) => stream.on('data', () => stream.end(mode === 'drop' ? '' : '{')))
    const notices: unknown[] = []
    const rpc = new RpcConnection(unixTransport(target), {
      requestTimeoutMs: 1000,
      onClose: (info) => notices.push(info),
    })
    cleanup.push(() => rpc.close())
    await rpc.connect()
    await expect(rpc.request('ping', {})).rejects.toBeInstanceOf(TransportClosed)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ reason: mode === 'drop' ? 'eof' : 'error' })
  })

  it('snapshots identity and waits for idempotent close before refusing sends', async () => {
    const target = await server(() => {})
    Object.assign(target.serverIdentity, { path: 'must-not-override-target' })
    const factory = unixTransport(target)
    target.serverIdentity.processStartId = '0'
    const notices: unknown[] = []
    const transport = await factory({ onMessage() {}, onClose: (info) => notices.push(info) })
    cleanup.push(() => transport.close())
    const closing = transport.close()
    expect(transport.close()).toBe(closing)
    await closing
    await expect(transport.send({ jsonrpc: '2.0', method: 'ping' })).rejects.toBeInstanceOf(TransportClosed)
    expect(notices).toEqual([{ reason: 'closed' }])
  })
})

it('refuses to apply a Windows server identity to a Unix socket', () => {
  expect(() =>
    unixTransport({ path: '/tmp/socket', serverIdentity: { pid: 1, processStartId: '1' } }),
  ).toThrow('Windows pipe')
})
