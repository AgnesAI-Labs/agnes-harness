import type { IntelligentUiInstance } from '@agnes/intelligent-ui-contract'
import {
  intelligentUiKind,
  UI_PROVIDER_ID,
  UI_PROVIDER_VERSION,
  UI_SUBMIT_TOOL,
} from '@agnes/intelligent-ui-contract'
import { type Context, defineAgnesPlugin, defineTool } from '@agnes/plugin-runtime'
import type { UiSurface } from '@agnes/protocol'
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
// Only model-facing structure is abbreviated. The service validates the full protocol schema
// and component/data/action contracts before publication, including calls from other clients.
const surfaceParameter = Type.Unsafe<UiSurface>(
  Type.Object(
    {},
    {
      additionalProperties: true,
      description:
        'Complete UiSurface object. Read ui_guide before constructing components, data or actions.',
    },
  ),
)
const renderParameters = Type.Object({ surface: surfaceParameter }, { additionalProperties: false })
const updateParameters = Type.Object(
  {
    surfaceId: Type.String({ minLength: 1, maxLength: 64 }),
    expectedRevision: Type.Integer({ minimum: 1 }),
    surface: surfaceParameter,
  },
  { additionalProperties: false },
)
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
      plugin.providers.register(intelligentUiKind, {
        id: UI_PROVIDER_ID,
        version: UI_PROVIDER_VERSION,
        open: createIntelligentUiService,
      }),
      plugin.projections.register(uiProjection),
    ]
    off.push(
      plugin.tools.register(
        defineTool({
          name: 'ui_guide',
          description:
            'Read the complete UI surface schema, component catalog and data examples before ui_render or ui_update.',
          parameters: Type.Object(
            { operation: Type.Union([Type.Literal('render'), Type.Literal('update')]) },
            { additionalProperties: false },
          ),
          meta: { ...meta, deferLoading: false, isReadOnly: true, isConcurrencySafe: true, replay: 'safe' },
          async execute({ operation }, ctx) {
            ctx.signal.throwIfAborted()
            const parameters = reachableParameters(operation === 'render' ? UiRenderParams : UiUpdateParams)
            return {
              content: [
                { type: 'text', text: `${UI_DATA_DESCRIPTION}\n\nParameters: ${JSON.stringify(parameters)}` },
              ],
            }
          },
        }),
      ),
    )
    off.push(
      plugin.tools.register(
        defineTool({
          name: 'ui_render',
          description:
            'Show tables, charts, forms or dashboards in the UI. Read ui_guide first for component formats and examples. Plain text stays in the reply. Use titles in the conversation language. If a visual cannot be produced, explain the limitation and use text/markdown.',
          parameters: renderParameters,
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
            'Replace an open surface at expectedRevision with revision + 1 after actions finish. Read ui_guide for the complete surface contract.',
          parameters: updateParameters,
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
          name: UI_SUBMIT_TOOL,
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
