/**
 * Retries for file operations another process can hold up for a moment. On Windows a file open in another program (an
 * editor, a search indexer, a virus scanner, a session's command) cannot be removed or moved: the call fails with EBUSY,
 * EPERM or EACCES until that program lets go. Elsewhere only EBUSY means that.
 */
import { isWindows } from './platform.js'

/** The pauses before each retry: about four seconds in all, then the last error stands. */
export const BUSY_DELAYS_MS: readonly number[] = [100, 250, 500, 1000, 2000]

/** Whether `error` says a file is held by another process on `platform`. */
export function busy(error: unknown, platform: string): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'EBUSY' || (isWindows(platform) && (code === 'EPERM' || code === 'EACCES'))
}

/**
 * Runs `operation`, and again after each of `delays` while it fails because a file is held (see `busy`).
 * @throws the last error, or at once one that is not about a held file.
 */
export async function retryBusy<T>(
  operation: () => Promise<T>,
  platform: string,
  delays: readonly number[] = BUSY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const delay = delays[attempt]
      if (delay === undefined || !busy(error, platform)) throw error
      await sleep(delay)
    }
  }
}
