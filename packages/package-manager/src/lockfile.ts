import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { type PackageLock, type Lockfile as ValidatedLockfile, validateLockfile } from '@agnes/protocol'
import { renameWriteThroughSync, syncFileSync } from '@agnes/system-node'
import { PackageError } from './errors.js'
import { assertCurrentPackageFormat } from './package-format.js'
import { checkCancelled } from './ports.js'

export type LockEntry = PackageLock
/**
 * The generated schema's Lockfile, widened on exactly the two fields an in-memory draft cannot
 * honestly carry: a profile that has not been resolved has no hash to attest (the schema makes
 * `resolvedProfileHash` a required `sha256-<64 hex>`), and a lock with nothing resolved yet has no
 * ten-package seam assignment. `emptyLock` returns this draft shape; `writeLock` validates against
 * the un-widened schema before anything reaches disk, so a draft is never written and every lock
 * on disk is one `readLock` accepts.
 */
export type Lockfile = Omit<ValidatedLockfile, 'resolvedProfileHash' | 'seams'> & {
  resolvedProfileHash: string | null
  seams: Partial<ValidatedLockfile['seams']>
}

export const lockPath = (profileDir: string): string => join(profileDir, 'agnes-lock.json')
const STALE_LOCK_MS = 30_000
/**
 * A valid, dead owner can be reclaimed immediately: publication already includes its PID, so no
 * live acquirer is still filling it in. Keep the stale grace for malformed/legacy owner records,
 * including the empty or zero-filled owner an unflushed write can leave after power loss.
 */
function ownerIsDead(file: string): boolean {
  try {
    const pid = Number(readFileSync(file, 'utf8'))
    if (!Number.isSafeInteger(pid) || pid <= 0) return Date.now() - statSync(file).mtimeMs > STALE_LOCK_MS
    try {
      process.kill(pid, 0)
      return false
    } catch (error) {
      // POSIX uses ESRCH for a missing process; Windows libuv may return EPERM for an exited/invalid pid.
      // Accepting only ESRCH would prevent stale Windows locks from being reclaimed and leave reclaim markers deadlocked.
      const code = (error as NodeJS.ErrnoException).code
      return code === 'ESRCH' || code === 'EPERM'
    }
  } catch {
    return false
  }
}

/**
 * Remove a lock artifact without relying on `fs.rmSync`.
 *
 * `rmSync(path, { force: true })` can silently no-op on Windows — observed on a filesystem-filtered
 * Windows user-home tree, where the file survives and no error is raised. A lock that cannot be
 * released wedges every later contender, so release uses `unlinkSync`, which deletes the same paths
 * correctly. `ENOENT` is success: the artifact is already gone.
 */
function removeLockArtifact(file: string): void {
  try {
    unlinkSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function emptyLock(profile: string, agnesVersion: string): Lockfile {
  return {
    lockfileVersion: 1,
    profile,
    resolvedProfileHash: null,
    generatedAt: new Date(0).toISOString(),
    generatedBy: { agnesVersion },
    packages: {},
    seams: {},
    provider: { package: '@agnes/ai', adapters: ['@agnes/ai'] },
    policySnapshot: { capabilityCeiling: [], workspacePackages: 'require-project-trust' },
  }
}

export function readLock(profileDir: string, opts: { profile: string; agnesVersion: string }): Lockfile {
  const file = lockPath(profileDir)
  if (!existsSync(file)) return emptyLock(opts.profile, opts.agnesVersion)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new PackageError('E_LOCK_MISMATCH', 'agnes-lock.json is not valid JSON', {
      source: { file: 'agnes-lock.json' },
      detail: { reason: 'invalid' },
    })
  }
  assertCurrentPackageFormat(parsed)
  const r = validateLockfile(parsed)
  if (!r.ok)
    throw new PackageError(
      'E_LOCK_MISMATCH',
      'agnes-lock.json does not validate against the lockfile schema',
      {
        source: { file: 'agnes-lock.json' },
        detail: { reason: 'invalid', path: r.errors[0]?.path },
      },
    )
  return parsed as Lockfile
}

export function writeLock(profileDir: string, lock: Lockfile): void {
  const pending = prepareLockPublication(profileDir, lock)
  try {
    pending.publish()
  } finally {
    pending.discard()
  }
}

/** Private staged publication lets an admitted transaction re-verify after the real flush. */
export function prepareLockPublication(profileDir: string, lock: Lockfile) {
  const out = { ...lock, generatedAt: new Date().toISOString() }
  // Validated before the tmp file is even opened: the contract is that anything on disk reads back,
  // and checking after rename would make that contract a hope. A draft (null resolvedProfileHash,
  // partial seams) fails here, which is what keeps an unresolved profile's lock off disk.
  assertCurrentPackageFormat(out)
  const r = validateLockfile(out)
  if (!r.ok)
    throw new PackageError('E_LOCK_MISMATCH', 'refusing to write a lockfile that would not read back', {
      source: { file: 'agnes-lock.json' },
      detail: { reason: 'invalid', path: r.errors[0]?.path },
    })
  const file = resolve(lockPath(profileDir))
  const tmp = `${file}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`)
    syncFileSync(tmp)
  } catch (error) {
    if (existsSync(tmp)) unlinkSync(tmp)
    throw error
  }
  return {
    publish: () => renameWriteThroughSync(tmp, file),
    discard: () => {
      if (existsSync(tmp)) unlinkSync(tmp)
    },
  }
}

