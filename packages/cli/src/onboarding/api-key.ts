import type { CredentialWriter } from '@agnes/host'
import {
  type AuthProfileOverlayStore,
  createDeepSeekApiKeyOverlay,
  DEEPSEEK_API_CREDENTIAL_REF,
  DEEPSEEK_API_MODELS_URL,
  DEEPSEEK_API_ROUTE,
} from './profile-overlay.js'
import type { OnboardingResult } from './state.js'

export type ApiKeyModel = Readonly<{ id: string }>

export type ApiKeyResponse = {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  readonly body?: { cancel(): Promise<void> } | null
  text(): Promise<string>
}

export type ApiKeyRequest = (
  url: URL,
  init: {
    readonly method: 'GET'
    readonly redirect: 'error'
    readonly headers: Readonly<Record<string, string>>
    readonly signal: AbortSignal
  },
) => Promise<ApiKeyResponse>

export type ApiKeyErrorCode =
  | 'API_KEY_INVALID_INPUT'
  | 'API_KEY_UNAUTHORIZED'
  | 'API_KEY_FORBIDDEN'
  | 'API_KEY_RATE_LIMITED'
  | 'CATALOG_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE'
  | 'AUTH_CANCELLED'
  | 'CREDENTIAL_WRITE_FAILED'
  | 'PROFILE_WRITE_FAILED'

const MESSAGES: Record<ApiKeyErrorCode, string> = {
  API_KEY_INVALID_INPUT: 'Enter a valid API key.',
  API_KEY_UNAUTHORIZED: 'The API key was not accepted.',
  API_KEY_FORBIDDEN: 'The API key cannot access the DeepSeek model catalogue.',
  API_KEY_RATE_LIMITED: 'The DeepSeek API is rate limited. Try again later.',
  CATALOG_UNAVAILABLE: 'The DeepSeek model catalogue is unavailable.',
  MODEL_UNAVAILABLE: 'Select a model returned by the DeepSeek model catalogue.',
  AUTH_CANCELLED: 'API-key setup was cancelled.',
  CREDENTIAL_WRITE_FAILED: 'The API key could not be stored securely.',
  PROFILE_WRITE_FAILED: 'The authentication profile could not be installed.',
}

export class ApiKeyOnboardingError extends Error {
  readonly code: ApiKeyErrorCode
  readonly status?: number
  readonly retryAfterMs?: number
  readonly reason?: 'timeout' | 'transport' | 'invalid-response'

  constructor(
    code: ApiKeyErrorCode,
    metadata: {
      status?: number
      retryAfterMs?: number
      reason?: 'timeout' | 'transport' | 'invalid-response'
    } = {},
  ) {
    super(MESSAGES[code])
    this.name = 'ApiKeyOnboardingError'
    this.code = code
    if (metadata.status !== undefined) this.status = metadata.status
    if (metadata.retryAfterMs !== undefined) this.retryAfterMs = metadata.retryAfterMs
    if (metadata.reason !== undefined) this.reason = metadata.reason
  }
}

const API_KEY = /^[\x21-\x7e]{8,65536}$/
const MODEL_ID = /^[^\p{Cc}\p{Z}\s]{1,256}$/u
const MAX_CATALOGUE_CHARS = 1024 * 1024
const MAX_MODELS = 1024
const DEFAULT_TIMEOUT_MS = 30_000
// Dynamic discovery proves entitlement; this trusted compatibility set proves that the current
// text/tool harness knows how to drive the model. New DeepSeek models are deliberately hidden until
// their wire capabilities have been reviewed rather than guessed from an id returned over HTTP.
const SUPPORTED_DEEPSEEK_MODELS: ReadonlySet<string> = new Set(['deepseek-flash', 'deepseek-v4-pro'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorForStatus(response: ApiKeyResponse): ApiKeyOnboardingError {
  if (response.status === 401) return new ApiKeyOnboardingError('API_KEY_UNAUTHORIZED', { status: 401 })
  if (response.status === 403) return new ApiKeyOnboardingError('API_KEY_FORBIDDEN', { status: 403 })
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'))
    const retryAfterMs =
      Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 86_400 ? seconds * 1000 : undefined
    return new ApiKeyOnboardingError('API_KEY_RATE_LIMITED', {
      status: 429,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    })
  }
  return new ApiKeyOnboardingError('CATALOG_UNAVAILABLE', { status: response.status })
}

async function readModels(response: ApiKeyResponse, key: string): Promise<readonly ApiKeyModel[]> {
  let raw: string
  try {
    raw = await response.text()
  } catch {
    throw new ApiKeyOnboardingError('CATALOG_UNAVAILABLE', { reason: 'invalid-response' })
  }
  if (raw.length > MAX_CATALOGUE_CHARS)
    throw new ApiKeyOnboardingError('CATALOG_UNAVAILABLE', { reason: 'invalid-response' })
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new ApiKeyOnboardingError('CATALOG_UNAVAILABLE', { reason: 'invalid-response' })
  }
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    value.data.length === 0 ||
    value.data.length > MAX_MODELS
  )
    throw new ApiKeyOnboardingError('CATALOG_UNAVAILABLE', { reason: 'invalid-response' })
  const ids: string[] = []
  for (const entry of value.data) {
    const id = isRecord(entry) ? entry.id : undefined
    // A reflected credential is not catalogue metadata and must never reach the profile overlay.
    if (typeof id !== 'string' || !MODEL_ID.test(id) || id.includes(key))
      throw new ApiKeyOnboardingError('CATALOG_UNAVAILABLE', { reason: 'invalid-response' })
    if (SUPPORTED_DEEPSEEK_MODELS.has(id)) ids.push(id)
  }
  if (ids.length === 0 || new Set(ids).size !== ids.length)
    throw new ApiKeyOnboardingError('CATALOG_UNAVAILABLE', { reason: 'invalid-response' })
  return Object.freeze(ids.map((id) => Object.freeze({ id })))
}

