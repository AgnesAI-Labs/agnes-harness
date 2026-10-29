import type { Logger } from '@agnes/extension-api'
import { publicErrorCode } from '@agnes/protocol'

/** A catch handler for advisory work; neither exception content nor sink failures escape. */
export function bestEffort(log: Pick<Logger, 'debug'> | undefined, label: string) {
  return (error: unknown): undefined => {
    try {
      void Promise.resolve(
        log?.debug(`best-effort ${label} failed`, { code: publicErrorCode(error) ?? 'INTERNAL_ERROR' }),
      ).catch(() => undefined)
      // A rejected async sink is silent to avoid recursive diagnostics.
    } catch {
      /* A diagnostic sink must never change the original failure policy. */
    }
    return undefined
  }
}
