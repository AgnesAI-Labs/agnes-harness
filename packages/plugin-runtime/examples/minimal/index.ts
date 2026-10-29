import type { Disposer } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { type Context, defineAgnesPlugin, defineTool } from '../../src/index.js'

export default defineAgnesPlugin({
  inject: ['tools', 'hooks', 'slots', 'resources', 'eventLog', 'self'],
  async apply(plugin: Context) {
    const disposers: Disposer[] = []
    const dispose = () => {
      for (const close of disposers.splice(0).reverse()) close()
    }
    try {
      disposers.push(
        plugin.tools.register(
          defineTool({
            name: 'minimal_echo',
            description: 'Echo the input text back.',
            parameters: Type.Object(
              { text: Type.String({ maxLength: 1024 }) },
              { additionalProperties: false },
            ),
            meta: {
              isReadOnly: true,
              isDestructive: false,
              isConcurrencySafe: true,
              isOpenWorld: false,
              replay: 'safe',
            },
            execute: async (args, ctx) => {
              ctx.progress('echoing')
              return { content: [{ type: 'text', text: args.text }] }
            },
          }),
        ),
      )
      disposers.push(
        plugin.hooks.register('tool_result', (p) =>
          p.name === 'minimal_echo' ? { result: { ...p.result, details: { source: 'minimal' } } } : {},
        ),
      )
      disposers.push(
        plugin.slots.register('status.line', () => ({ text: 'minimal extension loaded', level: 'info' })),
      )
      disposers.push(
        plugin.resources.register({
          id: 'agnes-examples/minimal/echo-skill',
          kind: 'skill',
          name: 'Echo',
          description: 'Demonstrates a skill resource.',
        }),
      )
      await plugin.eventLog.append('loaded', { version: plugin.self.version })
      return dispose
    } catch (error) {
      dispose()
      throw error
    }
  },
})
