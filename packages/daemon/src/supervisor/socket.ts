import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute } from 'node:path'
import type { Duplex } from 'node:stream'
import { listenWindowsPipe } from '@agnes/system-node/windows-pipe'
import { prepareDaemonSocketPaths, SocketPathError } from './socket-paths.js'
import { socketRefused } from './socket-refused.js'

export class SocketListenError extends Error {
  override name = 'SocketListenError'
  constructor() {
    super('daemon socket unavailable')
  }
}
const codeIs = (error: unknown, code: string) =>
  error !== null && typeof error === 'object' && 'code' in error && error.code === code

async function prepare(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new SocketListenError()
  prepareDaemonSocketPaths({ socketPath: path, workersSocketPath: path })
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const dir = await lstat(parent)
  if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700) throw new SocketListenError()
  let old: Awaited<ReturnType<typeof lstat>>
  try {
    old = await lstat(path)
  } catch (error) {
    if (codeIs(error, 'ENOENT')) return
    throw error
  }
  if (!old.isSocket() || !(await socketRefused(path))) throw new SocketListenError()
  const now = await lstat(path)
  if (!now.isSocket() || now.dev !== old.dev || now.ino !== old.ino) throw new SocketListenError()
  await unlink(path)
}

/** Caller holds the owner lock until after close. Application controls the directory. */
export async function listenUnix(
  path: string,
  onConn: (socket: Duplex) => void,
): Promise<{ stopAccepting(): Promise<void>; close(): Promise<void>; failed?: Promise<Error> }> {
  const pipe = path.startsWith('\\\\.\\pipe\\')
  if (pipe) {
    try {
      return await listenWindowsPipe(path, 253, onConn)
    } catch {
      throw new SocketListenError()
    }
  }
  const sockets = new Set<Duplex>()
  let ready = false
  let stopping = false
  const dispatch = (socket: Duplex) => {
    try {
      onConn(socket)
      socket.resume()
    } catch {
      socket.destroy()
    }
  }
  const server = createServer({ pauseOnConnect: true }, (socket) => {
    if (stopping) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
    if (ready) dispatch(socket)
  })
  let serverClosed: Promise<void> | undefined
  const stopAccepting = (): Promise<void> => {
    ready = false
    stopping = true
    serverClosed ??= new Promise<void>((resolve) => server.close(() => resolve()))
    // `server.close()` synchronously stops accepting. Its callback waits for existing sockets, which
    // belong to the later close phase, so this phase intentionally does not await that callback.
    return Promise.resolve()
  }
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      await stopAccepting()
      for (const socket of sockets) socket.destroy()
      await serverClosed
    })())
  server.on('error', () => {
    void close()
  })
  try {
    if (!pipe) await prepare(path)
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error)
      server.once('error', failed)
      server.listen(path, () => {
        server.removeListener('error', failed)
        resolve()
      })
    })
    if (!pipe) await chmod(path, 0o600)
    ready = true
    for (const socket of sockets) dispatch(socket)
    return { stopAccepting, close }
  } catch (error) {
    await close()
    if (error instanceof SocketPathError) throw error
    throw new SocketListenError()
  }
}
