import { defineExtension } from '@agnes/extension-api'
import { compactTool } from './tool.js'

// The default policy is injected by trusted Host assembly, not registered as a competing Hook.
// Dynamic packages may therefore override one attempt with before_compact, while disabling them
// cleanly restores this package-owned default.
export default defineExtension((agnes) => agnes.registerTool(compactTool))

export { buildCompactionPlan } from './plan.js'
export { compactTool } from './tool.js'
