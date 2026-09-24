import { defineExtension } from '@agnes/extension-api'
import { fixtureTool } from '../../../tool.js'

export default defineExtension((agnes) => {
  agnes.registerTool(fixtureTool('tx_one'))
  throw new Error('fixture entry gave up half way')
})
