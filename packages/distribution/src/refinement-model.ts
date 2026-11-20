import { createProvider, NullContractStore, PiAdapter } from '@agnes/ai'
import { type RefinementModelOption, validateAgainst } from '@agnes/protocol'
import { RefinementModelId } from '@agnes/protocol/gen/agnes-v1'

/** The review gateways available to this deployment, in default-first order. */
export const REFINEMENT_ENDPOINTS: readonly [string, ...string[]] = Object.freeze([
  'https://api.llm.sg/v1',
  'https://api-llmsg-dev.agnes-dev.com/v1',
] as const)
export const DEFAULT_REFINEMENT_BASE_URL = REFINEMENT_ENDPOINTS[0]

export const isAllowedRefinementBaseUrl = (
  baseUrl: string,
  endpoints: readonly string[] = REFINEMENT_ENDPOINTS,
): boolean => endpoints.includes(baseUrl)

/** Deployment-owned review service. This route belongs only to the private maintenance provider. */
export const REFINEMENT_SERVICE = Object.freeze({
  route: 'task-experience',
  api: 'openai-completions',
  contextWindow: 65_536,
  maxTokens: 4_096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
})

export function createRefinementProvider(
  clock: () => number,
  key: () => string,
  baseUrl: string,
  model: { modelId: string; name?: string; contextWindow?: number; maxTokens?: number },
) {
  const { route, api, cost } = REFINEMENT_SERVICE
  const {
    modelId,
    name = modelId,
    contextWindow = REFINEMENT_SERVICE.contextWindow,
    maxTokens = REFINEMENT_SERVICE.maxTokens,
  } = model
  const adapter = new PiAdapter({
    manualRoutes: [
      {
        route,
        api,
        baseUrl,
        models: [
          {
            id: modelId,
            name,
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

const MAX_CATALOGUE_BYTES = 1024 * 1024
const MAX_MODELS = 4096
const NON_CHAT =
  /(?:^|[/:._-])(?:embeddings?|tts|whisper|stt|transcribe|dall-e|images?|moderation|rerank(?:er)?)(?:$|[/:._-]|\d)/i
const tokenLimit = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback

async function readCatalogue(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Missing review model catalogue')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_CATALOGUE_BYTES) throw new Error('Oversized review model catalogue')
      text += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Private gateway discovery. Only normalized chat model metadata crosses the RPC boundary. */
export async function fetchRefinementModels(
  baseUrl: string,
  key: string,
  signal: AbortSignal,
): Promise<RefinementModelOption[]> {
  const timeout = AbortSignal.timeout(10_000)
  const secret = key.trim()
  let response: Response
  try {
    const url = new URL(baseUrl)
    url.pathname = `${url.pathname.replace(/\/$/, '')}/models`
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${secret}` },
      redirect: 'error',
      signal: AbortSignal.any([signal, timeout]),
    })
  } catch {
    throw new Error('REFINEMENT_MODELS_UNAVAILABLE')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'REFINEMENT_KEY_INVALID'
        : 'REFINEMENT_MODELS_UNAVAILABLE',
    )
  }
  const body = await readCatalogue(response).catch(() => undefined)
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data) || data.length > MAX_MODELS) throw new Error('REFINEMENT_MODELS_UNAVAILABLE')
  const models = new Map<string, RefinementModelOption>()
  for (const item of data as unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const { id, name, context_length, max_output_tokens } = item as Record<string, unknown>
    if (
      typeof id !== 'string' ||
      !validateAgainst(RefinementModelId, id).ok ||
      id.includes(secret) ||
      NON_CHAT.test(id) ||
      models.has(id)
    )
      continue
    const label = typeof name === 'string' ? name.trim() : ''
    models.set(id, {
      id,
      name: label && label.length <= 256 && !/\p{Cc}/u.test(label) && !label.includes(secret) ? label : id,
      contextWindow: tokenLimit(context_length, REFINEMENT_SERVICE.contextWindow),
      maxTokens: tokenLimit(max_output_tokens, REFINEMENT_SERVICE.maxTokens),
    })
  }
  return [...models.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
