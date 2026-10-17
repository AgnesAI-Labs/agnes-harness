import { emptyState, keyOf, projection, qualityView } from './src/model.mjs'
import { createTools } from './src/tools.mjs'

export { qualityWorkflow } from './src/workflow.mjs'

export const qualityReadService = {
  name: 'quality.read',
  kind: 'query',
  scope: 'profile',
  timeoutMs: 3000,
  maxResultBytes: 262144,
  inputSchema: {
    type: 'object',
    properties: { sessionId: { type: 'string', minLength: 1, maxLength: 160 } },
    required: ['sessionId'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { schemaVersion: { const: 1 }, records: { type: 'array' } },
    required: ['schemaVersion', 'records'],
    additionalProperties: false,
  },
  async handler({ sessionId }, ctx) {
    ctx.signal.throwIfAborted()
    if (!ctx.store || !ctx.sessionAccess) throw new Error('QUALITY_UNAVAILABLE')
    await ctx.sessionAccess.requireRead(sessionId)
    ctx.signal.throwIfAborted()
    const state = ctx.store.get(keyOf(sessionId)) ?? emptyState()
    return { schemaVersion: 1, records: state.records.map(qualityView) }
  },
}
export const main = {
  inject: ['tools', 'services', 'projections', 'eventLog', 'self'],
  apply(ctx) {
    const off = [
      ctx.services.register(qualityReadService),
      ctx.projections.register(projection(ctx.self.extId)),
    ]
    for (const tool of createTools(ctx)) off.push(ctx.tools.register(tool))
    return () => {
      for (const dispose of off.reverse()) dispose()
    }
  },
}
export { workflow } from './src/workflow.mjs'
