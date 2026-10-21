import { randomUUID } from 'node:crypto'
import { linkSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'

export function pidExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

export function readLockOwner(lock) {
  try {
    const bytes = readFileSync(lock, 'utf8'),
      holder = JSON.parse(bytes),
      token = holder?.token
    return holder && Number.isSafeInteger(holder.pid) && holder.pid > 0 && typeof token === 'string'
      ? {
          pid: holder.pid,
          ...(typeof holder.startId === 'string' && holder.startId ? { startId: holder.startId } : {}),
          token,
        }
      : undefined
  } catch {
    return undefined
  }
}

function removeLockFile(lock) {
  try {
    unlinkSync(lock)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

/** True when this holder created the lock; false only when it already exists. Any other failure is thrown. */
export function acquireOwnerFileLock(lock, owner) {
  const pending = `${lock}.${randomUUID()}.tmp`
  try {
    writeFileSync(pending, JSON.stringify(owner), { flag: 'wx', mode: 0o600, flush: true })
    linkSync(pending, lock)
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  } finally {
    rmSync(pending, { force: true })
  }
}

/**
 * Moves a lock whose owner was seen dead out of the way. If the lock found there is not the one that
 * was seen (it was released and re-acquired in between), the live owner's lock is put back.
 */
export function takeOverOwnerFileLock(lock, seenToken) {
  const away = `${lock}.${randomUUID()}.stale`
  try {
    renameSync(lock, away)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  try {
    if (readLockOwner(away)?.token === seenToken) return
    try {
      linkSync(away, lock)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  } finally {
    rmSync(away, { force: true })
  }
}

/** Release only the owner observed by this holder; never remove another holder's lock. */
export function releaseOwnerFileLock(lock, token) {
  if (readLockOwner(lock)?.token === token) removeLockFile(lock)
}
