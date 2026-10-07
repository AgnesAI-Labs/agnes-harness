import type { SearchResult } from '@agnes/extension-api'

/** Official web search backends. Keys never appear in this document. */
export const SEARCH_PROVIDER_IDS = ['brave', 'tavily', 'exa', 'perplexity', 'searxng'] as const
export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number]
export type SearchFailureCode =
  | 'SEARCH_NOT_CONFIGURED'
  | 'SEARCH_RATE_LIMITED'
  | 'SEARCH_TIMEOUT'
  | 'SEARCH_FAILED'
  | 'SEARCH_INVALID'

export class SearchProviderError extends Error {
  readonly code: SearchFailureCode
  constructor(code: SearchFailureCode, message: string) {
    super(message)
    this.name = 'SearchProviderError'
    this.code = code
  }
}

export type SearchCatalogEntry = {
  id: SearchProviderId
  label: string
  needsKey: boolean
  endpoint: string
  ratePerMinute: number
}

export const SEARCH_CATALOG: readonly SearchCatalogEntry[] = [
  {
    id: 'brave',
    label: 'Brave',
    needsKey: true,
    endpoint: 'https://api.search.brave.com',
    ratePerMinute: 30,
  },
  { id: 'tavily', label: 'Tavily', needsKey: true, endpoint: 'https://api.tavily.com', ratePerMinute: 30 },
  { id: 'exa', label: 'Exa', needsKey: true, endpoint: 'https://api.exa.ai', ratePerMinute: 30 },
  {
    id: 'perplexity',
    label: 'Perplexity',
    needsKey: true,
    endpoint: 'https://api.perplexity.ai',
    ratePerMinute: 30,
  },
  { id: 'searxng', label: 'SearXNG', needsKey: false, endpoint: '', ratePerMinute: 60 },
]

export const SEARCH_RESULT_LIMIT = { min: 1, max: 10, default: 5 } as const
export const SEARCH_TIMEOUT_LIMIT = { min: 1_000, max: 60_000, default: 15_000 } as const
export const SEARCH_RATE_LIMIT = { min: 1, max: 600 } as const

const FORBIDDEN_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'secret',
  'authorization',
  'password',
  'key',
  'credential',
])

export type StoredProvider = {
  id: SearchProviderId
  enabled: boolean
  endpoint?: string
  maxResults?: number
  timeoutMs?: number
  ratePerMinute?: number
}

export type StoredSearchConfig = {
  version: 1
  defaultProvider?: SearchProviderId
  providers: StoredProvider[]
}

export type ResolvedProvider = {
  id: SearchProviderId
  label: string
  needsKey: boolean
  enabled: boolean
  endpoint: string
  maxResults: number
  timeoutMs: number
  ratePerMinute: number
  secretRef: string
  endpointValid: boolean
}

export type SearchHit = { title: string; url: string; snippet: string; citation: string }
export type BackendOutcome = { answer?: string; hits: SearchHit[] }

export function isSearchProviderId(value: unknown): value is SearchProviderId {
  return typeof value === 'string' && SEARCH_PROVIDER_IDS.some((id) => id === value)
}

export function searchCatalog(id: SearchProviderId): SearchCatalogEntry {
  const entry = SEARCH_CATALOG.find((item) => item.id === id)
  if (!entry) throw new SearchProviderError('SEARCH_INVALID', 'Unknown search provider.')
  return entry
}

/** Fixed credential-store reference. The configuration file never stores the key. */
export function searchSecretRef(id: SearchProviderId): string {
  return `secret://search/${id}`
}

export function emptySearchConfig(): StoredSearchConfig {
  return { version: 1, providers: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey)
  if (!isRecord(value)) return false
  return Object.entries(value).some(
    ([key, nested]) => FORBIDDEN_KEYS.has(key.toLowerCase()) || containsForbiddenKey(nested),
  )
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/** Accept https origins. SearXNG may use loopback http. Userinfo and query strings are refused. */
export function endpointError(id: SearchProviderId, endpoint: string): string | undefined {
  if (endpoint.length === 0 || endpoint.length > 2048) return 'endpoint'
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return 'endpoint'
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
    return 'endpoint'
  if (url.protocol === 'https:') return undefined
  if (id === 'searxng' && url.protocol === 'http:' && isLoopback(url.hostname)) return undefined
  return 'endpoint'
}

export function normalizeEndpoint(endpoint: string): string {
  return endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint
}

function optionalEndpoint(id: SearchProviderId, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || endpointError(id, normalizeEndpoint(value)))
    throw new SearchProviderError('SEARCH_INVALID', 'Search settings are not valid.')
  return normalizeEndpoint(value)
}

function optionalLimit(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (!inRange(value, min, max))
    throw new SearchProviderError('SEARCH_INVALID', 'Search settings are not valid.')
  return value
}

