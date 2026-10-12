import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { fixtureTool } from '../../../tool.js'

export default defineAgnesPlugin({
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.tools.register(fixtureTool('tx_one'))
    throw new Error('fixture entry gave up half way')
  },
})
