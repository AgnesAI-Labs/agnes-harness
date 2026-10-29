import type { ProbeReport, RouteDecl } from '@agnes/protocol'
import { deploymentFetch } from '@agnes/system-node/deployment-network'
import { ApiKeyProviderError } from './api-key-providers.js'

const MAX_CATALOG_BYTES = 1024 * 1024
const MAX_MODELS = 4096
const MODEL_ID = /^[^\p{Cc}\p{Z}\s]{1,256}$/u

/** Why a model listing failed; the endpoint's own text never becomes part of it. */
export type ProviderCatalogueFailure = Readonly<{
  reason: 'network' | 'timeout' | 'redirect' | 'http' | 'not-json' | 'empty' | 'invalid'
  status?: number
}>

/** IDs returned by a bounded provider model-list request, or why there were none. */
export type ProviderModels =
  | Readonly<{ ids: readonly string[] }>
  | Readonly<{ failure: ProviderCatalogueFailure }>

const failed = (reason: ProviderCatalogueFailure['reason'], status?: number): ProviderModels => ({
  failure: status === undefined ? { reason } : { reason, status },
})

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The parsed body, or `invalid` (oversized, not UTF-8) / `not-json` (does not parse). */
async function boundedJson(response: Response): Promise<{ value: unknown } | ProviderCatalogueFailure> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_CATALOG_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return { reason: 'invalid' }
  }
  if (!response.body) return { reason: 'not-json' }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_CATALOG_BYTES) {
        await reader.cancel().catch(() => undefined)
        return { reason: 'invalid' }
      }
      text += decoder.decode(next.value, { stream: true })
    }
    text += decoder.decode()
  } catch {
    return { reason: 'invalid' }
  } finally {
    reader.releaseLock()
  }
  try {
    return { value: JSON.parse(text) as unknown }
  } catch {
    return { reason: 'not-json' }
  }
}

/**
 * Performs the provider-owned part of configuration testing. It requests a bounded model catalogue
 * and returns IDs only, or the reason it could not; Host decides what those IDs may become. A
 * missing credential sends no authentication header at all.
 * Authentication/access refusals with a supplied credential throw a fixed-message ApiKeyProviderError carrying only HTTP status.
 */
export async function fetchProviderModels(options: {
  api: string
  baseUrl: string
  credential?: string
  signal?: AbortSignal
  request?: typeof globalThis.fetch
}): Promise<ProviderModels> {
  const credential =
    options.credential !== undefined && /\P{C}/u.test(options.credential.trim())
      ? options.credential
      : undefined
  if (
    !['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(
      options.api,
    )
  )
    return failed('invalid')
  let url: URL
  try {
    url = new URL(options.baseUrl)
  } catch {
    return failed('network')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.hostname.length === 0 ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    return failed('network')
  const resource = options.api === 'anthropic-messages' ? 'v1/models' : 'models'
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${resource}`
  if (options.api === 'google-generative-ai') url.searchParams.set('pageSize', '1000')
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.api === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01'
  if (credential !== undefined) {
    if (options.api === 'anthropic-messages') headers['x-api-key'] = credential
    else if (options.api === 'google-generative-ai') headers['x-goog-api-key'] = credential
    else headers.Authorization = `Bearer ${credential}`
  }
  const timeout = AbortSignal.timeout(30_000)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let response: Response
  try {
    // A redirect is reported, never followed: the credential stays with the address it was given for.
    response = await (options.request ?? deploymentFetch)(url, {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal,
    })
  } catch (error) {
    return failed(timeout.aborted || (error as Error)?.name === 'TimeoutError' ? 'timeout' : 'network')
  }
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel().catch(() => undefined)
    if (credential !== undefined && (response.status === 401 || response.status === 403))
      throw new ApiKeyProviderError('CATALOG_UNAVAILABLE', response.status)
    if (response.status >= 300 && response.status < 400) return failed('redirect', response.status)
    return response.ok ? failed('not-json') : failed('http', response.status)
  }
  const body = await boundedJson(response)
  if (!('value' in body)) return failed(body.reason)
  if (!object(body.value)) return failed('invalid')
  const data = body.value.data ?? body.value.models
  if (Array.isArray(data) && data.length === 0) return failed('empty')
  if (!Array.isArray(data) || data.length > MAX_MODELS) return failed('invalid')
  const ids: string[] = []
  for (const item of data) {
    if (!object(item)) return failed('invalid')
    // Gemini lists resource names (models/{id}); OpenAI/Anthropic list plain ids.
    // https://ai.google.dev/api/models#Model
    const id =
      options.api === 'google-generative-ai' && typeof item.name === 'string'
        ? item.name.replace(/^models\//, '')
        : item.id
    if (typeof id !== 'string' || !MODEL_ID.test(id) || (credential !== undefined && id.includes(credential)))
      return failed('invalid')
    ids.push(id)
  }
  if (new Set(ids).size !== ids.length) return failed('invalid')
  return { ids: Object.freeze(ids) }
}

/** Reachability only. Response contents never become catalogue or capability evidence. */
export async function probeModelsEndpoint(
  decl: RouteDecl | undefined,
  credential: string | undefined,
  keyless: boolean,
  signal: AbortSignal,
): Promise<ProbeReport['checks'][number]> {
  const failed = (detail: string) => ({ name: 'models_endpoint', ok: false, detail })
  if (signal.aborted) return failed('aborted')
  if (!decl) return failed('unknown route')
  if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(decl.api))
    return failed('protocol-specific catalogue probe is not implemented')
  if (credential === undefined && !(keyless && decl.credentialRef === undefined))
    return failed('credential is not bound')
  const anthropic = decl.api === 'anthropic-messages'
  if (anthropic && (decl.route === 'github-copilot' || credential?.includes('sk-ant-oat')))
    return failed('catalogue authentication variant is not implemented')
  const headers: Record<string, string> = anthropic ? { 'anthropic-version': '2023-06-01' } : {}
  if (credential !== undefined) {
    if (anthropic) headers['x-api-key'] = credential
    else headers.Authorization = `Bearer ${credential}`
  }
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ac.abort(), 30_000)
  try {
    const url = new URL(decl.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return failed('invalid endpoint')
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${anthropic ? 'v1/models' : 'models'}`
    url.hash = ''
    const response = await deploymentFetch(url, {
      signal: ac.signal,
      redirect: 'error',
      headers,
    })
    // Headers are all this reachability check needs. Do not buffer an unbounded response body.
    await response.body?.cancel()
    return { name: 'models_endpoint', ok: response.ok, detail: `status=${response.status}` }
  } catch {
    return failed(ac.signal.aborted ? 'catalogue probe interrupted' : 'catalogue probe failed')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    ac.abort()
  }
}
