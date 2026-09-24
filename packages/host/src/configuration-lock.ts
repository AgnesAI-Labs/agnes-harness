import { chmod } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

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
        db.exec('BEGIN IMMEDIATE')
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
