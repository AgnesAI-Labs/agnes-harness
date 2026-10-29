import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { compactTool } from './tool.js'

// The default engine is registered by Host as an ordinary Base plugin row.
// Dynamic packages may therefore override one attempt with before_compact, while disabling them
// cleanly restores this package-owned default.
export default defineAgnesPlugin({
  inject: ['tools'],
  apply(ctx: Context) {
    return ctx.tools.register(compactTool)
  },
})

export type { CompactionQualityConfig } from './engine.js'
export { createDefaultCompactionEngine, resolveCompactionQualityConfig } from './engine.js'
export { buildCompactionPlan } from './plan.js'
export { compactTool } from './tool.js'
