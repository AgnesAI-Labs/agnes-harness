import type { HarnessSeam } from '@agnes/core'

/**
 * The intake for self-modification proposals. Nothing drains a proposal into the session any more,
 * so it holds none: every call is refused rather than reported queued and never applied.
 */
export function createRefineHarness(): HarnessSeam {
  return {
    async propose() {
      return 'rejected'
    },
  }
}