export async function probeDeepSeekApiKey(
  key: string,
  signal: AbortSignal,
  options: { request: ApiKeyRequest; timeoutMs?: number },
): Promise<readonly ApiKeyModel[]> {
  if (!API_KEY.test(key)) throw new ApiKeyOnboardingError('API_KEY_INVALID_INPUT')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new ApiKeyOnboardingError('CATALOG_UNAVAILABLE', { reason: 'timeout' })
  signal.throwIfAborted()
  const timeout = AbortSignal.timeout(timeoutMs)
  const operationSignal = AbortSignal.any([signal, timeout])
  let response: ApiKeyResponse
  try {
    response = await options.request(new URL(DEEPSEEK_API_MODELS_URL), {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
      signal: operationSignal,
    })
    operationSignal.throwIfAborted()
  } catch {
    signal.throwIfAborted()
    throw new ApiKeyOnboardingError('CATALOG_UNAVAILABLE', {
      reason: timeout.aborted ? 'timeout' : 'transport',
    })
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw errorForStatus(response)
  }
  try {
    const models = await readModels(response, key)
    operationSignal.throwIfAborted()
    return models
  } catch (error) {
    signal.throwIfAborted()
    if (timeout.aborted)
      throw new ApiKeyOnboardingError('CATALOG_UNAVAILABLE', {
        reason: 'timeout',
      })
    if (error instanceof ApiKeyOnboardingError) throw error
    throw new ApiKeyOnboardingError('CATALOG_UNAVAILABLE', { reason: 'invalid-response' })
  }
}

export type DeepSeekApiKeyOnboardingDeps = {
  request: ApiKeyRequest
  chooseModel(models: readonly ApiKeyModel[], signal: AbortSignal): Promise<string | null>
  credentials: Pick<CredentialWriter, 'putApiKey' | 'remove'>
  overlays: AuthProfileOverlayStore
  now(): string
  timeoutMs?: number
}

export async function onboardDeepSeekApiKey(
  input: { key: string; profile: string; signal: AbortSignal },
  deps: DeepSeekApiKeyOnboardingDeps,
): Promise<OnboardingResult> {
  const models = await probeDeepSeekApiKey(input.key, input.signal, {
    request: deps.request,
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  })
  let selected: string | null
  try {
    selected = await deps.chooseModel(models, input.signal)
    input.signal.throwIfAborted()
  } catch {
    input.signal.throwIfAborted()
    throw new ApiKeyOnboardingError('MODEL_UNAVAILABLE')
  }
  if (selected === null) throw new ApiKeyOnboardingError('AUTH_CANCELLED')
  if (!models.some((model) => model.id === selected)) throw new ApiKeyOnboardingError('MODEL_UNAVAILABLE')

  const overlay = createDeepSeekApiKeyOverlay({
    profile: input.profile,
    modelId: selected,
    modelIds: models.map((model) => model.id),
    fetchedAt: deps.now(),
  })
  try {
    await deps.credentials.putApiKey(DEEPSEEK_API_CREDENTIAL_REF, input.key)
  } catch {
    throw new ApiKeyOnboardingError('CREDENTIAL_WRITE_FAILED')
  }
  try {
    await deps.overlays.write(overlay)
    await deps.overlays.verify(overlay)
    input.signal.throwIfAborted()
  } catch {
    await Promise.allSettled([
      deps.overlays.remove(input.profile),
      deps.credentials.remove(DEEPSEEK_API_CREDENTIAL_REF),
    ])
    input.signal.throwIfAborted()
    throw new ApiKeyOnboardingError('PROFILE_WRITE_FAILED')
  }
  return {
    profile: input.profile,
    route: DEEPSEEK_API_ROUTE,
    model: selected,
    thinking: 'high',
    credentialRef: DEEPSEEK_API_CREDENTIAL_REF,
  }
}
