import type { Api, Model, Provider as PiProvider } from '@earendil-works/pi-ai'

/**
 * Agnes AI runs separate regional gateways. Only the China gateway is supported for now; the
 * international hub (apihub.agnes-ai.com) rejects China keys and is not registered yet.
 */
export const AGNES_AI_BASE_URL = 'https://api.agnes-ai.cn/v1'

/**
 * Chat models only: the image and video generation ids the gateway also lists stay out of the
 * catalogue. Ids are what `GET /v1/models` returns; it publishes no modalities, so `true` marks a
 * model that correctly described a test image on the live gateway (2026-09-22). The rest stay
 * text-only until verified. The limits are provisional until the provider publishes per-model
 * numbers, which is why every entry carries the same pair.
 */
const CHAT_MODELS = [
  ['agnes-3.0-flash', 'Agnes 3.0 Flash', true],
  ['agnes-2.5-pro', 'Agnes 2.5 Pro', false],
  ['agnes-2.5-pro-alpha', 'Agnes 2.5 Pro Alpha', false],
  ['agnes-2.5-pro-beta', 'Agnes 2.5 Pro Beta', false],
  ['agnes-2.5-flash', 'Agnes 2.5 Flash', true],
  ['agnes-2.0-flash', 'Agnes 2.0 Flash', true],
] as const

const AGNES_AI_MODELS: Model<Api>[] = CHAT_MODELS.map(
  ([id, name, image]) =>
    ({
      id,
      name,
      provider: 'agnes-ai',
      api: 'openai-completions',
      baseUrl: AGNES_AI_BASE_URL,
      input: image ? ['text', 'image'] : ['text'],
      contextWindow: 200000,
      maxTokens: 4096,
      reasoning: false,
      samplingParams: {
        temperature: { min: 0, max: 2, step: 0.01 },
        top_p: { min: 0, max: 1, step: 0.01 },
      },
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    }) as Model<'openai-completions'>,
)

/**
 * The registry only reads this object's identity and `getModels()` (api-key-providers.ts:289-300);
 * streaming runs through this package's own adapter, never through a pi `Provider`'s `stream`. The
 * double cast says that plainly instead of fabricating auth/stream members that nothing calls.
 */
export function agnesAiProvider(): PiProvider {
  return {
    id: 'agnes-ai',
    name: 'Agnes AI',
    baseUrl: AGNES_AI_BASE_URL,
    getModels: () => AGNES_AI_MODELS,
  } as unknown as PiProvider
}