export async function withLock<T>(
  profileDir: string,
  fn: () => Promise<T>,
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  const lockFile = join(profileDir, '.agnes-lock.lock')
  const deadline = Date.now() + 10_000
  for (;;) {
    checkCancelled(opts.signal)
    // The owner is written to a private file first and linked into place, so a running process never
    // sees the lock without its owner. The write is not flushed: the lock only matters while its
    // holder runs, and after power loss an empty or zero-filled owner is malformed, which ownerIsDead
    // treats as stale once STALE_LOCK_MS have passed since its mtime, so the lock is reclaimed.
    const pending = `${lockFile}.${randomUUID()}.tmp`
    try {
      // A live holder cannot be acquired yet. Avoid creating a temporary owner file on every
      // poll; linkSync still arbitrates the race after this hint.
      if (existsSync(lockFile)) throw Object.assign(new Error('package lock held'), { code: 'EEXIST' })
      try {
        writeFileSync(pending, String(process.pid), { flag: 'wx', mode: 0o600 })
        linkSync(pending, lockFile)
      } finally {
        removeLockArtifact(pending)
      }
      break
    } catch (error) {
      // Only an existing lock is contention; an unsupported link, a permission or an I/O failure is not busy.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (existsSync(lockFile) && ownerIsDead(lockFile)) {
        // Serialize reclaimers so two contenders cannot both unlink a newly acquired lock.
        const reclaim = `${lockFile}.reclaim`
        let fd: number | undefined
        try {
          fd = openSync(reclaim, 'wx')
          if (existsSync(lockFile) && ownerIsDead(lockFile)) removeLockArtifact(lockFile)
        } catch {
          // Failure to claim the marker means a competitor exists, but it may have been killed or crashed, leaving the marker.
          // Reclaim markers beyond the stale threshold to prevent this path from deadlocking permanently.
          if (
            existsSync(reclaim) &&
            Date.now() - statSync(reclaim).mtimeMs > STALE_LOCK_MS &&
            existsSync(lockFile) &&
            ownerIsDead(lockFile)
          ) {
            removeLockArtifact(reclaim)
            if (existsSync(lockFile) && ownerIsDead(lockFile)) removeLockArtifact(lockFile)
          }
        } finally {
          if (fd !== undefined) {
            closeSync(fd)
            removeLockArtifact(reclaim)
          }
        }
      }
      if (Date.now() > deadline)
        throw new PackageError(
          'E_LOCK_MISMATCH',
          `could not acquire the package lock ${lockFile}; if no AGH process is running, remove that file and retry`,
          {
            // Another holder is alive; this is contention, not an integrity failure.
            code: 'E_PACKAGE_BUSY',
            source: { file: 'agnes-lock.json' },
            detail: {
              reason: 'busy',
              lockPath: lockFile,
              recovery: 'Stop other AGH processes; if none run, delete the lock file and retry.',
            },
          },
        )
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  try {
    checkCancelled(opts.signal)
    return await fn()
  } finally {
    removeLockArtifact(lockFile)
  }
}
