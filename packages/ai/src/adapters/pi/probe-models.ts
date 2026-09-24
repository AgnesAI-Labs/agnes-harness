import type { ProbeReport, RouteDecl } from '@agnes/protocol'

const MAX_CATALOG_BYTES = 1024 * 1024
const MAX_MODELS = 4096
const MODEL_ID = /^[^\p{Cc}\p{Z}\s]{1,256}$/u

/** IDs returned by a bounded, authenticated provider model-list request. */
export type ProviderModels = Readonly<{ ids: readonly string[] }>

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function boundedJson(response: Response): Promise<unknown | undefined> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_CATALOG_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  if (!response.body) return undefined
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
        return undefined
      }
      text += decoder.decode(next.value, { stream: true })
    }
    text += decoder.decode()
  } catch {
    return undefined
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * Performs the provider-owned part of configuration testing. It authenticates a bounded model
 * catalogue request and returns IDs only; Host intersects them with the installed, reviewed
 * catalogue before exposing models or building a runtime route.
 */
export async function fetchProviderModels(options: {
  api: string
  baseUrl: string
  credential: string
  signal?: AbortSignal
  request?: typeof globalThis.fetch
}): Promise<ProviderModels | undefined> {
  if (!/\P{C}/u.test(options.credential.trim())) return undefined
  if (
    !['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(
      options.api,
    )
  )
    return undefined
  let url: URL
  try {
    url = new URL(options.baseUrl)
  } catch {
    return undefined
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.hostname.length === 0 ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    return undefined
  const resource = options.api === 'anthropic-messages' ? 'v1/models' : 'models'
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${resource}`
  if (options.api === 'google-generative-ai') url.searchParams.set('pageSize', '1000')
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.api === 'anthropic-messages') {
    headers['x-api-key'] = options.credential
    headers['anthropic-version'] = '2023-06-01'
  } else if (options.api === 'google-generative-ai') headers['x-goog-api-key'] = options.credential
  else headers.Authorization = `Bearer ${options.credential}`
  const timeout = AbortSignal.timeout(30_000)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let response: Response
  try {
    response = await (options.request ?? globalThis.fetch)(url, {
      method: 'GET',
      redirect: 'error',
      headers,
      signal,
    })
  } catch {
    return undefined
  }
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  const body = await boundedJson(response)
  if (!object(body)) return undefined
  const data = body.data ?? body.models
  if (!Array.isArray(data) || data.length === 0 || data.length > MAX_MODELS) return undefined
  const ids: string[] = []
  for (const item of data) {
    if (!object(item)) return undefined
    // Gemini lists resource names (models/{id}); OpenAI/Anthropic list plain ids.
    // https://ai.google.dev/api/models#Model
    const id =
      options.api === 'google-generative-ai' && typeof item.name === 'string'
        ? item.name.replace(/^models\//, '')
        : item.id
    if (typeof id !== 'string' || !MODEL_ID.test(id) || id.includes(options.credential)) return undefined
    ids.push(id)
  }
  if (new Set(ids).size !== ids.length) return undefined
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
    const response = await fetch(url, {
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
