import type { Api, Model, Provider as PiProvider } from '@earendil-works/pi-ai'

/**
 * Agnes AI runs separate regional gateways and issues keys per gateway. This China address is the
 * provider's default; the international one (https://apihub.agnes-ai.com/v1) is chosen by setting
 * the account's Base URL, which the account form offers as "Agnes AI International".
 */
export const AGNES_AI_BASE_URL = 'https://api.agnes-ai.cn/v1'

/**
 * The Agnes gateway sends a tool call only once it is complete, so a stream can stay silent for as
 * long as the model takes to write one. Matched by provider id or by gateway host, China
 * (agnes-ai.cn) or international (agnes-ai.com, e.g. apihub.agnes-ai.com), so an account pointed at
 * either gateway or its own Base URL path still counts.
 */
export function buffersToolCalls(baseUrl: string, providerId: string | undefined): boolean {
  if (providerId === 'agnes-ai') return true
  try {
    const host = new URL(baseUrl).hostname
    return ['agnes-ai.cn', 'agnes-ai.com'].some((domain) => host === domain || host.endsWith(`.${domain}`))
  } catch {
    return false
  }
}

/**
 * Chat models only: the image and video generation ids the gateway also lists stay out of the
 * catalogue. Ids are what `GET /v1/models` returns; it publishes no modalities, so `true` marks a
 * model that correctly described a test image on the live gateway (2026-09-22). The rest stay
 * text-only until verified. Output allowances follow the official model docs (2026-09-30):
 * https://agnes-ai.com/zh-Hans/docs/agnes-30-flash and agnes-25-pro{-alpha}: 65536.
 * agnes-25-flash and agnes-20-flash publish rounded 65.5K, interpreted as 65536 tokens.
 * Pro Beta uses the Pro family allowance. Context limits remain provisional; deprecated ids stay.
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
      // Agnes counts images across the complete request, including history and tool results.
      ...(image ? { inputLimits: { images: { maxPerRequest: 4 } } } : {}),
      contextWindow: 200000,
      maxTokens: 65536,
      compat: { maxTokensField: 'max_tokens' },
      reasoning: false,
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
