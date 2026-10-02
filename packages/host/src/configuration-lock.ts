import { chmodSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

/** Synchronous deployment CAS uses the same crash-released transaction lock. */
export function withConfigurationLockSync<T>(file: string, action: () => T): T {
  const db = new DatabaseSync(file)
  try {
    chmodSync(file, 0o600)
    db.exec('PRAGMA busy_timeout=5000')
    db.exec('BEGIN EXCLUSIVE')
    try {
      return action()
    } finally {
      db.exec('ROLLBACK')
    }
  } finally {
    db.close()
  }
}

/** Kernel-owned transaction lock: a crashed setup process cannot leave a permanent busy marker. */
export async function withConfigurationLock<T>(
  file: string,
  action: () => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  options.signal?.throwIfAborted()
  const db = new DatabaseSync(file)
  const deadline = Date.now() + (options.timeoutMs ?? 5_000)
  try {
    await chmod(file, 0o600)
    for (;;) {
      options.signal?.throwIfAborted()
      try {
        db.exec('BEGIN EXCLUSIVE')
        break
      } catch (error) {
        const code = (error as { errcode?: number }).errcode
        if ((code !== 5 && code !== 6) || Date.now() >= deadline) throw error
        await delay(25, undefined, { signal: options.signal })
      }
    }
    try {
      const result = await action()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* Closing also releases the transaction lock. */
      }
      throw error
    }
  } finally {
    db.close()
  }
}
