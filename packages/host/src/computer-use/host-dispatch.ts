import type { HostToolDispatchPort } from '@agnes/core'

/** Host-private final hop for the one built-in Computer Use tool. Core has already consumed the
 * durable execute permit and verified the exact built-in package attestation before this runs. */
export function createComputerUseHostDispatchPort(): HostToolDispatchPort {
  return Object.freeze({
    async dispatch(input) {
      if (input.name !== 'computer_use' || (input.attempt !== 1 && input.attempt !== 2))
        return Object.freeze({
          phase: 'not_sent' as const,
          error: new Error('Computer Use Host dispatch identity is invalid'),
        })
      try {
        return Object.freeze({ phase: 'responded' as const, result: await input.invoke() })
      } catch (error) {
        // The backend can fail after native I/O begins. Treat an unclassified throw as uncertain so
        // Core never retries a possible mutation on its own.
        return Object.freeze({ phase: 'may_have_sent' as const, error })
      }
    },
  })
}
