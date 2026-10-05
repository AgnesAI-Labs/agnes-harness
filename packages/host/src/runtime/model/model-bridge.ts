import type { Outcome } from '@agnes/extension-api/runtime'
import { UNIMPLEMENTED_STATE_METHODS } from '../providers/state.js'

/** What the composite child path needs from State: children created in the parent's transition. */
const REQUIRED = ['advanceProvider'] as const

export function modelBridgeBlockers(): readonly string[] {
  return REQUIRED.filter((method) => (UNIMPLEMENTED_STATE_METHODS as readonly string[]).includes(method))
}

export function modelBridgeReady(): Outcome<void> {
  return modelBridgeBlockers().length === 0
    ? { ok: true, value: undefined }
    : {
        ok: false,
        error: {
          code: 'internal',
          detailCode: 'model_child_bridge_not_ready',
          message: 'The parent/child action bridge is not available',
          retryAdvice: { kind: 'never' },
          diagnosticId: 'model-bridge',
        },
      }
}
