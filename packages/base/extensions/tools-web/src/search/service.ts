import type { SearchProvider, SearchResult } from '@agnes/extension-api'
import { queryBackend } from './backends.js'
import {
  isSearchProviderId,
  parseStoredProvider,
  providerReady,
  resolveProvider,
  SEARCH_PROVIDER_IDS,
  SearchProviderError,
  type SearchProviderId,
  type StoredProvider,
  type StoredSearchConfig,
  searchSecretRef,
  toSearchResults,
} from './contract.js'
import type { FetchLike } from './http.js'
import { readSearchConfig, writeSearchConfig } from './store.js'

export type SearchCredentialPort = {
  read(ref: string): Promise<string | undefined>
  write(ref: string, value: string): Promise<void>
  remove(ref: string): Promise<void>
}

export type SearchRuntimeOptions = {
  dataDir: string
  fetchImpl?: FetchLike
  now?: () => number
  timeoutSignal?: (ms: number) => AbortSignal
}

type Runtime = SearchRuntimeOptions & {
  take(id: SearchProviderId, limit: number, count: number): boolean
}

const KEY_VALUE = /^[^\p{Cc}]{1,4096}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function createRuntime(options: SearchRuntimeOptions): Runtime {
  const windows = new Map<SearchProviderId, number[]>()
  return {
    ...options,
    take(id, limit, count) {
      const now = options.now?.() ?? Date.now()
      const window = (windows.get(id) ?? []).filter((at) => now - at < 60_000)
      if (window.length + count > limit) {
        windows.set(id, window)
        return false
      }
      for (let index = 0; index < count; index += 1) window.push(now)
      windows.set(id, window)
      return true
    },
  }
}

async function runQueries(
  runtime: Runtime,
  providerId: SearchProviderId,
  queries: readonly string[],
  signal: AbortSignal,
  timeoutMs: number,
  apiKey: string | undefined,
  config: StoredSearchConfig,
): Promise<SearchResult[]> {
  const provider = resolveProvider(config, providerId)
  const budget = Math.min(provider.timeoutMs, timeoutMs)
  if (!runtime.take(provider.id, provider.ratePerMinute, queries.length))
    throw new SearchProviderError('SEARCH_RATE_LIMITED', 'The search provider rate limit was reached.')
  const fetchImpl = runtime.fetchImpl ?? fetch
  const timeoutSignal = runtime.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms))
  const batches = await Promise.all(
    queries.map(async (query) => {
      const outcome = await queryBackend({
        id: provider.id,
        query,
        endpoint: provider.endpoint,
        ...(apiKey ? { apiKey } : {}),
        maxResults: provider.maxResults,
        caller: signal,
        timed: timeoutSignal(budget),
        fetchImpl,
      })
      return toSearchResults(query, outcome, apiKey)
    }),
  )
  return batches.flat()
}

