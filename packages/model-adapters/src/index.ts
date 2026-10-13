import { modelAdapterKind } from '@agnes/extension-api'
import type { ProviderPluginContext } from '@agnes/plugin-runtime'
import { localOpenAIAdapter } from './local-openai.js'
import { replayAdapter, scriptedAdapter } from './replay.js'

export { discoverLocalModels, localOpenAIAdapter } from './local-openai.js'
export { replayAdapter, replayRequestKey, scriptedAdapter } from './replay.js'
export { type ModelResponseRecord, readModelResponses, recordModelResponses } from './trace.js'

/** Ordinary registry contributions, reusable in community and local-dev profiles. */
export const modelAdaptersPlugin = {
  inject: ['providers'],
  apply(ctx: ProviderPluginContext) {
    ctx.providers.register(modelAdapterKind, replayAdapter)
    ctx.providers.register(modelAdapterKind, scriptedAdapter)
    ctx.providers.register(modelAdapterKind, localOpenAIAdapter)
  },
}
