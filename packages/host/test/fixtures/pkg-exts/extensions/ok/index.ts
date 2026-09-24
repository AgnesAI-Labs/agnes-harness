import { defineExtension, type ToolDef } from '@agnes/extension-api'
import { fixtureTool } from '../../../tool.js'

// Declares two names and claims one. The manifest is an upper bound, so the second name simply
// does not exist as a tool.
export const CLAIMED: ToolDef = fixtureTool('fx_one')

export default defineExtension((agnes) => agnes.registerTool(CLAIMED))
