import type { ModelRecord } from '@agnes/protocol'
import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
  type Provider as PiProvider,
} from '@earendil-works/pi-ai'
import { isUsableCredential } from '../../credentials.js'
import { PiAdapter, type PiStream } from './index.js'
import { KNOWN_THINKING_CORRECTIONS } from './known-thinking-corrections.js'

export type ApiKeyProviderId =
  | 'deepseek'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'qwen'
  | 'moonshot'
  | 'kimi-coding'
  | 'zai'
  | 'openrouter'
  | 'minimax'
  | 'xai'
  | 'agnes-ai'

export type ApiKeyProviderErrorCode =
  | 'UNKNOWN_PROVIDER'
  | 'PROVIDER_CONTRACT'
  | 'CREDENTIAL_INVALID'
  | 'CATALOG_INVALID'
  | 'CATALOG_UNAVAILABLE'
  | 'NO_MODELS'

/** A fixed-message failure: response bodies and credentials never become exception text or fields. */
export class ApiKeyProviderError extends Error {
  constructor(
    readonly code: ApiKeyProviderErrorCode,
    readonly status?: number,
  ) {
    super(
      code === 'UNKNOWN_PROVIDER'
        ? 'Unknown API-key provider.'
        : code === 'PROVIDER_CONTRACT'
          ? 'The installed provider catalogue does not match its pinned Agnes route.'
          : code === 'CREDENTIAL_INVALID'
            ? 'The API key is not usable.'
            : code === 'CATALOG_INVALID'
              ? 'The provider model catalogue is invalid.'
              : code === 'NO_MODELS'
                ? 'The API key has no supported models in the installed catalogue.'
                : 'The provider model catalogue is unavailable.',
    )
    this.name = 'ApiKeyProviderError'
  }
}

export type ApiKeyAdapterOptions = {
  /** An authenticated remote catalogue may only narrow the trusted pi catalogue, never add to it. */
  modelIds?: readonly string[]
  streamImpl?: PiStream
  maxRetries?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Per-provider construction options for the startup-time API-key route table. */
export type ApiKeyAdaptersOptions = Readonly<{
  adapters?: Readonly<Partial<Record<ApiKeyProviderId, ApiKeyAdapterOptions>>>
}>

export type ApiKeyCatalogOptions = {
  credential: string
  signal: AbortSignal
  request?: typeof globalThis.fetch
  timeoutMs?: number
}

export type ApiKeyProviderRegistryEntry = Readonly<{
  id: ApiKeyProviderId
  displayName: string
  availability: 'available'
  route: ApiKeyProviderId
  api: string
  baseUrl: string
  credentialRef: `secret://${ApiKeyProviderId}/default`
  sourceProviderId: string
  modelsUrl?: string
  createAdapter(options?: ApiKeyAdapterOptions): Promise<PiAdapter>
  /** Present only where the provider publishes a compatible, pinned model-list endpoint. */
  fetchModels?: (options: ApiKeyCatalogOptions) => Promise<readonly string[]>
}>

type ProviderSpec = Readonly<{
  id: ApiKeyProviderId
  displayName: string
  api: string
  baseUrl: string
  sourceProviderId: string
  modelsUrl?: string
  load: () => Promise<PiProvider>
  fetchModels?: (options: ApiKeyCatalogOptions) => Promise<readonly string[]>
}>

const load = async <T extends PiProvider>(module: Promise<Record<string, unknown>>, name: string) => {
  const factory = (await module)[name]
  if (typeof factory !== 'function') throw new ApiKeyProviderError('PROVIDER_CONTRACT')
  return (factory as () => T)()
}

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const DEEPSEEK_MODELS_URL = `${DEEPSEEK_BASE_URL}/models`

const specs: readonly ProviderSpec[] = [
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    api: 'openai-completions',
    baseUrl: DEEPSEEK_BASE_URL,
    sourceProviderId: 'deepseek',
    modelsUrl: DEEPSEEK_MODELS_URL,
    load: () => load(import('@earendil-works/pi-ai/providers/deepseek'), 'deepseekProvider'),
    fetchModels: fetchDeepSeekModels,
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    api: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    sourceProviderId: 'openai',
    load: () => load(import('@earendil-works/pi-ai/providers/openai'), 'openaiProvider'),
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic / Claude',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    sourceProviderId: 'anthropic',
    load: () => load(import('@earendil-works/pi-ai/providers/anthropic'), 'anthropicProvider'),
  },
  {
    id: 'google',
    displayName: 'Google / Gemini',
    api: 'google-generative-ai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    sourceProviderId: 'google',
    load: () => load(import('@earendil-works/pi-ai/providers/google'), 'googleProvider'),
  },
  {
    id: 'qwen',
    displayName: 'Qwen',
    api: 'openai-completions',
    baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    sourceProviderId: 'qwen-token-plan',
    load: () => load(import('@earendil-works/pi-ai/providers/qwen-token-plan'), 'qwenTokenPlanProvider'),
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot / Kimi',
    api: 'openai-completions',
    baseUrl: 'https://api.moonshot.ai/v1',
    sourceProviderId: 'moonshotai',
    load: () => load(import('@earendil-works/pi-ai/providers/moonshotai'), 'moonshotaiProvider'),
  },
  {
    id: 'kimi-coding',
    displayName: 'Kimi Coding Plan',
    api: 'anthropic-messages',
    baseUrl: 'https://api.kimi.com/coding',
    sourceProviderId: 'kimi-coding',
    load: () => load(import('@earendil-works/pi-ai/providers/kimi-coding'), 'kimiCodingProvider'),
  },
  {
    id: 'zai',
    displayName: 'Z.ai / GLM',
    api: 'openai-completions',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    sourceProviderId: 'zai',
    load: () => load(import('@earendil-works/pi-ai/providers/zai'), 'zaiProvider'),
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    sourceProviderId: 'openrouter',
    load: () => load(import('@earendil-works/pi-ai/providers/openrouter'), 'openrouterProvider'),
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    api: 'anthropic-messages',
    baseUrl: 'https://api.minimax.io/anthropic',
    sourceProviderId: 'minimax',
    load: () => load(import('@earendil-works/pi-ai/providers/minimax'), 'minimaxProvider'),
  },
  {
    id: 'xai',
    displayName: 'xAI',
    api: 'openai-responses',
    baseUrl: 'https://api.x.ai/v1',
    sourceProviderId: 'xai',
    load: () => load(import('@earendil-works/pi-ai/providers/xai'), 'xaiProvider'),
  },
  {
    id: 'agnes-ai',
    displayName: 'Agnes AI',
    api: 'openai-completions',
    baseUrl: 'https://api.agnes-ai.cn/v1',
    sourceProviderId: 'agnes-ai',
    load: () => load(import('./providers/agnes-ai.js'), 'agnesAiProvider'),
  },
] as const

const protocolThinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

function modelCost(model: Model<Api>): ModelRecord['cost'] {
  const tiers = 'tiers' in model.cost && Array.isArray(model.cost.tiers) ? model.cost.tiers : []
  const all = [model.cost, ...tiers]
  return {
    input: Math.max(...all.map((cost) => cost.input)),
    output: Math.max(...all.map((cost) => cost.output)),
    cacheRead: Math.max(...all.map((cost) => cost.cacheRead)),
    cacheWrite: Math.max(...all.map((cost) => cost.cacheWrite)),
  }
}

/**
 * Converts data from pi's installed, versioned catalogue; remote catalogues supply ids only.
 * A known correction (verified against the provider's own docs) replaces the catalogue's
 * reasoning/thinkingLevelMap outright when one exists for this model id.
 */
export function modelRecord(
  spec: { id: string; api: string; baseUrl: string },
  model: Model<Api>,
): ModelRecord {
  const correction = KNOWN_THINKING_CORRECTIONS[model.id]
  const reasoning = correction ? true : model.reasoning
  const supported = correction ? new Set(Object.keys(correction)) : new Set(getSupportedThinkingLevels(model))
  const thinkingLevelMap = Object.fromEntries(
    protocolThinkingLevels.flatMap((level) => {
      if (!supported.has(level)) return []
      const mapped = correction ? correction[level] : model.thinkingLevelMap?.[level]
      return [[level, typeof mapped === 'string' ? mapped : level]]
    }),
  )
  return {
    id: model.id,
    name: model.name,
    api: spec.api,
    route: spec.id,
    baseUrl: spec.baseUrl,
    reasoning,
    ...(reasoning && Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
    input: [...model.input],
    cost: modelCost(model),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.samplingParams
      ? {
          samplingParams: structuredClone(model.samplingParams) as Exclude<
            ModelRecord['samplingParams'],
            undefined
          >,
        }
      : {}),
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.compat
      ? {
          compat: structuredClone(model.compat) as Exclude<ModelRecord['compat'], undefined>,
        }
      : {}),
    toolCallFormats: ['native'],
    thinkingReplay: 'native',
    contract_id: null,
  }
}

const MODEL_ID = /^[^\p{Cc}\p{Z}\s]{1,256}$/u

function checkedModelIds(ids: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (ids === undefined) return undefined
  if (ids.length === 0 || ids.length > 1024 || ids.some((id) => !MODEL_ID.test(id)))
    throw new ApiKeyProviderError('CATALOG_INVALID')
  const selected = new Set(ids)
  if (selected.size !== ids.length) throw new ApiKeyProviderError('CATALOG_INVALID')
  return selected
}

async function createAdapter(spec: ProviderSpec, options: ApiKeyAdapterOptions = {}): Promise<PiAdapter> {
  const provider = await spec.load()
  if (provider.id !== spec.sourceProviderId || provider.baseUrl !== spec.baseUrl)
    throw new ApiKeyProviderError('PROVIDER_CONTRACT')
  const selected = checkedModelIds(options.modelIds)
  const models = provider
    .getModels()
    .filter(
      (model) =>
        model.provider === spec.sourceProviderId &&
        model.api === spec.api &&
        model.baseUrl === spec.baseUrl &&
        (selected === undefined || selected.has(model.id)),
    )
    .map((model) => modelRecord(spec, model))
  if (models.length === 0) throw new ApiKeyProviderError('NO_MODELS')
  return new PiAdapter({
    id: spec.id,
    manualRoutes: [
      {
        route: spec.id,
        api: spec.api,
        baseUrl: spec.baseUrl,
        credentialRef: `secret://${spec.id}/default`,
        models,
      },
    ],
    ...(options.streamImpl ? { streamImpl: options.streamImpl } : {}),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  })
}

