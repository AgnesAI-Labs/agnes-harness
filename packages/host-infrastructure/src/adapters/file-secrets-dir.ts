import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { HostError } from '@agnes/host-common/errors'
import { fileSecretsDir } from '@agnes/host-common/paths'

const LOCK_WAIT_MS = 2_000

export type FileSecretsDirectoryInput = {
  /** Profile pin. An explicit path wins over the default. */
  path?: string | undefined
  /** Caller override used only when the profile does not pin a path. */
  override?: string | undefined
  dataDir: string
  /** Agnes home. When omitted, a data directory named `data` implies its parent. */
  home?: string | undefined
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  if (a === b) return true
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

function pause(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      // Atomics.wait is unavailable; a short spin covers a contended lock.
    }
  }
}

function withLock(lockDir: string, body: () => void): void {
  const started = Date.now()
  mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 })
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new HostError('E_SECRET_UNRESOLVED', 'The file secrets store could not be moved.', {
          detail: { reason: 'migrate' },
        })
      let stale = false
      try {
        stale = Date.now() - lstatSync(lockDir).mtimeMs > LOCK_WAIT_MS
      } catch {
        stale = true
      }
      if (stale) {
        rmSync(lockDir, { recursive: true, force: true })
        continue
      }
      if (Date.now() - started > LOCK_WAIT_MS)
        throw new HostError('E_SECRET_UNRESOLVED', 'The file secrets store could not be moved.', {
          detail: { reason: 'migrate' },
        })
      pause(5)
    }
  }
  try {
    body()
  } catch (error) {
    if (error instanceof HostError) throw error
    throw new HostError('E_SECRET_UNRESOLVED', 'The file secrets store could not be moved.', {
      detail: { reason: 'migrate' },
    })
  } finally {
    rmSync(lockDir, { recursive: true, force: true })
  }
}

function destExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Move files that the old `<dataDir>/secrets` fallback wrote. Never replaces a file already present. */
function moveStore(source: string, dest: string): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(source)
  } catch {
    return
  }
  if (!stat.isDirectory()) return
  if (!destExists(dest)) {
    mkdirSync(dest, { recursive: true, mode: 0o700 })
    // mkdir honors the umask, and a later credential write refuses any directory that is not 0700.
    chmodSync(dest, 0o700)
  }
  for (const name of readdirSync(source)) {
    const from = join(source, name)
    const to = join(dest, name)
    const child = lstatSync(from)
    if (child.isSymbolicLink()) continue
    if (child.isDirectory()) {
      if (!destExists(to)) {
        renameSync(from, to)
        continue
      }
      const existing = lstatSync(to)
      if (existing.isSymbolicLink() || !existing.isDirectory()) continue
      moveStore(from, to)
      continue
    }
    if (!child.isFile() || destExists(to)) continue
    renameSync(from, to)
  }
  try {
    rmdirSync(source)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
  }
}

function sourceIsDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function canonicalDir(input: FileSecretsDirectoryInput): string {
  if (input.home !== undefined && input.home !== '') return fileSecretsDir(input.home)
  if (basename(input.dataDir) === 'data') return fileSecretsDir(dirname(input.dataDir))
  return join(input.dataDir, 'secrets')
}

/**
 * Directory the file secrets adapter opens. The credential store and this fallback share
 * `<home>/secrets`. A profile path still wins. A store left at `<dataDir>/secrets` is moved
 * when the selected directory is that canonical one.
 */
export function resolveFileSecretsDirectory(input: FileSecretsDirectoryInput): string {
  const canonical = canonicalDir(input)
  const selected = input.path ?? input.override ?? canonical
  if (!samePath(selected, canonical)) return selected
  const misplaced = join(input.dataDir, 'secrets')
  if (samePath(misplaced, canonical) || !sourceIsDirectory(misplaced)) return selected
  withLock(join(dirname(canonical), '.secrets-migrate.lock'), () => moveStore(misplaced, canonical))
  return selected
}
