import { type Context, defineAgnesPlugin, defineTool, readOnlyTool, toolError } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'

export interface Config {
  prefix?: string
}

export function createEcho(config: Config = {}) {
  const prefix = config.prefix ?? 'Echo: '
  if (typeof prefix !== 'string' || prefix.length > 64)
    throw new TypeError('prefix must be a string of at most 64 characters')
  return defineTool({
    name: 'plugin_tool_panel',
    description: 'Echo a nonempty message with the configured prefix.',
    parameters: Type.Object({ message: Type.String({ maxLength: 512 }) }, { additionalProperties: false }),
    result: Type.Object(
      { message: Type.String(), characters: Type.Integer({ minimum: 1 }) },
      { additionalProperties: false },
    ),
    meta: readOnlyTool,
    async execute({ message }, ctx) {
      ctx.signal.throwIfAborted()
      const trimmed = message.trim()
      if (!trimmed) return toolError('A nonempty message is required')
      const result = { message: prefix + trimmed, characters: [...trimmed].length }
      return { content: [{ type: 'text', text: result.message }], structured: result }
    },
  })
}

export const main = defineAgnesPlugin({
  apply(ctx: Context, config: Config = {}) {
    ctx.tools.register(createEcho(config))
  },
})
