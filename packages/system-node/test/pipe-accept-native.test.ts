import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWindowsPipeListener,
  type PipeAccept,
  type PipeReservation,
} from '../src/windows-pipe-listener.js'
import type { OwnedPipe, WindowsPipeStream } from '../src/windows-pipe-stream.js'

const windows = process.platform === 'win32' // guards-allow-platform: actual native Windows accept lifecycle.
const native = windows
  ? (createRequire(import.meta.url)('@agnes/system-node/native') as {
      reservePipeName(path: string, maximum: number): PipeReservation
      connectVerifiedPipe(path: string, pid: number, start: string): OwnedPipe
      processStartTime(pid: number): string
    })
  : undefined
const reservations: PipeReservation[] = []
const accepts: PipeAccept[] = []
const owners: OwnedPipe[] = []
const listeners: ReturnType<typeof createWindowsPipeListener>[] = []
const name = () => `\\\\.\\pipe\\agnes-accept-中文-${randomUUID()}`
function reserve(path: string, maximum = 4) {
  if (!native) throw new Error('Windows required')
  const reservation = native.reservePipeName(path, maximum)
  reservations.push(reservation)
  return reservation
}
function accept(reservation: PipeReservation) {
  const pending = reservation.accept()
  accepts.push(pending)
  void pending.ready.catch(() => {})
  void pending.result.catch(() => {})
  return pending
}
function connect(path: string) {
  if (!native) throw new Error('Windows required')
  const owner = native.connectVerifiedPipe(path, process.pid, native.processStartTime(process.pid))
  owners.push(owner)
  return owner
}
afterEach(async () => {
  for (const listener of listeners.splice(0)) await listener.close()
  for (const pending of accepts) pending.cancel()
  for (const reservation of reservations.splice(0)) reservation.close()
  for (const pending of accepts.splice(0)) {
    try {
      owners.push((await pending.result).open())
    } catch {
      /* Rejected or already claimed. */
    }
  }
  for (const owner of owners.splice(0)) await owner.close()
})

