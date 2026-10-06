import { describe, expect, it } from 'vitest'
import { modelBridgeBlockers, modelBridgeReady } from '../../src/runtime/model/model-bridge.js'
import { UNIMPLEMENTED_STATE_METHODS } from '../../src/runtime/providers/state.js'

describe('model parent/child bridge readiness', () => {
  it('is ready now that State creates child actions in the parent transaction', () => {
    expect(modelBridgeBlockers()).toEqual([])
    expect(modelBridgeReady()).toEqual({ ok: true, value: undefined })
  })
  /**
   * advanceProvider is implemented, so this guard no longer pins it as unavailable. Whether the Model service
   * installation and the production lineage reader may rely on it is a separate decision for the model lane.
   */
  it('tracks the real list of unimplemented State methods', () => {
    expect(UNIMPLEMENTED_STATE_METHODS).not.toContain('advanceProvider')
  })
  it('does not depend on the legacy bridge or child-session methods, which are not the composite child path', () => {
    expect(modelBridgeBlockers()).not.toContain('acceptBridgeChild')
    expect(modelBridgeBlockers()).not.toContain('createChild')
  })
})
