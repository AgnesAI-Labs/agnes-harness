import { describe, expect, it } from 'vitest'
import { modelBridgeBlockers, modelBridgeReady } from '../../src/runtime/model/model-bridge.js'
import { UNIMPLEMENTED_STATE_METHODS } from '../../src/runtime/providers/state.js'

describe('model parent/child bridge readiness', () => {
  it('is not ready while State cannot create a child action in the parent transaction', () => {
    expect(modelBridgeBlockers()).toEqual(['advanceProvider'])
    expect(modelBridgeReady()).toMatchObject({
      ok: false,
      error: { code: 'internal', detailCode: 'model_child_bridge_not_ready' },
    })
  })
  /**
   * This test is meant to fail the day State implements advanceProvider. Then the probe, the Model service
   * installation and the production lineage reader must be revisited together; do not just flip this
   * assertion.
   */
  it('tracks the real list of unimplemented State methods', () => {
    expect(UNIMPLEMENTED_STATE_METHODS).toContain('advanceProvider')
  })
  it('does not depend on the legacy bridge or child-session methods, which are not the composite child path', () => {
    expect(modelBridgeBlockers()).not.toContain('acceptBridgeChild')
    expect(modelBridgeBlockers()).not.toContain('createChild')
  })
})
