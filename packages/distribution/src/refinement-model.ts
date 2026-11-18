import { createProvider, NullContractStore, PiAdapter } from '@agnes/ai'

/** Deployment-owned review service. This route belongs only to the private maintenance provider. */
export const REFINEMENT_MODEL = Object.freeze({
  baseUrl: 'https://api.llm.sg/v1',
  modelId: 'agnes-rsi',
  modelName: 'Task experience',
  route: 'task-experience',
  api: 'openai-completions',
  contextWindow: 65_536,
  maxTokens: 4_096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
})

export function createRefinementProvider(clock: () => number, key: () => string) {
  const { route, api, baseUrl, modelId, modelName, cost, contextWindow, maxTokens } = REFINEMENT_MODEL
  const adapter = new PiAdapter({
    manualRoutes: [
      {
        route,
        api,
        baseUrl,
        models: [
          {
            id: modelId,
            name: modelName,
            route,
            api,
            baseUrl,
            cost,
            contextWindow,
            maxTokens,
            reasoning: false,
            input: ['text'],
            toolCallFormats: ['native'],
            thinkingReplay: 'drop',
            contract_id: null,
            compat: { supportsUsageInStreaming: true },
          },
        ],
      },
    ],
    resolveCredential: async () => key(),
  })
  return createProvider({
    adapters: [adapter],
    routes: { primary: { route, model: modelId } },
    contract: new NullContractStore(),
    secrets: key,
    clock,
  })
}
