import { defineExtension, defineTool } from '@agnes/extension-api'
import { UiCloseParams, UiRenderParams, UiUpdateParams } from '@agnes/protocol/gen/intelligent-ui'
import { Type } from '@sinclair/typebox'
import { reachableParameters } from './parameters.js'
import { createIntelligentUiService } from './service.js'
import { uiProjection } from './state.js'

export { createIntelligentUiService } from './service.js'
export { UI_EVENTS, uiProjection } from './state.js'

const meta = {
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: 'idempotent' as const,
  costHint: {},
  deferLoading: true,
  requiresApproval: 'never' as const,
}
export default defineExtension((agnes) => {
  if (!agnes.intelligentUi) throw new Error('Host does not support Intelligent UI')
  const runtime = agnes.intelligentUi
  const off = [runtime.register(createIntelligentUiService), agnes.registerProjection(uiProjection)]
  off.push(
    agnes.registerTool(
      defineTool({
        name: 'ui_render',
        description:
          'Render a bounded surface with presets or pinned plugin-declared components in the conversation and workbench. Every action must map to a declared tool. No HTML or executable code.',
        parameters: reachableParameters(UiRenderParams),
        meta,
        async execute(input, ctx) {
          const record = await runtime.session(ctx.session).render(input, ctx.signal)
          return {
            content: [
              {
                type: 'text',
                text:
                  `${record.surface.title} — ${record.surface.components.length} components. [Open review](/?session=${encodeURIComponent(ctx.session.key)}&surface=${encodeURIComponent(record.surface.id)}).` +
                  record.surface.components
                    .flatMap((item) => ('fallback' in item ? ['\n' + item.fallback] : []))
                    .join(''),
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
        parameters: reachableParameters(UiUpdateParams),
        meta,
        async execute(input, ctx) {
          const record = await runtime.session(ctx.session).update(input, ctx.signal)
          return {
            content: [
              {
                type: 'text',
                text:
                  `Updated ${record.surface.title} (revision ${record.surface.revision}).` +
                  record.surface.components
                    .flatMap((item) => ('fallback' in item ? ['\n' + item.fallback] : []))
                    .join(''),
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
        parameters: reachableParameters(UiCloseParams),
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
  off.push(
    agnes.registerTool(
      defineTool({
        name: 'ui_submit',
        description:
          'Collect an authenticated surface form submission. Only the deferred surface action can call this tool; answering never grants permission.',
        parameters: Type.Object(
          {
            surfaceId: Type.String({ maxLength: 64 }),
            answers: Type.Record(
              Type.String(),
              Type.Union([
                Type.String({ minLength: 1, maxLength: 8192 }),
                Type.Array(Type.String({ minLength: 1, maxLength: 8192 }), {
                  minItems: 1,
                  maxItems: 12,
                  uniqueItems: true,
                }),
              ]),
            ),
          },
          { additionalProperties: false },
        ),
        meta: { ...meta, isReadOnly: true },
        async execute(args, ctx) {
          const accepted = await runtime
            .session(ctx.session)
            .submittedInput(ctx.session.toolUseId, args, ctx.signal)
          return { content: [{ type: 'text', text: JSON.stringify(accepted) }] }
        },
      }),
    ),
  )
  return () => {
    for (const dispose of off.reverse()) dispose()
  }
})