function readSecret(resolveSecret: (ref: string) => string | undefined, ref: string): string | undefined {
  try {
    const value = resolveSecret(ref)
    return value && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

export function createOfficialSearchProvider(
  options: SearchRuntimeOptions & { resolveSecret(ref: string): string | undefined },
): SearchProvider {
  const runtime = createRuntime(options)
  return {
    async search(queries, request) {
      const loaded = readSearchConfig(options.dataDir)
      const selected = loaded.config.defaultProvider
      if (loaded.invalid || !selected)
        throw new SearchProviderError('SEARCH_NOT_CONFIGURED', 'No search provider is configured.')
      const provider = resolveProvider(loaded.config, selected)
      const secret = readSecret(options.resolveSecret, provider.secretRef)
      if (!providerReady(provider, provider.needsKey ? Boolean(secret) : true))
        throw new SearchProviderError('SEARCH_NOT_CONFIGURED', 'No search provider is configured.')
      return runQueries(
        runtime,
        provider.id,
        queries,
        request.signal,
        request.timeoutMs,
        secret,
        loaded.config,
      )
    },
  }
}

export type SearchProviderStatus = {
  id: SearchProviderId
  label: string
  needsKey: boolean
  enabled: boolean
  endpoint: string
  maxResults: number
  timeoutMs: number
  ratePerMinute: number
  secretRef: string
  secretConfigured: boolean
  isDefault: boolean
  ready: boolean
}

export type SearchStatus = {
  version: 1
  configured: boolean
  invalid: boolean
  defaultProvider: SearchProviderId | null
  providers: SearchProviderStatus[]
}

export type SearchAdmin = {
  handle(method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }>
}

function invalid(message = 'Search settings are not valid.'): { status: number; body: unknown } {
  return { status: 400, body: { ok: false, code: 'SEARCH_INVALID', message } }
}

async function storedSecret(credentials: SearchCredentialPort, ref: string): Promise<boolean> {
  try {
    return Boolean(await credentials.read(ref))
  } catch {
    return false
  }
}

async function describe(
  credentials: SearchCredentialPort,
  loaded: { config: StoredSearchConfig; invalid: boolean },
): Promise<SearchStatus> {
  const providers = await Promise.all(
    SEARCH_PROVIDER_IDS.map(async (id) => {
      const provider = resolveProvider(loaded.config, id)
      const secretConfigured = await storedSecret(credentials, provider.secretRef)
      const ready = providerReady(provider, provider.needsKey ? secretConfigured : true)
      return {
        id,
        label: provider.label,
        needsKey: provider.needsKey,
        enabled: provider.enabled,
        endpoint: provider.endpoint,
        maxResults: provider.maxResults,
        timeoutMs: provider.timeoutMs,
        ratePerMinute: provider.ratePerMinute,
        secretRef: provider.secretRef,
        secretConfigured,
        isDefault: loaded.config.defaultProvider === id,
        ready,
      }
    }),
  )
  const selected = providers.find((provider) => provider.isDefault && provider.ready)
  return {
    version: 1,
    configured: Boolean(selected),
    invalid: loaded.invalid,
    defaultProvider: selected?.id ?? null,
    providers,
  }
}

function readSaveBody(body: unknown): {
  defaultProvider: SearchProviderId | null
  provider: StoredProvider
  apiKey?: string
} {
  if (!isRecord(body)) throw new SearchProviderError('SEARCH_INVALID', 'Search settings are not valid.')
  const provider = parseStoredProvider(body.provider)
  if (
    body.defaultProvider !== null &&
    body.defaultProvider !== undefined &&
    !isSearchProviderId(body.defaultProvider)
  )
    throw new SearchProviderError('SEARCH_INVALID', 'Search settings are not valid.')
  if (
    body.apiKey !== undefined &&
    (typeof body.apiKey !== 'string' || (body.apiKey !== '' && !KEY_VALUE.test(body.apiKey)))
  )
    throw new SearchProviderError('SEARCH_INVALID', 'Search settings are not valid.')
  const allowed = new Set(['defaultProvider', 'provider', 'apiKey'])
  if (Object.keys(body).some((key) => !allowed.has(key)))
    throw new SearchProviderError('SEARCH_INVALID', 'Search settings are not valid.')
  return {
    defaultProvider: isSearchProviderId(body.defaultProvider) ? body.defaultProvider : null,
    provider,
    ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
  }
}

async function secretWillExist(
  credentials: SearchCredentialPort,
  id: SearchProviderId,
  edited: SearchProviderId,
  apiKey: string | undefined,
): Promise<boolean> {
  if (id === edited && apiKey === '') return false
  if (id === edited && apiKey) return true
  return storedSecret(credentials, searchSecretRef(id))
}

export function createSearchAdmin(
  options: SearchRuntimeOptions & { credentials: SearchCredentialPort },
): SearchAdmin {
  const runtime = createRuntime(options)
  return {
    async handle(method, path, body) {
      try {
        if (path === 'search' && method === 'GET')
          return { status: 200, body: await describe(options.credentials, readSearchConfig(options.dataDir)) }
        if (path === 'search' && method === 'PUT') return await save(options, body)
        if (path === 'search/test' && method === 'POST') return await testSaved(runtime, options, body)
        return {
          status: 404,
          body: { ok: false, code: 'SEARCH_ROUTE', message: 'Unknown search operation.' },
        }
      } catch (error) {
        if (error instanceof SearchProviderError && error.code === 'SEARCH_INVALID')
          return invalid(error.message)
        return invalid()
      }
    },
  }
}

async function save(
  options: SearchRuntimeOptions & { credentials: SearchCredentialPort },
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const input = readSaveBody(body)
  const loaded = readSearchConfig(options.dataDir)
  const providers = (loaded.invalid ? [] : loaded.config.providers).filter(
    (provider) => provider.id !== input.provider.id,
  )
  providers.push(input.provider)
  const draft: StoredSearchConfig = {
    version: 1,
    ...(input.defaultProvider ? { defaultProvider: input.defaultProvider } : {}),
    providers,
  }
  if (input.defaultProvider) {
    const provider = resolveProvider(draft, input.defaultProvider)
    const secret = await secretWillExist(
      options.credentials,
      input.defaultProvider,
      input.provider.id,
      input.apiKey,
    )
    if (!providerReady(provider, secret))
      throw new SearchProviderError('SEARCH_INVALID', 'The default search provider is not ready.')
  }
  const secretRef = searchSecretRef(input.provider.id)
  try {
    if (input.apiKey === '') await options.credentials.remove(secretRef)
    else if (input.apiKey) await options.credentials.write(secretRef, input.apiKey)
  } catch {
    throw new SearchProviderError('SEARCH_INVALID', 'The search credential could not be stored.')
  }
  writeSearchConfig(options.dataDir, draft)
  return { status: 200, body: await describe(options.credentials, readSearchConfig(options.dataDir)) }
}

async function testSaved(
  runtime: Runtime,
  options: SearchRuntimeOptions & { credentials: SearchCredentialPort },
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  if (!isRecord(body) || !isSearchProviderId(body.provider) || typeof body.query !== 'string')
    return invalid()
  const query = body.query.trim()
  if (!query || query.length > 500 || Object.keys(body).length !== 2) return invalid()
  const loaded = readSearchConfig(options.dataDir)
  const provider = resolveProvider(loaded.config, body.provider)
  const secret = await options.credentials.read(provider.secretRef).catch(() => undefined)
  if (loaded.invalid || !providerReady(provider, provider.needsKey ? Boolean(secret) : true)) {
    return {
      status: 200,
      body: { ok: false, code: 'SEARCH_NOT_CONFIGURED', message: 'No search provider is configured.' },
    }
  }
  try {
    const results = await runQueries(
      runtime,
      provider.id,
      [query],
      new AbortController().signal,
      provider.timeoutMs,
      secret,
      loaded.config,
    )
    return {
      status: 200,
      body: {
        ok: true,
        provider: provider.id,
        results: results.slice(0, provider.maxResults).map((result) => ({
          query: result.query,
          title: result.title,
          url: result.url,
          snippet: result.snippet.slice(0, 1_000),
        })),
      },
    }
  } catch (error) {
    if (error instanceof SearchProviderError)
      return { status: 200, body: { ok: false, code: error.code, message: error.message } }
    return {
      status: 200,
      body: { ok: false, code: 'SEARCH_FAILED', message: 'The search provider request failed.' },
    }
  }
}
