import type { ProjectionDef } from '../../src/projections.js'
export function projectionFixture(): ProjectionDef<{ count: number }> {
  return {
    name: 'fixture.count',
    stateVersion: 1,
    stateSchema: {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
      additionalProperties: false,
    },
    init: () => ({ count: 0 }),
    apply: (state) => ({ count: state.count + 1 }),
    view: (state) => ({ count: state.count }),
  }
}