export function parseStoredProvider(value: unknown): StoredProvider {
  if (!isRecord(value) || !isSearchProviderId(value.id) || typeof value.enabled !== 'boolean')
    throw new SearchProviderError('SEARCH_INVALID', 'Search settings are not valid.')
  const allowed = new Set(['id', 'enabled', 'endpoint', 'maxResults', 'timeoutMs', 'ratePerMinute'])
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new SearchProviderError('SEARCH_INVALID', 'Search settings are not valid.')
  const endpoint = optionalEndpoint(value.id, value.endpoint)
  const maxResults = optionalLimit(value.maxResults, SEARCH_RESULT_LIMIT.min, SEARCH_RESULT_LIMIT.max)
  const timeoutMs = optionalLimit(value.timeoutMs, SEARCH_TIMEOUT_LIMIT.min, SEARCH_TIMEOUT_LIMIT.max)
  const ratePerMinute = optionalLimit(value.ratePerMinute, SEARCH_RATE_LIMIT.min, SEARCH_RATE_LIMIT.max)
  return {
    id: value.id,
    enabled: value.enabled,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(maxResults !== undefined ? { maxResults } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(ratePerMinute !== undefined ? { ratePerMinute } : {}),
  }
}

export function parseStoredConfig(value: unknown): StoredSearchConfig {
  if (containsForbiddenKey(value))
    throw new SearchProviderError('SEARCH_INVALID', 'Search settings are not valid.')
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.providers))
    throw new SearchProviderError('SEARCH_INVALID', 'Search settings are not valid.')
  if (value.defaultProvider !== undefined && !isSearchProviderId(value.defaultProvider))
    throw new SearchProviderError('SEARCH_INVALID', 'Search settings are not valid.')
  const allowed = new Set(['version', 'defaultProvider', 'providers'])
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.providers.length > SEARCH_PROVIDER_IDS.length
  )
    throw new SearchProviderError('SEARCH_INVALID', 'Search settings are not valid.')
  const providers = value.providers.map(parseStoredProvider)
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length)
    throw new SearchProviderError('SEARCH_INVALID', 'Search settings are not valid.')
  return {
    version: 1,
    ...(isSearchProviderId(value.defaultProvider) ? { defaultProvider: value.defaultProvider } : {}),
    providers,
  }
}

export function resolveProvider(config: StoredSearchConfig, id: SearchProviderId): ResolvedProvider {
  const catalog = searchCatalog(id)
  const stored = config.providers.find((provider) => provider.id === id)
  const endpoint = normalizeEndpoint(stored?.endpoint ?? catalog.endpoint)
  return {
    id,
    label: catalog.label,
    needsKey: catalog.needsKey,
    enabled: stored?.enabled ?? false,
    endpoint,
    maxResults: stored?.maxResults ?? SEARCH_RESULT_LIMIT.default,
    timeoutMs: stored?.timeoutMs ?? SEARCH_TIMEOUT_LIMIT.default,
    ratePerMinute: stored?.ratePerMinute ?? catalog.ratePerMinute,
    secretRef: searchSecretRef(id),
    endpointValid: endpointError(id, endpoint) === undefined,
  }
}

export function providerReady(provider: ResolvedProvider, secretConfigured: boolean): boolean {
  return provider.enabled && provider.endpointValid && (!provider.needsKey || secretConfigured)
}

function citationBlock(urls: readonly string[]): string {
  const lines = [...new Set(urls.filter((url) => url.startsWith('https://') || url.startsWith('http://')))]
  return lines.length === 0 ? '' : `\n\nCitations:\n${lines.map((url) => `- ${url}`).join('\n')}`
}

export function redact(text: string, secret?: string): string {
  let cleaned = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code !== 9 && code !== 10 && code !== 13 && code < 32) continue
    cleaned += char
    if (cleaned.length >= 2_000) break
  }
  return secret && secret.length >= 6 ? cleaned.split(secret).join('[redacted]') : cleaned
}

/** Stable SearchResult rows. Citations are part of the snippet the tool already returns. */
export function toSearchResults(query: string, outcome: BackendOutcome, secret?: string): SearchResult[] {
  const citations = outcome.hits.map((hit) => hit.citation || hit.url)
  const rows: SearchResult[] = []
  const answer = outcome.answer ? redact(outcome.answer, secret).trim() : ''
  if (answer)
    rows.push({
      query,
      title: 'Answer',
      url: citations.find((url) => url.startsWith('http')) ?? '',
      snippet: `${answer}${citationBlock(citations)}`,
    })
  for (const hit of outcome.hits) {
    if (!hit.url.startsWith('http')) continue
    const snippet = redact(hit.snippet, secret).trim()
    rows.push({
      query,
      title: redact(hit.title || hit.url, secret),
      url: hit.url,
      snippet: `${snippet}${citationBlock([hit.citation || hit.url])}`,
    })
  }
  return rows
}
