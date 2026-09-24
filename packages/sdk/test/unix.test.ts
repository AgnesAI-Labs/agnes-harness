import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { windowsProcessStartTimeSync } from '@agnes/system-node'
import { afterEach, expect, it } from 'vitest'
import { TransportClosed } from '../src/errors.js'
import { createClient, unixTransport } from '../src/index.node.js'
import { memoryJournal } from '../src/journal.js'
import { RpcConnection } from '../src/rpc.js'
import { encodeFrame, FrameDecoder } from '../src/transport/jsonl.js'

const cleanup: Array<() => Promise<void>> = []
// The fixture listener lives in this process; this identity is never inferred from the peer.
function target(path: string) {
  if (!path.startsWith('\\\\.\\pipe\\')) return { path }
  const start = windowsProcessStartTimeSync(process.pid)
  if (!start) throw new Error('Test listener identity unavailable')
  return { path, serverIdentity: { pid: process.pid, processStartId: `win32:${process.pid}:${start}` } }
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function server(accept: (socket: Socket) => void) {
  const root = mkdtempSync(join(tmpdir(), 'sdk-unix-')),
    path = process.platform === 'win32' ? `\\\\.\\pipe\\agnes-sdk-${randomUUID()}` : join(root, 's.sock')
  const sockets = new Set<Socket>()
  const srv = createServer((s) => {
    sockets.add(s)
    s.on('error', () => {})
    s.on('close', () => sockets.delete(s))
    accept(s)
  })
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(path, () => {
      srv.off('error', reject)
      resolve()
    })
  })
  cleanup.push(async () => {
    for (const s of sockets) s.destroy()
    await new Promise<void>((r) => srv.close(() => r()))
    rmSync(root, { recursive: true, force: true })
  })
  return path
}
it('uses the default Node unix factory for a validated client handshake and call', async () => {
  const path = await server((socket) => {
    const decoder = new FrameDecoder()
    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (!('method' in frame) || !('id' in frame)) continue
        socket.write(
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
  const client = createClient({ journal: memoryJournal(), transport: { kind: 'unix', ...target(path) } })
  cleanup.push(() => client.close())
  expect(await client.call('_agnes/v1/apis.list', {})).toMatchObject({ profile: { name: 'p' }, families: [] })
})
it.each(['drop', 'truncated'])('settles pending requests on %s and refuses later sends', async (mode) => {
  const path = await server((socket) =>
    socket.on('data', () => (mode === 'drop' ? socket.end() : socket.end('{'))),
  )
  const notices: unknown[] = []
  const rpc = new RpcConnection(unixTransport(target(path)), {
    requestTimeoutMs: 1000,
    onClose: (info) => notices.push(info),
  })
  cleanup.push(() => rpc.close())
  await rpc.connect()
  await expect(rpc.request('ping', {})).rejects.toBeInstanceOf(TransportClosed)
  await expect(rpc.request('ping', {})).rejects.toBeInstanceOf(TransportClosed)
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({ reason: mode === 'drop' ? 'eof' : 'error' })
})
it('does not expose a missing path in the connection error', async () => {
  const path =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\PRIVATE-MARKER-${randomUUID()}`
      : '/missing/PRIVATE-MARKER.sock'
  const factory = unixTransport(target(path))
  const result = await factory({ onMessage() {}, onClose() {} }).catch((error: unknown) => error)
  expect(result).toBeInstanceOf(TransportClosed)
  expect(JSON.stringify(result)).not.toContain('PRIVATE-MARKER')
})

it('closes idempotently and refuses transport sends after explicit close', async () => {
  const path = await server(() => {})
  const notices: unknown[] = []
  const transport = await unixTransport(target(path))({
    onMessage() {},
    onClose: (info) => notices.push(info),
  })
  const first = transport.close()
  expect(transport.close()).toBe(first)
  await first
  await expect(transport.send({ jsonrpc: '2.0', method: 'ping' })).rejects.toBeInstanceOf(TransportClosed)
  expect(notices).toEqual([{ reason: 'closed' }])
})
