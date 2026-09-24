import { type Disposer, defineExtension, defineTool } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'

export default defineExtension(async (agnes) => {
  const disposers: Disposer[] = []
  const dispose = () => {
    for (const close of disposers.splice(0).reverse()) close()
  }
  try {
    disposers.push(
      agnes.registerTool(
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
            costHint: undefined,
            deferLoading: undefined,
            requiresApproval: undefined,
          },
          execute: async (args, ctx) => {
            ctx.progress('echoing')
            return { content: [{ type: 'text', text: args.text }] }
          },
        }),
      ),
    )
    disposers.push(
      agnes.registerHook('tool_result', (p) =>
        p.name === 'minimal_echo' ? { result: { ...p.result, details: { source: 'minimal' } } } : {},
      ),
    )
    disposers.push(
      agnes.registerSlot('status.line', () => ({ text: 'minimal extension loaded', level: 'info' })),
    )
    disposers.push(
      agnes.registerResource({
        id: 'agnes-examples/minimal/echo-skill',
        kind: 'skill',
        name: 'Echo',
        description: 'Demonstrates a skill resource.',
      }),
    )
    await agnes.events.append('loaded', { version: agnes.ctx.version })
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
})
