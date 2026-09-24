import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { listenUnix, SocketListenError } from '../src/supervisor/socket.js'
import { localSocketPath } from './local-socket-path.js'

const windows = process.platform === 'win32' // guards-allow-platform: test-only local transport semantics.
const roots: string[] = []
const listeners: Array<{ close(): Promise<void> }> = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-socket-'))
  roots.push(root)
  return { root, path: localSocketPath(join(root, 'daemon', 'd.sock')) }
}
afterEach(async () => {
  for (const listener of listeners.splice(0)) await listener.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it('serves actual local transport bytes and closes active connections (Unix permissions before dispatch)', async () => {
  const { path } = fixture()
  let dispatchedMode: number | undefined
  const listener = await listenUnix(path, (s) => {
    if (!windows) dispatchedMode = statSync(path).mode & 0o777
    s.on('data', (chunk) => s.write(chunk))
  })
  listeners.push(listener)
  if (!windows) {
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
  }
  const client = connect(path)
  await once(client, 'connect')
  const data = once(client, 'data')
  client.write('hello\n')
  expect((await data)[0].toString()).toBe('hello\n')
  if (!windows) expect(dispatchedMode).toBe(0o600)
  const ended = once(client, 'close')
  const closing = listener.close()
  expect(listener.close()).toBe(closing)
  await closing
  await ended
})

it('stops accepting before the existing connection is closed', async () => {
  const { path } = fixture()
  let accepted = 0
  const listener = await listenUnix(path, (socket) => {
    accepted++
    socket.on('data', (chunk) => socket.write(chunk))
  })
  listeners.push(listener)
  const admitted = connect(path)
  await once(admitted, 'connect')
  // Client connect can fire before the server accepts a Windows pipe instance. Exchange a frame
  // first so this test specifically exercises an already admitted connection.
  const acknowledged = once(admitted, 'data')
  admitted.write('admitted')
  expect(String((await acknowledged)[0])).toBe('admitted')

  await listener.stopAccepting()
  const echoed = once(admitted, 'data')
  admitted.write('still-live')
  expect(String((await echoed)[0])).toBe('still-live')

  const refused = connect(path)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const refusal = await new Promise<string>((resolve) => {
      refused.once('error', () => resolve('refused'))
      refused.once('connect', () => resolve('connected'))
      // A live accepted pipe instance can keep a new Windows connect waiting for an instance.
      // The contract is no admission, not an immediate Unix ECONNREFUSED.
      if (windows) timer = setTimeout(() => resolve('pending'), 250)
    })
    expect(windows ? ['pending', 'refused'] : ['refused']).toContain(refusal)
    expect(accepted).toBe(1)
  } finally {
    clearTimeout(timer)
    refused.destroy()
  }

  const closed = once(admitted, 'close')
  await listener.close()
  await closed
})
// Unix pathname nodes/mode bits have no named-pipe equivalent; Windows collision coverage is below.
it.skipIf(windows).each(['file', 'directory', 'symlink'])(
  'preserves an existing %s at the socket path',
  async (kind) => {
    const { root, path } = fixture()
    mkdirSync(join(root, 'daemon'), { mode: 0o700 })
    const target = join(root, 'target')
    writeFileSync(target, 'PRESERVE')
    if (kind === 'file') writeFileSync(path, 'PRESERVE')
    if (kind === 'directory') mkdirSync(path)
    if (kind === 'symlink') symlinkSync(target, path)
    await expect(
      listenUnix(path, () => {}).then((listener) => {
        listeners.push(listener)
        return listener
      }),
    ).rejects.toThrow(SocketListenError)
    expect(readFileSync(target, 'utf8')).toBe('PRESERVE')
    if (kind !== 'directory') expect(readFileSync(path, 'utf8')).toBe('PRESERVE')
  },
)
it('refuses a live endpoint while the original listener remains usable', async () => {
  const { path } = fixture()
  const listener = await listenUnix(path, (s) => s.end('original'))
  listeners.push(listener)
  const inode = windows ? undefined : statSync(path).ino
  await expect(
    listenUnix(path, () => {}).then((listener) => {
      listeners.push(listener)
      return listener
    }),
  ).rejects.toThrow(SocketListenError)
  if (!windows) expect(statSync(path).ino).toBe(inode)
  const client = connect(path)
  try {
    expect(String((await once(client, 'data'))[0])).toBe('original')
  } finally {
    client.destroy()
  }
})
it.skipIf(windows)('refuses a broad existing parent directory without changing its mode', async () => {
  const { root, path } = fixture()
  mkdirSync(join(root, 'daemon'), { mode: 0o755 })
  await expect(
    listenUnix(path, () => {}).then((listener) => {
      listeners.push(listener)
      return listener
    }),
  ).rejects.toThrow(SocketListenError)
  expect(statSync(join(root, 'daemon')).mode & 0o777).toBe(0o755)
})

it('reopens an endpoint after its test child crashes and serves a new connection', async () => {
  const { root, path } = fixture()
  mkdirSync(join(root, 'daemon'), { mode: 0o700 })
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { createServer } from 'node:net'; createServer().listen(process.argv[1], () => process.stdout.write('ready'))",
      path,
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const exited = once(child, 'exit')
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      exited.then(() => {
        throw new Error('test child exited before ready')
      }),
    ])
    child.kill('SIGKILL')
    await exited
    if (!windows) expect(statSync(path).isSocket()).toBe(true)
    const listener = await listenUnix(path, (socket) => socket.end('recovered'))
    listeners.push(listener)
    const client = connect(path)
    const data = once(client, 'data')
    expect(String((await data)[0])).toBe('recovered')
    client.destroy()
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await exited
    }
  }
})
