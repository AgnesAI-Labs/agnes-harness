import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { queryBackend } from '../src/search/backends.js'
import { endpointError, parseStoredConfig, searchSecretRef } from '../src/search/contract.js'
import {
  createOfficialSearchProvider,
  createSearchAdmin,
  type SearchCredentialPort,
} from '../src/search/index.js'
import { searchConfigPath } from '../src/search/store.js'
import { createWebSearchTool } from '../src/search.js'

const KEY = 'brave-test-key-value'

function credentials(): SearchCredentialPort & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    async read(ref) {
      return values.get(ref)
    },
    async write(ref, value) {
      values.set(ref, value)
    },
    async remove(ref) {
      values.delete(ref)
    },
  }
}

function jsonFetch(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    if (status >= 400) return new Response(JSON.stringify({ error: KEY }), { status })
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  }
  return { calls, fetchImpl }
}

describe('official search providers', () => {
  it('refuses keyed providers on insecure or credential-bearing endpoints and allows loopback SearXNG', () => {
    expect(endpointError('brave', 'http://api.search.brave.com')).toBe('endpoint')
    expect(endpointError('brave', 'https://user:secret@api.search.brave.com')).toBe('endpoint')
    expect(endpointError('exa', 'https://api.exa.ai/?key=secret')).toBe('endpoint')
    expect(endpointError('searxng', 'http://127.0.0.1:8080')).toBeUndefined()
    expect(endpointError('searxng', 'http://[::1]:8080')).toBeUndefined()
    expect(endpointError('brave', 'https://api.search.brave.com/v1')).toBe('endpoint')
    expect(endpointError('searxng', 'http://example.com')).toBe('endpoint')
  })

  it('normalizes Brave, Tavily, Exa, Perplexity and SearXNG responses with citations', async () => {
    const cases = [
      {
        id: 'brave' as const,
        endpoint: 'https://api.search.brave.com',
        payload: {
          web: {
            results: [{ title: 'Brave title', url: 'https://example.com/b', description: 'brave snippet' }],
          },
        },
        url: 'https://api.search.brave.com/res/v1/web/search?q=agnes&count=5',
        header: 'x-subscription-token',
      },
      {
        id: 'tavily' as const,
        endpoint: 'https://api.tavily.com',
        payload: {
          answer: 'tavily answer',
          results: [{ title: 'T', url: 'https://example.com/t', content: 'tavily snippet' }],
        },
        url: 'https://api.tavily.com/search',
        header: 'authorization',
      },
      {
        id: 'exa' as const,
        endpoint: 'https://api.exa.ai',
        payload: { results: [{ title: 'Exa', url: 'https://example.com/e', highlights: ['exa snippet'] }] },
        url: 'https://api.exa.ai/search',
        header: 'authorization',
      },
      {
        id: 'perplexity' as const,
        endpoint: 'https://api.perplexity.ai',
        payload: {
          choices: [{ message: { content: 'perplexity answer' } }],
          citations: ['https://example.com/p'],
        },
        url: 'https://api.perplexity.ai/chat/completions',
        header: 'authorization',
      },
      {
        id: 'searxng' as const,
        endpoint: 'http://127.0.0.1:8888',
        payload: { results: [{ title: 'Searx', url: 'https://example.com/s', content: 'searx snippet' }] },
        url: 'http://127.0.0.1:8888/search?q=agnes&format=json&categories=general',
        header: 'accept',
      },
    ]
    for (const item of cases) {
      const { calls, fetchImpl } = jsonFetch(item.payload)
      const outcome = await queryBackend({
        id: item.id,
        query: 'agnes',
        endpoint: item.endpoint,
        ...(item.id === 'searxng' ? {} : { apiKey: KEY }),
        maxResults: 5,
        caller: new AbortController().signal,
        timed: new AbortController().signal,
        fetchImpl,
      })
      const request = calls[0]
      expect(request?.url).toBe(item.url)
      expect(`${request?.url} ${String(request?.init?.body ?? '')}`).not.toContain(KEY)
      const headers = new Headers(request?.init?.headers)
      if (item.id !== 'searxng')
        expect(headers.get(item.header)).toContain(item.id === 'brave' ? KEY : `Bearer ${KEY}`)
      expect(JSON.stringify(outcome)).toContain('https://example.com/')
      expect(JSON.stringify(outcome)).not.toContain(KEY)
    }
  })

  it('keeps API keys in the credential store and reports an unconfigured default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-search-'))
    const store = credentials()
    const admin = createSearchAdmin({ dataDir: dir, credentials: store, fetchImpl: jsonFetch({}).fetchImpl })
    const empty = await admin.handle('GET', 'search', undefined)
    expect(empty.body).toMatchObject({ configured: false, defaultProvider: null })
    expect(JSON.stringify(empty.body)).not.toContain(KEY)
    const saved = await admin.handle('PUT', 'search', {
      defaultProvider: 'brave',
      apiKey: KEY,
      provider: {
        id: 'brave',
        enabled: true,
        endpoint: 'https://api.search.brave.com',
        maxResults: 5,
        timeoutMs: 15000,
        ratePerMinute: 30,
      },
    })
    expect(saved.status).toBe(200)
    expect(JSON.stringify(saved.body)).not.toContain(KEY)
    expect(saved.body).toMatchObject({
      configured: true,
      defaultProvider: 'brave',
      verifiedProvider: 'brave',
    })
    expect(store.values.get(searchSecretRef('brave'))).toBe(KEY)
    const file = readFileSync(searchConfigPath(dir), 'utf8')
    expect(file).not.toContain(KEY)
    expect(() => parseStoredConfig({ version: 1, providers: [], apiKey: KEY })).toThrow(/not valid/)
    const { calls, fetchImpl } = jsonFetch({
      web: { results: [{ title: 'Title', url: 'https://example.com/a', description: 'snippet' }] },
    })
    const provider = createOfficialSearchProvider({
      dataDir: dir,
      fetchImpl,
      resolveSecret: (ref) => store.values.get(ref),
    })
    const tool = createWebSearchTool(provider)
    const result = await tool.execute({ queries: ['agnes'] }, fakeToolContext())
    expect(result.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('Citations:\n- https://example.com/a'),
      }),
    ])
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(result.details).toEqual({ provider: 'brave' })
    expect(calls[0]?.url).not.toContain(KEY)
    const failed = jsonFetch({ error: KEY }, 401)
    const broken = createOfficialSearchProvider({
      dataDir: dir,
      fetchImpl: failed.fetchImpl,
      resolveSecret: (ref) => store.values.get(ref),
    })
    await expect(
      broken.search(['agnes'], { signal: new AbortController().signal, timeoutMs: 15000 }),
    ).rejects.toThrow(/HTTP 401/)
    const failure = await createWebSearchTool(broken).execute({ queries: ['agnes'] }, fakeToolContext())
    expect(JSON.stringify(failure)).toContain('WEB_SEARCH_AUTH_FAILED')
    expect(JSON.stringify(failure)).not.toContain(KEY)
  })

  it('limits the request rate and reports timeouts without a configured provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-search-limit-'))
    const store = credentials()
    const admin = createSearchAdmin({
      dataDir: dir,
      credentials: store,
      fetchImpl: jsonFetch({ results: [] }).fetchImpl,
      now: () => 1_000,
    })
    await admin.handle('PUT', 'search', {
      defaultProvider: 'searxng',
      provider: {
        id: 'searxng',
        enabled: true,
        endpoint: 'http://127.0.0.1:8080',
        maxResults: 1,
        timeoutMs: 1000,
        ratePerMinute: 2,
      },
    })
    const { fetchImpl } = jsonFetch({ results: [] })
    const provider = createOfficialSearchProvider({
      dataDir: dir,
      fetchImpl,
      now: () => 1_000,
      resolveSecret: () => undefined,
    })
    await provider.search(['one'], { signal: new AbortController().signal, timeoutMs: 1000 })
    const limited = await createWebSearchTool(provider).execute({ queries: ['two'] }, fakeToolContext())
    expect(limited.details).toEqual({ code: 'SEARCH_RATE_LIMITED' })
    expect(limited.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('WEB_SEARCH_RATE_LIMITED') }),
    ])
    const timed = createOfficialSearchProvider({
      dataDir: dir,
      fetchImpl,
      now: () => 120_000,
      timeoutSignal: () => AbortSignal.abort(),
      resolveSecret: () => undefined,
    })
    const timedOut = await createWebSearchTool(timed).execute({ queries: ['three'] }, fakeToolContext())
    expect(timedOut.details).toEqual({ code: 'SEARCH_TIMEOUT' })
    expect(timedOut.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('WEB_SEARCH_TIMEOUT') }),
    ])
    const missing = createOfficialSearchProvider({
      dataDir: mkdtempSync(join(tmpdir(), 'agh-search-empty-')),
      resolveSecret: () => undefined,
    })
    const unavailable = await createWebSearchTool(missing).execute({ queries: ['a'] }, fakeToolContext())
    expect(unavailable.details).toEqual({ code: 'WEB_SEARCH_UNAVAILABLE' })
  })

  it('shares one rate window between admin tests and tool calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-search-shared-'))
    const store = credentials()
    const { fetchImpl } = jsonFetch({ results: [] })
    const saved = {
      defaultProvider: 'searxng' as const,
      provider: {
        id: 'searxng' as const,
        enabled: true,
        endpoint: 'http://127.0.0.1:8080',
        maxResults: 1,
        timeoutMs: 1000,
        ratePerMinute: 2,
      },
    }
    const admin = createSearchAdmin({ dataDir: dir, credentials: store, fetchImpl, now: () => 5_000 })
    await admin.handle('PUT', 'search', saved)
    const tested = await admin.handle('POST', 'search/test', { provider: 'searxng', query: 'one' })
    expect(tested.body).toMatchObject({ ok: true, provider: 'searxng' })
    const provider = createOfficialSearchProvider({
      dataDir: dir,
      fetchImpl,
      now: () => 5_000,
      resolveSecret: () => undefined,
    })
    const limited = await createWebSearchTool(provider).execute({ queries: ['two'] }, fakeToolContext())
    expect(limited.details).toEqual({ code: 'SEARCH_RATE_LIMITED' })
    const laterAdmin = createSearchAdmin({
      dataDir: dir,
      credentials: store,
      fetchImpl,
      now: () => 90_000,
    })
    const again = await laterAdmin.handle('POST', 'search/test', { provider: 'searxng', query: 'three' })
    expect(again.body).toMatchObject({ ok: true, provider: 'searxng' })
    const laterTool = await createWebSearchTool(
      createOfficialSearchProvider({
        dataDir: dir,
        fetchImpl,
        now: () => 90_000,
        resolveSecret: () => undefined,
      }),
    ).execute({ queries: ['four', 'five'] }, fakeToolContext())
    expect(laterTool.details).toEqual({ code: 'SEARCH_RATE_LIMITED' })
  })

  it.each([
    [401, 'SEARCH_AUTH_FAILED'],
    [402, 'SEARCH_PAYMENT_REQUIRED'],
    [403, 'SEARCH_ACCESS_DENIED'],
    [429, 'SEARCH_RATE_LIMITED'],
    [500, 'SEARCH_FAILED'],
    ['network', 'SEARCH_NETWORK_FAILED'],
    ['timeout', 'SEARCH_TIMEOUT'],
  ])(
    'rejects an unverified edit for %s without replacing working configuration or credentials',
    async (failure, code) => {
      const dir = mkdtempSync(join(tmpdir(), 'agh-search-verify-'))
      const store = credentials()
      let reject = false
      const admin = createSearchAdmin({
        dataDir: dir,
        credentials: store,
        fetchImpl: async () => {
          if (!reject) return Response.json({ results: [] })
          if (failure === 'network') throw new Error(`private upstream ${KEY}`)
          if (failure === 'timeout') throw new DOMException(KEY, 'TimeoutError')
          return Response.json({ message: KEY }, { status: Number(failure) })
        },
      })
      const original = {
        defaultProvider: 'exa',
        provider: { id: 'exa', enabled: true, maxResults: 5 },
        apiKey: KEY,
      }
      expect((await admin.handle('PUT', 'search', original)).status).toBe(200)
      const before = readFileSync(searchConfigPath(dir), 'utf8')
      reject = true
      const refused = await admin.handle('PUT', 'search', {
        ...original,
        provider: { ...original.provider, maxResults: 3 },
        apiKey: 'replacement-test-key',
      })
      expect(refused).toMatchObject({ status: 422, body: { ok: false, code } })
      expect(JSON.stringify(refused)).not.toContain(KEY)
      expect(store.values.get(searchSecretRef('exa'))).toBe(KEY)
      expect(readFileSync(searchConfigPath(dir), 'utf8')).toBe(before)
      const probe = await admin.handle('POST', 'search/test', { provider: 'exa', query: 'test' })
      expect(probe.body).toMatchObject({ ok: false, code })
      expect(JSON.stringify(probe)).not.toContain(KEY)
      expect(
        (
          await admin.handle('PUT', 'search', {
            defaultProvider: null,
            provider: { ...original.provider, enabled: false },
          })
        ).status,
      ).toBe(200)
      expect(
        (
          await admin.handle('PUT', 'search', {
            defaultProvider: null,
            provider: { ...original.provider, enabled: false },
            apiKey: '',
          })
        ).status,
      ).toBe(200)
      expect(store.values.has(searchSecretRef('exa'))).toBe(false)
    },
  )

  it('reports the backend actually used by each search after the saved default changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-search-identity-'))
    const store = credentials()
    const { fetchImpl } = jsonFetch({
      web: { results: [{ title: 'B', url: 'https://example.com/b', description: 'B' }] },
      results: [{ title: 'E', url: 'https://example.com/e', highlights: ['E'] }],
    })
    const admin = createSearchAdmin({ dataDir: dir, credentials: store, fetchImpl })
    const tool = createWebSearchTool(
      createOfficialSearchProvider({
        dataDir: dir,
        fetchImpl,
        resolveSecret: (ref) => store.values.get(ref),
      }),
    )
    for (const id of ['brave', 'exa'] as const) {
      expect(
        (
          await admin.handle('PUT', 'search', {
            defaultProvider: id,
            provider: { id, enabled: true },
            apiKey: KEY,
          })
        ).status,
      ).toBe(200)
      const result = await tool.execute({ queries: ['a'] }, fakeToolContext())
      expect(result.details).toEqual({ provider: id })
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining(`Search service: ${id}`) })
      expect(JSON.stringify(result)).not.toContain(KEY)
    }
  })
})