export const API_KEY_PROVIDER_REGISTRY: readonly ApiKeyProviderRegistryEntry[] = Object.freeze(
  specs.map((spec) =>
    Object.freeze({
      id: spec.id,
      displayName: spec.displayName,
      availability: 'available' as const,
      route: spec.id,
      api: spec.api,
      baseUrl: spec.baseUrl,
      credentialRef: `secret://${spec.id}/default` as const,
      sourceProviderId: spec.sourceProviderId,
      ...(spec.modelsUrl ? { modelsUrl: spec.modelsUrl } : {}),
      createAdapter: (options?: ApiKeyAdapterOptions) => createAdapter(spec, options),
      ...(spec.fetchModels ? { fetchModels: spec.fetchModels } : {}),
    }),
  ),
)

/**
 * The only credential references that an API-key client may leave unbound at startup.  Supplying
 * this set to `createProvider` preserves fail-fast assembly for every other route while letting a
 * first-run UI register all eleven choices before the user has entered any keys.
 */
export const API_KEY_CREDENTIAL_REFS: ReadonlySet<string> = new Set(
  API_KEY_PROVIDER_REGISTRY.map((entry) => entry.credentialRef),
)

/**
 * Creates the complete, fixed API-key route table once at startup.  This never reads a credential
 * and therefore cannot block a first launch; an unconfigured route returns AUTH from PiAdapter
 * before network I/O when the user actually selects it.
 */
export async function createApiKeyProviderAdapters(
  options: ApiKeyAdaptersOptions = {},
): Promise<readonly PiAdapter[]> {
  const adapters = await Promise.all(
    API_KEY_PROVIDER_REGISTRY.map((entry) => entry.createAdapter(options.adapters?.[entry.id])),
  )
  return Object.freeze(adapters)
}

const byId = new Map(API_KEY_PROVIDER_REGISTRY.map((entry) => [entry.id, entry]))

export function getApiKeyProvider(id: string): ApiKeyProviderRegistryEntry | undefined {
  return byId.get(id as ApiKeyProviderId)
}

const MAX_CATALOG_BYTES = 1024 * 1024
const MAX_MODELS = 1024

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function boundedText(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_CATALOG_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new ApiKeyProviderError('CATALOG_INVALID')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_CATALOG_BYTES) throw new ApiKeyProviderError('CATALOG_INVALID')
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (error instanceof ApiKeyProviderError) throw error
    throw new ApiKeyProviderError('CATALOG_INVALID')
  } finally {
    reader.releaseLock()
  }
}

function parseDeepSeekModels(value: unknown, credential: string): readonly string[] {
  if (!object(value) || !exactKeys(value, ['data', 'object']) || value.object !== 'list')
    throw new ApiKeyProviderError('CATALOG_INVALID')
  if (!Array.isArray(value.data) || value.data.length === 0 || value.data.length > MAX_MODELS)
    throw new ApiKeyProviderError('CATALOG_INVALID')
  const ids: string[] = []
  for (const item of value.data) {
    if (
      !object(item) ||
      !exactKeys(item, ['id', 'object', 'owned_by']) ||
      typeof item.id !== 'string' ||
      !MODEL_ID.test(item.id) ||
      item.id.includes(credential) ||
      item.object !== 'model' ||
      item.owned_by !== 'deepseek'
    )
      throw new ApiKeyProviderError('CATALOG_INVALID')
    ids.push(item.id)
  }
  if (new Set(ids).size !== ids.length) throw new ApiKeyProviderError('CATALOG_INVALID')
  return Object.freeze(ids)
}

async function fetchDeepSeekModels(options: ApiKeyCatalogOptions): Promise<readonly string[]> {
  if (!isUsableCredential(options.credential) || !/^[\x21-\x7e]{8,65536}$/.test(options.credential))
    throw new ApiKeyProviderError('CREDENTIAL_INVALID')
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new ApiKeyProviderError('CATALOG_UNAVAILABLE')
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([options.signal, timeout])
  const request = options.request ?? globalThis.fetch
  let response: Response
  try {
    signal.throwIfAborted()
    response = await request(new URL(DEEPSEEK_MODELS_URL), {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `Bearer ${options.credential}` },
      signal,
    })
  } catch {
    throw new ApiKeyProviderError('CATALOG_UNAVAILABLE')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new ApiKeyProviderError('CATALOG_UNAVAILABLE', response.status)
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel().catch(() => undefined)
    throw new ApiKeyProviderError('CATALOG_INVALID')
  }
  let value: unknown
  try {
    value = JSON.parse(await boundedText(response))
  } catch (error) {
    if (error instanceof ApiKeyProviderError) throw error
    throw new ApiKeyProviderError('CATALOG_INVALID')
  }
  return parseDeepSeekModels(value, options.credential)
}
