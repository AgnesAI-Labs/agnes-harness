import type { ToolDef } from '@agnes/extension-api'
import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { fixtureTool } from '../../../tool.js'

// Declares two names and claims one. The manifest is an upper bound, so the second name simply
// does not exist as a tool.
export const CLAIMED: ToolDef = fixtureTool('fx_one')

export default defineAgnesPlugin({
  inject: ['tools'],
  apply(ctx: Context) {
    return ctx.tools.register(CLAIMED)
  },
})
