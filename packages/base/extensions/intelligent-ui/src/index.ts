import type { IntelligentUiInstance } from '@agnes/intelligent-ui-contract'
import { intelligentUiKind, UI_PROVIDER_ID, UI_PROVIDER_VERSION } from '@agnes/intelligent-ui-contract'
import { type Context, defineAgnesPlugin, defineTool } from '@agnes/plugin-runtime'
import { UiCloseParams, UiRenderParams, UiUpdateParams } from '@agnes/protocol/gen/intelligent-ui'
import { Type } from '@sinclair/typebox'
import { UI_DATA_DESCRIPTION } from './data-contracts.js'
import { correctableUiRejection } from './input-rejection.js'
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
/** Display-only surface publication. ui_submit collects answers and must not inherit this flag. */
const presentational = { ...meta, deferLoading: false, isPresentational: true }
export default defineAgnesPlugin({
  inject: ['tools', 'projections', 'providers'],
  apply(plugin: Context) {
    const bound = async <T>(run: (ui: IntelligentUiInstance) => Promise<T>) => {
      const ui = await plugin.providers.bindOwn(intelligentUiKind)
      try {
        return await run(ui)
      } finally {
        await ui.dispose?.()
      }
    }
    const off = [
      plugin.providers.register(intelligentUiKind, '@agnes/base', {
        id: UI_PROVIDER_ID,
        version: UI_PROVIDER_VERSION,
        open: createIntelligentUiService,
      }),
      plugin.projections.register(uiProjection),
    ]
    off.push(
      plugin.tools.register(
        defineTool({
          name: 'ui_render',
          description:
            'Show tables, charts, forms and dashboards in the conversation/workbench UI. For "show/display in the UI", use this instead of writing HTML and presenting a file. Use present for files the user should open or download, and ask_user_question for a question or choice instead. Use presets or pinned plugin components; actions map to declared tools. No HTML or executable code.' +
            '\n' +
            UI_DATA_DESCRIPTION,
          parameters: reachableParameters(UiRenderParams),
          meta: presentational,
          async execute(input, ctx) {
            return correctableUiRejection(async () => {
              const record = await bound((ui) => ui.render(input, ctx.signal))
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
            })
          },
        }),
      ),
    )
    off.push(
      plugin.tools.register(
        defineTool({
          name: 'ui_update',
          description:
            'Replace an open surface at expectedRevision with revision + 1 after the previous action finishes.' +
            '\n' +
            UI_DATA_DESCRIPTION,
          parameters: reachableParameters(UiUpdateParams),
          meta: presentational,
          async execute(input, ctx) {
            return correctableUiRejection(async () => {
              const record = await bound((ui) => ui.update(input, ctx.signal))
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
            })
          },
        }),
      ),
    )
    off.push(
      plugin.tools.register(
        defineTool({
          name: 'ui_close',
          description: 'Close an open surface after actions finish. Closed actions cannot execute.',
          parameters: reachableParameters(UiCloseParams),
          meta: presentational,
          async execute(input, ctx) {
            return correctableUiRejection(async () => {
              const record = await bound((ui) => ui.close(input, ctx.signal))
              return {
                content: [{ type: 'text', text: `Closed ${record.surface.title}.` }],
                details: { surfaceId: record.surface.id, status: 'closed' },
              }
            })
          },
        }),
      ),
    )
    off.push(
      plugin.tools.register(
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
          meta: { ...meta, isReadOnly: true, modelVisible: false },
          async execute(args, ctx) {
            const accepted = await bound((ui) => ui.submittedInput(ctx.session.toolUseId, args, ctx.signal))
            return { content: [{ type: 'text', text: JSON.stringify(accepted) }] }
          },
        }),
      ),
    )
    return () => {
      for (const dispose of off.reverse()) dispose()
    }
  },
})
