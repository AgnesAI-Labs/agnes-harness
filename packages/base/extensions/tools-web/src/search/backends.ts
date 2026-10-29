import {
  type BackendOutcome,
  redact,
  type SearchHit,
  SearchProviderError,
  type SearchProviderId,
} from './contract.js'
import { type FetchLike, requestJson } from './http.js'

export type BackendQuery = {
  id: SearchProviderId
  query: string
  endpoint: string
  apiKey?: string
  maxResults: number
  caller: AbortSignal
  timed: AbortSignal
  fetchImpl: FetchLike
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, secret?: string): string {
  return typeof value === 'string' ? redact(value, secret).trim() : ''
}

function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function hit(title: string, url: string, snippet: string, secret?: string): SearchHit | undefined {
  const cleanUrl = text(url, secret)
  if (!cleanUrl.startsWith('http')) return undefined
  return {
    title: text(title, secret) || cleanUrl,
    url: cleanUrl,
    snippet: text(snippet, secret),
    citation: cleanUrl,
  }
}

function headers(apiKey: string | undefined, name: 'authorization' | 'subscription'): HeadersInit {
  const base = { accept: 'application/json' }
  if (!apiKey) return base
  return name === 'subscription'
    ? { ...base, 'x-subscription-token': apiKey }
    : { ...base, authorization: `Bearer ${apiKey}` }
}

function brave(payload: unknown, secret?: string): BackendOutcome {
  const web = isRecord(payload) && isRecord(payload.web) ? payload.web : {}
  const hits = rows(web.results)
    .map((row) =>
      isRecord(row) ? hit(text(row.title), text(row.url), text(row.description), secret) : undefined,
    )
    .filter((row): row is SearchHit => row !== undefined)
  return { hits }
}

function tavily(payload: unknown, secret?: string): BackendOutcome {
  const body = isRecord(payload) ? payload : {}
  const hits = rows(body.results)
    .map((row) =>
      isRecord(row) ? hit(text(row.title), text(row.url), text(row.content), secret) : undefined,
    )
    .filter((row): row is SearchHit => row !== undefined)
  const answer = text(body.answer, secret)
  return { ...(answer ? { answer } : {}), hits }
}

function exa(payload: unknown, secret?: string): BackendOutcome {
  const body = isRecord(payload) ? payload : {}
  const hits = rows(body.results)
    .map((row) => {
      if (!isRecord(row)) return undefined
      const highlights = rows(row.highlights)
        .map((item) => text(item, secret))
        .filter(Boolean)
      const snippet = highlights[0]
      if (!snippet) return undefined
      return hit(text(row.title), text(row.url), snippet, secret)
    })
    .filter((row): row is SearchHit => row !== undefined)
  return { hits }
}

function perplexity(payload: unknown, secret?: string): BackendOutcome {
  const body = isRecord(payload) ? payload : {}
  const choices = rows(body.choices)
  const first = choices.find(isRecord)
  const message = first && isRecord(first.message) ? first.message : undefined
  const answer = text(message?.content, secret)
  const structured = body.search_results
  const hits =
    structured !== undefined
      ? rows(structured)
          .map((row) =>
            isRecord(row) ? hit(text(row.title), text(row.url), text(row.snippet), secret) : undefined,
          )
          .filter((row): row is SearchHit => row !== undefined)
      : rows(body.citations)
          .map((url) => hit(text(url), text(url), '', secret))
          .filter((row): row is SearchHit => row !== undefined)
  return { ...(answer ? { answer } : {}), hits }
}

function searxng(payload: unknown, secret?: string): BackendOutcome {
  const body = isRecord(payload) ? payload : {}
  const hits = rows(body.results)
    .map((row) =>
      isRecord(row) ? hit(text(row.title), text(row.url), text(row.content), secret) : undefined,
    )
    .filter((row): row is SearchHit => row !== undefined)
  const answer = rows(body.answers)
    .map((item) => text(item, secret))
    .find(Boolean)
  return { ...(answer ? { answer } : {}), hits }
}

const MAPPERS: Record<SearchProviderId, (payload: unknown, secret?: string) => BackendOutcome> = {
  brave,
  tavily,
  exa,
  perplexity,
  searxng,
}

export async function queryBackend(input: BackendQuery): Promise<BackendOutcome> {
  const secret = input.apiKey
  const limit = input.maxResults
  let url = ''
  let init: RequestInit
  if (input.id === 'brave') {
    const target = new URL('/res/v1/web/search', `${input.endpoint}/`)
    target.searchParams.set('q', input.query)
    target.searchParams.set('count', String(limit))
    url = target.toString()
    init = { method: 'GET', headers: headers(secret, 'subscription') }
  } else if (input.id === 'searxng') {
    const target = new URL('/search', `${input.endpoint}/`)
    target.searchParams.set('q', input.query)
    target.searchParams.set('format', 'json')
    target.searchParams.set('categories', 'general')
    url = target.toString()
    init = { method: 'GET', headers: headers(secret, 'authorization') }
  } else if (input.id === 'tavily') {
    url = new URL('/search', `${input.endpoint}/`).toString()
    init = {
      method: 'POST',
      headers: { ...headers(secret, 'authorization'), 'content-type': 'application/json' },
      body: JSON.stringify({
        query: input.query,
        max_results: limit,
        include_answer: true,
        search_depth: 'basic',
      }),
    }
  } else if (input.id === 'exa') {
    url = new URL('/search', `${input.endpoint}/`).toString()
    init = {
      method: 'POST',
      headers: { ...headers(secret, 'authorization'), 'content-type': 'application/json' },
      body: JSON.stringify({
        query: input.query,
        type: 'auto',
        numResults: limit,
        contents: { highlights: { highlightsPerUrl: 1 } },
      }),
    }
  } else {
    url = new URL('/chat/completions', `${input.endpoint}/`).toString()
    init = {
      method: 'POST',
      headers: { ...headers(secret, 'authorization'), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'sonar',
        max_tokens: 1024,
        messages: [{ role: 'user', content: input.query }],
      }),
    }
  }
  if (secret && url.includes(secret))
    throw new SearchProviderError('SEARCH_FAILED', 'The search provider request failed.')
  const payload = await requestJson(input.fetchImpl, url, init, input.caller, input.timed)
  const outcome = MAPPERS[input.id](payload, secret)
  return { ...outcome, hits: outcome.hits.slice(0, limit) }
}
