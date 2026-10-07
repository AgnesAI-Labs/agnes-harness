import type { ModelAdapterPluginContext } from '@agnes/plugin-runtime'
import { replayAdapter, scriptedAdapter } from './replay.js'
export { replayAdapter, replayRequestKey, scriptedAdapter } from './replay.js'
export { readModelResponses, recordModelResponses, type ModelResponseRecord } from './trace.js'

/** Ordinary registry contributions, reusable in community and local-dev profiles. */
export const modelAdaptersPlugin = {
  inject: ['modelAdapters'],
  apply(ctx: ModelAdapterPluginContext) {
    ctx.modelAdapters.register(replayAdapter)
    ctx.modelAdapters.register(scriptedAdapter)
  },
}
