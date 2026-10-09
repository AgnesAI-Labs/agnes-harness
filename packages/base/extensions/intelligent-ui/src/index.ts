import { defineExtension, defineTool } from '@agnes/extension-api'
import { UiCloseParams, UiRenderParams, UiUpdateParams } from '@agnes/protocol'
import { createIntelligentUiService } from './service.js'
import { uiProjection } from './state.js'

export { createIntelligentUiService } from './service.js'
export { uiProjection, UI_EVENTS } from './state.js'
const meta = {
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: 'idempotent' as const,
  costHint: {},
  deferLoading: false,
  requiresApproval: 'never' as const,
}
export default defineExtension((agnes) => {
  if (!agnes.intelligentUi) throw new Error('Host does not support preset Intelligent UI')
  const runtime = agnes.intelligentUi
  const off = [runtime.register(createIntelligentUiService), agnes.registerProjection(uiProjection)]
  off.push(
    agnes.registerTool(
      defineTool({
        name: 'ui_render',
        description:
          'Render a bounded preset surface in the conversation and workbench. Every action must map to a declared tool. No HTML or executable code.',
        parameters: UiRenderParams,
        meta,
        async execute(input, ctx) {
          const record = await runtime.session(ctx.session).render(input, ctx.signal)
          return {
            content: [
              {
                type: 'text',
                text: `${record.surface.title} — ${record.surface.components.length} components. [Open workbench](/sessions/${encodeURIComponent(ctx.session.key)}?surface=${encodeURIComponent(record.surface.id)}).`,
              },
            ],
            details: { surface: record.surface },
          }
        },
      }),
    ),
  )
  off.push(
    agnes.registerTool(
      defineTool({
        name: 'ui_update',
        description:
          'Replace an open surface at expectedRevision with revision + 1 after the previous action finishes.',
        parameters: UiUpdateParams,
        meta,
        async execute(input, ctx) {
          const record = await runtime.session(ctx.session).update(input, ctx.signal)
          return {
            content: [
              {
                type: 'text',
                text: `Updated ${record.surface.title} (revision ${record.surface.revision}).`,
              },
            ],
            details: { surface: record.surface },
          }
        },
      }),
    ),
  )
  off.push(
    agnes.registerTool(
      defineTool({
        name: 'ui_close',
        description: 'Close an open surface after actions finish. Closed actions cannot execute.',
        parameters: UiCloseParams,
        meta,
        async execute(input, ctx) {
          const record = await runtime.session(ctx.session).close(input, ctx.signal)
          return {
            content: [{ type: 'text', text: `Closed ${record.surface.title}.` }],
            details: { surfaceId: record.surface.id, status: 'closed' },
          }
        },
      }),
    ),
  )
  return () => off.reverse().forEach((dispose) => dispose())
})
