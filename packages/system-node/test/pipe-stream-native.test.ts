import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { createServer, type Server, type Socket } from 'node:net'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { type OwnedPipe, WindowsPipeStream } from '../src/windows-pipe-stream.js'

const windows = process.platform === 'win32' // guards-allow-platform: actual Windows native pipe integration.
const native = windows
  ? (createRequire(import.meta.url)('@agnes/system-node/native') as {
      connectVerifiedPipe(path: string, pid: number, start: string): OwnedPipe
      processStartTime(pid: number): string | null
      reservePipeName(path: string, maximum: number): { close(): void }
    })
  : undefined
const owners: OwnedPipe[] = []
const sockets = new Set<Socket>()
const servers: Server[] = []
const streams: WindowsPipeStream[] = []
const pathFor = () => `\\\\.\\pipe\\agnes-stream-中文-${randomUUID()}`
function backend() {
  if (!native) throw new Error('Windows native module required')
  return native
}
function stamp() {
  const value = backend().processStartTime(process.pid)
  if (!value) throw new Error('Current process identity missing')
  return value
}
async function serve() {
  let received = 0
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    socket.on('data', (bytes) => {
      received += bytes.length
      socket.write(bytes)
    })
  })
  servers.push(server)
  const path = pathFor()
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return { server, path, received: () => received }
}
function open(path: string) {
  const owner = backend().connectVerifiedPipe(path, process.pid, stamp())
  owners.push(owner)
  return owner
}
afterEach(async () => {
  for (const stream of streams.splice(0)) {
    if (!stream.closed) {
      const closed = once(stream, 'close')
      stream.destroy()
      await closed
    }
  }
  for (const owner of owners.splice(0)) await owner.close()
  for (const socket of sockets) socket.destroy()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe.skipIf(!windows)('native verified pipe stream', () => {
  it('transfers more than the protocol payload limit through bounded native writes', async () => {
    const { path } = await serve()
    const stream = new WindowsPipeStream(open(path))
    streams.push(stream)
    stream.on('error', () => {})
    const payload = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61)
    payload.write('中文末尾', payload.length - 16)
    const received = new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      stream.on('data', (bytes: Buffer) => {
        chunks.push(bytes)
        size += bytes.length
        if (size === payload.length) resolve(Buffer.concat(chunks))
      })
    })
    const sent = new Promise<void>((resolve, reject) =>
      stream.write(payload, (error) => (error ? reject(error) : resolve())),
    )
    const echoed = await received
    expect(echoed.length).toBe(payload.length)
    expect(createHash('sha256').update(echoed).digest('hex')).toBe(
      createHash('sha256').update(payload).digest('hex'),
    )
    await sent
  })

  it.each(['pid', 'start'] as const)('rejects wrong %s before sending application bytes', async (part) => {
    const { path, server, received } = await serve()
    const closed = new Promise<void>((resolve) =>
      server.once('connection', (socket) => socket.once('close', resolve)),
    )
    expect(() =>
      backend().connectVerifiedPipe(
        path,
        part === 'pid' ? process.pid + 1 : process.pid,
        part === 'start' ? '0' : stamp(),
      ),
    ).toThrow('identity mismatch')
    await closed
    expect(received()).toBe(0)
  })

  it('cancels a pending read, refuses duplicate reads and oversized writes, and closes idempotently', async () => {
    const { path } = await serve()
    const owner = open(path)
    const reading = owner.read()
    const cancelled = expect(reading).rejects.toMatchObject({ code: 'ECANCELED' })
    expect(() => owner.read()).toThrow('already pending')
    expect(() => owner.read.call({})).toThrow('Invalid native pipe')
    expect(() => owner.write(Buffer.alloc(65537))).toThrow('64 KiB')
    const closing = owner.close()
    expect(owner.close()).toBe(closing)
    await closing
    await cancelled
    await owner.close()
    expect(() => owner.read()).toThrow('closed')
  })

  it('releases native reads and handles when a Worker exits', async () => {
    const { path, server } = await serve()
    for (let i = 0; i < 12; i++) {
      const disconnected = new Promise<void>((resolve) =>
        server.once('connection', (socket) => socket.once('close', resolve)),
      )
      const worker = new Worker(
        `const { parentPort, workerData } = require('node:worker_threads');
         const native = require(workerData.module);
         const owner = native.connectVerifiedPipe(workerData.path, process.pid, native.processStartTime(process.pid));
         global.owner = owner;
         owner.read().catch(() => {});
         parentPort.postMessage('reading');`,
        {
          eval: true,
          workerData: { path, module: createRequire(import.meta.url).resolve('@agnes/system-node/native') },
        },
      )
      try {
        expect(await once(worker, 'message')).toEqual(['reading'])
      } finally {
        await worker.terminate()
      }
      await disconnected
    }
  })

  it('retains Windows failure information for a busy or missing local pipe', () => {
    const path = pathFor()
    const reservation = backend().reservePipeName(path, 8)
    try {
      expect(() => backend().connectVerifiedPipe(path, process.pid, stamp())).toThrow(
        expect.objectContaining({ win32Code: 231 }),
      )
    } finally {
      reservation.close()
    }
    expect(() => backend().connectVerifiedPipe(path, process.pid, stamp())).toThrow(
      expect.objectContaining({ code: 'ENOENT', win32Code: 2 }),
    )
  })
})
