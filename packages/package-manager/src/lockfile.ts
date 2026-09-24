import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { SeamName } from '@agnes/protocol'
import { type PackageLock, type Lockfile as ValidatedLockfile, validateLockfile } from '@agnes/protocol'
import { renameWriteThroughSync, syncFileSync } from '@agnes/system-node'
import { PackageError } from './errors.js'
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
  seams: Partial<Record<SeamName, string>>
}

export const lockPath = (profileDir: string): string => join(profileDir, 'agnes-lock.json')
const STALE_LOCK_MS = 30_000
function ownerIsDead(file: string): boolean {
  try {
    const pid = Number(readFileSync(file, 'utf8'))
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return false
    } catch (error) {
      // POSIX 用 ESRCH 表示进程不存在；Windows 上 libuv 对已退出/无效 pid 可能直接报 EPERM，
      // 只认 ESRCH 会让 Windows 的陈旧锁永远无法回收，reclaim 标记残留后彻底死锁。
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
  return r.value
}

export function writeLock(profileDir: string, lock: Lockfile): void {
  const out = { ...lock, generatedAt: new Date().toISOString() }
  // Validated before the tmp file is even opened: the contract is that anything on disk reads back,
  // and checking after rename would make that contract a hope. A draft (null resolvedProfileHash,
  // partial seams) fails here, which is what keeps an unresolved profile's lock off disk.
  const r = validateLockfile(out)
  if (!r.ok)
    throw new PackageError('E_LOCK_MISMATCH', 'refusing to write a lockfile that would not read back', {
      source: { file: 'agnes-lock.json' },
      detail: { reason: 'invalid', path: r.errors[0]?.path },
    })
  const file = resolve(lockPath(profileDir))
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`)
  syncFileSync(tmp)
  renameWriteThroughSync(tmp, file)
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
    try {
      const fd = openSync(lockFile, 'wx')
      try {
        writeFileSync(fd, String(process.pid))
      } finally {
        closeSync(fd)
      }
      break
    } catch {
      if (
        existsSync(lockFile) &&
        Date.now() - statSync(lockFile).mtimeMs > STALE_LOCK_MS &&
        ownerIsDead(lockFile)
      ) {
        // Serialize reclaimers so two contenders cannot both unlink a newly acquired lock.
        const reclaim = `${lockFile}.reclaim`
        let fd: number | undefined
        try {
          fd = openSync(reclaim, 'wx')
          if (existsSync(lockFile) && ownerIsDead(lockFile)) removeLockArtifact(lockFile)
        } catch {
          // 抢标记失败即代表有竞争者，但竞争者可能已经被 Kill 或崩溃，标记会永久残留。
          // 超过陈旧阈值就视为滞留标记，强制回收，否则这条路径会死锁到永久。
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
        throw new PackageError('E_LOCK_MISMATCH', 'could not acquire the lockfile lock', {
          source: { file: 'agnes-lock.json' },
          detail: { reason: 'busy' },
        })
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
