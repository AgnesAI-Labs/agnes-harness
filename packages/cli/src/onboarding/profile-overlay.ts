export const DEEPSEEK_API_ORIGIN = 'https://api.deepseek.com' as const
export const DEEPSEEK_API_BASE_URL = DEEPSEEK_API_ORIGIN
export const DEEPSEEK_API_MODELS_URL = `${DEEPSEEK_API_BASE_URL}/models` as const
export const DEEPSEEK_API_ROUTE = 'deepseek' as const
export const DEEPSEEK_API_CREDENTIAL_REF = 'secret://deepseek/default' as const

export type AuthProfileOverlayV1 = Readonly<{
  version: 1
  kind: 'auth-generated'
  profile: string
  route: Readonly<{
    id: string
    api: string
    baseUrl: string
    credentialRef: string
  }>
  model: Readonly<{ id: string; thinking: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }>
  catalog: Readonly<{
    source: string
    fetchedAt: string
    modelIds: readonly string[]
  }>
}>

export interface AuthProfileOverlayStore {
  write(overlay: AuthProfileOverlayV1): Promise<void>
  /** Re-read through the ordinary profile path and reject if the pinned route is not effective. */
  verify(overlay: AuthProfileOverlayV1): Promise<void>
  remove(profile: string): Promise<void>
}

export class AuthProfileOverlayError extends Error {
  readonly code: 'AUTH_PROFILE_INVALID' | 'AUTH_PROFILE_OVERRIDE'

  constructor(code: 'AUTH_PROFILE_INVALID' | 'AUTH_PROFILE_OVERRIDE') {
    super(
      code === 'AUTH_PROFILE_OVERRIDE'
        ? 'Protected authentication route cannot be overridden.'
        : 'Invalid authentication profile metadata.',
    )
    this.name = 'AuthProfileOverlayError'
    this.code = code
  }
}

const PROFILE = /^[a-z][a-z0-9-]{0,63}$/
const ROUTE_ID = /^[a-z][a-z0-9-]{0,63}$/
const API_ID = /^[a-z][a-z0-9-]{0,63}$/
const CREDENTIAL_REF = /^secret:\/\/[a-z][a-z0-9-]{0,63}\/default$/
const MODEL_ID = /^[^\p{Cc}\p{Z}\s]{1,256}$/u
const MAX_MODELS = 1024

function invalid(): never {
  throw new AuthProfileOverlayError('AUTH_PROFILE_INVALID')
}

function validTimestamp(value: string): boolean {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function validHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

/**
 * Builds an auth-generated overlay for any provider in the reviewed Pi registry.
 * The caller supplies route metadata from that registry; secrets never enter this shape.
 */
export function createApiKeyOverlay(input: {
  profile: string
  route: { id: string; api: string; baseUrl: string; credentialRef: string }
  modelId: string
  modelIds: readonly string[]
  fetchedAt: string
  catalogSource: string
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}): AuthProfileOverlayV1 {
  if (
    !PROFILE.test(input.profile) ||
    !ROUTE_ID.test(input.route.id) ||
    !API_ID.test(input.route.api) ||
    !validHttpsUrl(input.route.baseUrl) ||
    !CREDENTIAL_REF.test(input.route.credentialRef) ||
    input.route.credentialRef !== `secret://${input.route.id}/default` ||
    !validHttpsUrl(input.catalogSource) ||
    !validTimestamp(input.fetchedAt)
  )
    invalid()
  if (
    input.modelIds.length === 0 ||
    input.modelIds.length > MAX_MODELS ||
    input.modelIds.some((id) => !MODEL_ID.test(id)) ||
    new Set(input.modelIds).size !== input.modelIds.length ||
    !input.modelIds.includes(input.modelId)
  )
    invalid()
  const modelIds = Object.freeze([...input.modelIds])
  return Object.freeze({
    version: 1,
    kind: 'auth-generated',
    profile: input.profile,
    route: Object.freeze({ ...input.route }),
    model: Object.freeze({ id: input.modelId, thinking: input.thinking ?? 'high' }),
    catalog: Object.freeze({
      source: input.catalogSource,
      fetchedAt: input.fetchedAt,
      modelIds,
    }),
  })
}

/** Builds the only shape permitted in auth.generated metadata; there is no secret/header field. */
export function createDeepSeekApiKeyOverlay(input: {
  profile: string
  modelId: string
  modelIds: readonly string[]
  fetchedAt: string
}): AuthProfileOverlayV1 {
  return createApiKeyOverlay({
    profile: input.profile,
    route: {
      id: DEEPSEEK_API_ROUTE,
      api: 'openai-completions',
      baseUrl: DEEPSEEK_API_BASE_URL,
      credentialRef: DEEPSEEK_API_CREDENTIAL_REF,
    },
    modelId: input.modelId,
    modelIds: input.modelIds,
    fetchedAt: input.fetchedAt,
    catalogSource: DEEPSEEK_API_MODELS_URL,
    thinking: 'high',
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Fail closed before a workspace layer is merged. Other routes are outside this overlay's remit,
 * but a declaration for the managed route must repeat every protected destination field exactly.
 */
export function assertWorkspaceAuthSafe(overlay: AuthProfileOverlayV1, workspace: unknown): void {
  if (!isRecord(workspace)) return
  const provider = workspace.provider
  if (provider === undefined) return
  if (!isRecord(provider)) throw new AuthProfileOverlayError('AUTH_PROFILE_OVERRIDE')
  const routes = provider.routes
  if (routes === undefined) return
  if (!Array.isArray(routes)) throw new AuthProfileOverlayError('AUTH_PROFILE_OVERRIDE')
  for (const candidate of routes) {
    if (!isRecord(candidate)) throw new AuthProfileOverlayError('AUTH_PROFILE_OVERRIDE')
    if (candidate.route !== overlay.route.id) continue
    if (
      candidate.api !== overlay.route.api ||
      candidate.baseUrl !== overlay.route.baseUrl ||
      candidate.credentialRef !== overlay.route.credentialRef
    )
      throw new AuthProfileOverlayError('AUTH_PROFILE_OVERRIDE')
  }
}
