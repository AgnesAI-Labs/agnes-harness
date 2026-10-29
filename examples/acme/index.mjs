import { defineAgnesPlugin, defineTool, readOnlyTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'

export const status = defineTool({
  name: 'acme_status',
  description: 'Read a synthetic Acme service status; no external system is contacted.',
  parameters: Type.Object({}, { additionalProperties: false }),
  result: Type.Object({ service: Type.String(), status: Type.String(), synthetic: Type.Boolean() }),
  meta: readOnlyTool,
  async execute(_args, ctx) {
    ctx.signal.throwIfAborted()
    const structured = { service: 'acme-demo', status: 'healthy', synthetic: true }
    return { content: [{ type: 'text', text: JSON.stringify(structured) }], structured }
  },
})
export const main = defineAgnesPlugin({
  apply(ctx) {
    ctx.tools.register(status)
  },
})
