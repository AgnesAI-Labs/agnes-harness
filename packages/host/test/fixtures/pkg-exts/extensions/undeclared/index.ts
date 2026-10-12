import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { fixtureTool } from '../../../tool.js'

// Registers a declared name first, then one the manifest does not carry. The first registration is
// what makes this a rollback case and not only a refusal case.
export default defineAgnesPlugin({
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.tools.register(fixtureTool('fx_declared'))
    ctx.tools.register(fixtureTool('fx_rogue'))
  },
})