describe.skipIf(!windows)('native reservation accept', () => {
  it('survives exited clients before authentication without dropping existing or future peers', async () => {
    const path = name()
    const streams: WindowsPipeStream[] = []
    const listener = createWindowsPipeListener(reserve(path), 3, (stream) => {
      streams.push(stream)
      stream.on('data', (bytes: Buffer) => stream.write(bytes))
    })
    listeners.push(listener)
    const failed = vi.fn()
    void listener.failed.then(failed)
    await listener.ready
    const first = connect(path)
    await vi.waitFor(() => expect(streams).toHaveLength(1))
    for (let round = 0; round < 5; round++) {
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          "const s=require('node:net').createConnection(process.argv[1]);s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(2));",
          path,
        ],
        { timeout: 3000, windowsHide: true },
      )
      expect(child.status).toBe(0)
      // Model a busy server thread so the client process is gone before native authentication.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30)
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(failed).not.toHaveBeenCalled()
      expect(streams).toHaveLength(1)
      const reply = first.read()
      await first.write(Buffer.from(`alive-${round}`))
      expect(await reply).toEqual(Buffer.from(`alive-${round}`))
    }
    const second = connect(path)
    await vi.waitFor(() => expect(streams).toHaveLength(2))
    const reply = second.read()
    await second.write(Buffer.from('new peer'))
    expect(await reply).toEqual(Buffer.from('new peer'))
  })

  it('becomes ready before connecting, exchanges bytes, and transfers ownership once', async () => {
    const path = name()
    const reservation = reserve(path)
    const pending = accept(reservation)
    await pending.ready
    let delivered = false
    void pending.result.then(() => {
      delivered = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(delivered).toBe(false)
    const client = connect(path)
    const lease = await pending.result
    const server = lease.open()
    owners.push(server)
    expect(() => lease.open()).toThrow('already claimed')
    expect(() => lease.open.call({})).toThrow('Invalid')
    const bytes = Buffer.from('中文往返')
    const reading = server.read()
    await client.write(bytes)
    expect(await reading).toEqual(bytes)
    const reply = client.read()
    await server.write(bytes)
    expect(await reply).toEqual(bytes)
  })

  it('drains cancellation before releasing the reservation name', async () => {
    const path = name()
    const reservation = reserve(path)
    const pending = accept(reservation)
    await pending.ready
    reservation.close()
    expect(() => reservation.accept()).toThrow('closed')
    pending.cancel()
    await expect(pending.result).rejects.toMatchObject({ code: 'ECANCELED' })
    reserve(path).close()
  })

  it('reports instance exhaustion through ready and result without losing the name', async () => {
    const path = name()
    const reservation = reserve(path, 2)
    const first = accept(reservation)
    await first.ready
    const extra = accept(reservation)
    await expect(extra.ready).rejects.toMatchObject({ code: 'E_PIPE_ACCEPT' })
    await expect(extra.result).rejects.toMatchObject({ code: 'E_PIPE_ACCEPT' })
    expect(() => reserve(path)).toThrow()
    first.cancel()
    await expect(first.result).rejects.toMatchObject({ code: 'ECANCELED' })
    const replacement = accept(reservation)
    await replacement.ready
    replacement.cancel()
    await expect(replacement.result).rejects.toMatchObject({ code: 'ECANCELED' })
  })

  it('uses the production controller and keeps accepted streams alive after stopping', async () => {
    const path = name()
    let dispatch!: (stream: WindowsPipeStream) => void
    const accepted = new Promise<WindowsPipeStream>((resolve) => {
      dispatch = resolve
    })
    const listener = createWindowsPipeListener(reserve(path), 3, dispatch)
    listeners.push(listener)
    await listener.ready
    const client = connect(path)
    const server = await accepted
    server.on('data', (bytes: Buffer) => server.write(bytes))
    await listener.stopAccepting()
    const reply = client.read()
    await client.write(Buffer.from('after stop'))
    expect(await reply).toEqual(Buffer.from('after stop'))
    await listener.close()
    expect(await client.read()).toBeNull()
  })

  it('restores real native capacity as connections close across repeated batches', async () => {
    const path = name()
    const events = new EventEmitter()
    const listener = createWindowsPipeListener(reserve(path), 3, (stream) => events.emit('accepted', stream))
    listeners.push(listener)
    await listener.ready
    for (let round = 0; round < 8; round++) {
      const batch: { client: OwnedPipe; server: WindowsPipeStream }[] = []
      for (let i = 0; i < 3; i++) {
        const accepted = once(events, 'accepted')
        const client = connect(path)
        const [server] = (await accepted) as [WindowsPipeStream]
        batch.push({ client, server })
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      expect(() => connect(path)).toThrow(expect.objectContaining({ win32Code: 231 }))
      for (const { client, server } of batch) {
        const closed = once(server, 'close')
        await client.close()
        await closed
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await listener.close()
    reserve(path).close()
  })

  it.each(['waiting', 'unclaimed'] as const)('cleans %s accepts on Worker termination', async (mode) => {
    for (let i = 0; i < 10; i++) {
      const path = name()
      const worker = new Worker(
        `const { parentPort, workerData } = require('node:worker_threads');
         const native = require(workerData.module);
         global.reservation = native.reservePipeName(workerData.path, 4);
         global.pending = global.reservation.accept();
         parentPort.on('message', () => {});
         global.pending.ready.then(() => parentPort.postMessage('ready'));
         global.pending.result.then(lease => { global.lease = lease; parentPort.postMessage('accepted'); }, () => {});`,
        {
          eval: true,
          workerData: { path, module: createRequire(import.meta.url).resolve('@agnes/system-node/native') },
        },
      )
      let client: OwnedPipe | undefined
      try {
        expect(await once(worker, 'message')).toEqual(['ready'])
        if (mode === 'unclaimed') {
          const accepted = once(worker, 'message')
          client = connect(path)
          expect(await accepted).toEqual(['accepted'])
        }
      } finally {
        await worker.terminate()
      }
      if (client) {
        expect(await client.read()).toBeNull()
        await client.close()
      }
      reserve(path).close()
    }
  })
})
