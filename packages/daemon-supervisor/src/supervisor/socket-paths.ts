import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

// A portable pathname budget, including room for NUL in macOS's 104-byte sun_path.
export const UNIX_SOCKET_PATH_BYTES = 103
export class SocketPathError extends Error {
  override name = 'SocketPathError'
  readonly code = 'E_DAEMON_SOCKET_PATH'
}
const pipe = (path: string) => path.startsWith('\\\\.\\pipe\\')
const codeIs = (error: unknown, code: string) =>
  error !== null && typeof error === 'object' && 'code' in error && error.code === code

/** Same existing-ancestor resolution as daemon scope, without making config construction async. */
function canonicalDirectory(path: string): string {
  const missing: string[] = []
  let cursor = resolve(path)
  for (;;) {
    try {
      return join(realpathSync(cursor), ...missing.reverse())
    } catch (error) {
      if (!codeIs(error, 'ENOENT')) throw new SocketPathError('daemon socket directory cannot be resolved')
      const parent = dirname(cursor)
      if (parent === cursor) throw new SocketPathError('daemon socket directory cannot be resolved')
      missing.push(basename(cursor))
      cursor = parent
    }
  }
}
function pathBytes(path: string): number {
  // Do not follow an existing socket node: the listener separately checks its type/inode.
  return Math.max(
    Buffer.byteLength(path),
    Buffer.byteLength(join(canonicalDirectory(dirname(path)), basename(path))),
  )
}
export function validateSocketPath(path: string, endpoint = 'IPC'): void {
  if (pipe(path)) return
  if (!isAbsolute(path) || path.includes('\0'))
    throw new SocketPathError(`daemon ${endpoint} socket requires an absolute path without NUL`)
  const bytes = pathBytes(path)
  if (bytes > UNIX_SOCKET_PATH_BYTES)
    throw new SocketPathError(
      `daemon ${endpoint} socket path uses ${bytes} UTF-8 bytes; limit is ${UNIX_SOCKET_PATH_BYTES}. Shorten the explicit socket path or its resolved directory`,
    )
}

export function daemonSocketPaths(input: { dataDir: string; ipc: 'unix' | 'pipe'; socket?: string }): {
  socketPath: string
  workersSocketPath: string
} {
  if (input.ipc === 'pipe') {
    const name = `\\\\.\\pipe\\agnes-${createHash('sha256').update(input.dataDir).digest('hex').slice(0, 16)}`
    return { socketPath: input.socket ?? name, workersSocketPath: `${name}-workers` }
  }
  let directory = join(input.dataDir, 'daemon')
  if (pathBytes(join(directory, 'workers.sock')) > UNIX_SOCKET_PATH_BYTES) {
    const uid = process.geteuid?.()
    if (uid === undefined) throw new SocketPathError('daemon Unix socket user identity unavailable')
    const hash = createHash('sha256').update(canonicalDirectory(input.dataDir)).digest('hex').slice(0, 32)
    directory = join(canonicalDirectory('/tmp'), `agnes-${uid}-${hash}`)
  }
  const result = {
    socketPath: input.socket ?? join(directory, 'agnesd.sock'),
    workersSocketPath: join(directory, 'workers.sock'),
  }
  validateSocketPath(result.socketPath, 'client')
  validateSocketPath(result.workersSocketPath, 'worker')
  return result
}

/** Only creates the private, predictable short directory, never repairs an existing object. */
function prepareShortDirectory(path: string): void {
  const directory = dirname(path)
  if (!/^agnes-\d+-[a-f0-9]{32}$/.test(basename(directory))) return
  const root = canonicalDirectory('/tmp')
  if (dirname(directory) !== root) return
  const uid = process.geteuid?.()
  const rootStat = lstatSync(root)
  if (
    uid === undefined ||
    !rootStat.isDirectory() ||
    (rootStat.uid !== 0 && rootStat.uid !== uid) ||
    ((rootStat.mode & 0o022) !== 0 && (rootStat.mode & 0o1000) === 0)
  )
    throw new SocketPathError('daemon socket temporary root is not trusted')
  try {
    mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if (!codeIs(error, 'EEXIST')) throw new SocketPathError('daemon short socket directory cannot be created')
  }
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700)
    throw new SocketPathError(
      'daemon short socket directory must be a real directory owned by this user with mode 0700',
    )
}

/** Validate both endpoints before allocating resources; reused by the launcher and daemon. */
export function prepareDaemonSocketPaths(paths: { socketPath: string; workersSocketPath: string }): void {
  validateSocketPath(paths.socketPath, 'client')
  validateSocketPath(paths.workersSocketPath, 'worker')
  for (const path of [paths.socketPath, paths.workersSocketPath]) if (!pipe(path)) prepareShortDirectory(path)
}
