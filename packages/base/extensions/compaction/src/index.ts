import { defineExtension } from '@agnes/extension-api'
import { compactTool } from './tool.js'

// The default engine is registered by Host as an ordinary Base plugin row.
// Dynamic packages may therefore override one attempt with before_compact, while disabling them
// cleanly restores this package-owned default.
export default defineExtension((agnes) => agnes.registerTool(compactTool))

export { buildCompactionPlan } from './plan.js'
export { compactTool } from './tool.js'

export { createDefaultCompactionEngine } from './engine.js'
