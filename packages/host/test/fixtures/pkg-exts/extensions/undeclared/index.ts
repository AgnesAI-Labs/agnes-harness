import { defineExtension } from '@agnes/extension-api'
import { fixtureTool } from '../../../tool.js'

// Registers a declared name first, then one the manifest does not carry. The first registration is
// what makes this a rollback case and not only a refusal case.
export default defineExtension((agnes) => {
  agnes.registerTool(fixtureTool('fx_declared'))
  agnes.registerTool(fixtureTool('fx_rogue'))
})
