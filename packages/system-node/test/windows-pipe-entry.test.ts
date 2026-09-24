import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { windowsProcessStartTimeSync, windowsReservePipeName } from '../src/index.js'
import { connectWindowsPipe, listenWindowsPipe } from '../src/windows-pipe.js'
import type { OwnedPipe, WindowsPipeStream } from '../src/windows-pipe-stream.js'

const windows = process.platform === 'win32' // guards-allow-platform: actual Windows system pipe entry points.
const name = () => `\\\\.\\pipe\\agnes-entry-${randomUUID()}`
const identity = (path: string) => {
  const processStartId = windowsProcessStartTimeSync(process.pid)
  if (!processStartId) throw new Error('Current process identity unavailable')
  return { path, pid: process.pid, processStartId }
}

it.runIf(windows)('connects through the exported system listener and returns actual bytes', async () => {
  const path = name()
  const listener = await listenWindowsPipe(path, 2, (stream) =>
    stream.on('data', (bytes: Buffer) => stream.write(bytes)),
  )
  let client: WindowsPipeStream | undefined
  try {
    client = await connectWindowsPipe(identity(path))
    const reply = once(client, 'data')
    client.write(Buffer.from('系统入口中文'))
    expect((await reply)[0]).toEqual(Buffer.from('系统入口中文'))
  } finally {
    client?.destroy()
    await listener.close()
  }
})

it.runIf(windows)('waits for a busy reservation to offer an instance', async () => {
  const path = name()
  const reservation = windowsReservePipeName(path, 2)
  let client: WindowsPipeStream | undefined
  let server: OwnedPipe | undefined
  let pending: ReturnType<typeof reservation.accept> | undefined
  const offer = setTimeout(() => {
    pending = reservation.accept()
    void pending.result.catch(() => {})
    void pending.ready.catch(() => {})
  }, 30)
  try {
    client = await connectWindowsPipe(identity(path))
    if (!pending) throw new Error('connected before offering an instance')
    server = (await pending.result).open()
  } finally {
    clearTimeout(offer)
    client?.destroy()
    if (server) await server.close()
    pending?.cancel()
    if (pending) await pending.result.catch(() => {})
    reservation.close()
  }
})

it.runIf(!windows)('reports Windows pipe support as unavailable on other platforms', async () => {
  await expect(connectWindowsPipe({ path: name(), pid: 1, processStartId: '1' })).rejects.toMatchObject({
    code: 'ENOSYS',
  })
})
