import { publicErrorCode } from '@agnes/protocol'

export const bestEffortOperations = ['worker-session-retire', 'discovery-remove'] as const

/** Runtime audit records contain fixed operation labels and public codes, never exception text. */
export function bestEffort(
  log: ((record: unknown) => void) | undefined,
  operation: (typeof bestEffortOperations)[number],
) {
  return (error: unknown): undefined => {
    try {
      void Promise.resolve(
        log?.({
          kind: 'daemon.error',
          level: 'info',
          detail: { operation, code: publicErrorCode(error) ?? 'INTERNAL_ERROR' },
        }),
      ).catch(() => undefined)
      // A rejected async sink is silent to avoid recursive diagnostics.
    } catch {
      /* A diagnostic sink must never change the original failure policy. */
    }
    return undefined
  }
}
