import { expect, it } from 'vitest'
import { fetchProviderModels } from '../src/adapters/pi/probe-models.js'

it.each([
  [{ context_length: 1048576, limit: { context: 262144 } }, 1048576],
  [{ limit: { context: 1048576 } }, 1048576],
  [{ context_window: 262144 }, 262144],
  [{ context_length: -1, limit: { context: 1048576 } }, 1048576],
  [{ context_length: '1048576' }, undefined],
  [{ context_length: 0 }, undefined],
  [{ context_length: 1.5 }, undefined],
  [{ context_length: Number.MAX_SAFE_INTEGER + 1 }, undefined],
  [{ max_input_tokens: 200000 }, 200000],
  [{ context_length: 1048576, max_input_tokens: 200000 }, 1048576],
])('reads valid provider context limits from %j', async (metadata, capacity) => {
  const result = await fetchProviderModels({
    api: 'openai-completions',
    baseUrl: 'https://relay.invalid/v1',
    request: async () => Response.json({ data: [{ id: 'kimi-k3', ...metadata }] }),
  })
  expect(result).toEqual({
    ids: ['kimi-k3'],
    ...(capacity === undefined ? {} : { contextWindows: { 'kimi-k3': capacity } }),
  })
})

it('reads max_input_tokens and max_output_tokens', async () => {
  const result = await fetchProviderModels({
    api: 'openai-completions',
    baseUrl: 'https://relay.invalid/v1',
    request: async () =>
      Response.json({
        data: [
          { id: 'limited', max_input_tokens: 1000000, max_output_tokens: 256000 },
          { id: 'output-only', max_output_tokens: 32768 },
          { id: 'bad-zero', max_output_tokens: 0 },
          { id: 'bad-string', max_output_tokens: '8192' },
          { id: 'bad-fraction', max_output_tokens: 1.5 },
          { id: 'bad-big', max_output_tokens: Number.MAX_SAFE_INTEGER + 1 },
          { id: 'plain' },
        ],
      }),
  })
  expect(result).toEqual({
    ids: ['limited', 'output-only', 'bad-zero', 'bad-string', 'bad-fraction', 'bad-big', 'plain'],
    contextWindows: { limited: 1000000 },
    maxTokens: { limited: 256000, 'output-only': 32768 },
  })
})

it('asks for detail=true first and falls back to /models on 404', async () => {
  const urls: string[] = []
  const request: typeof fetch = async (url) => {
    urls.push(String(url))
    return String(url).includes('detail=true')
      ? new Response('nope', { status: 404 })
      : Response.json({ data: [{ id: 'plain-model' }] })
  }
  expect(
    await fetchProviderModels({ api: 'openai-completions', baseUrl: 'https://relay.invalid/v1', request }),
  ).toEqual({
    ids: ['plain-model'],
  })
  expect(urls).toEqual(['https://relay.invalid/v1/models?detail=true', 'https://relay.invalid/v1/models'])
  // A detail answer is used as is, with no second request.
  urls.length = 0
  const detailed: typeof fetch = async (url) => {
    urls.push(String(url))
    return Response.json({ data: [{ id: 'm', max_output_tokens: 4096 }] })
  }
  expect(
    await fetchProviderModels({
      api: 'openai-completions',
      baseUrl: 'https://relay.invalid/v1',
      request: detailed,
    }),
  ).toEqual({ ids: ['m'], maxTokens: { m: 4096 } })
  expect(urls).toEqual(['https://relay.invalid/v1/models?detail=true'])
  // Other protocols ask once, without the query.
  urls.length = 0
  await fetchProviderModels({
    api: 'openai-responses',
    baseUrl: 'https://relay.invalid/v1',
    request: detailed,
  })
  expect(urls).toEqual(['https://relay.invalid/v1/models'])
})

it('falls back to /models whenever the detail listing cannot be used', async () => {
  const options = { api: 'openai-completions', baseUrl: 'https://relay.invalid/v1' }
  const plain = () => Response.json({ data: [{ id: 'plain-model' }] })
  const via = (detail: () => Response, fallback: () => Response = plain): typeof fetch => {
    return async (url) => (String(url).includes('detail=true') ? detail() : fallback())
  }
  const html = () => new Response('<html>', { headers: { 'content-type': 'text/html' } })
  const huge = () =>
    new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })
  for (const detail of [html, huge, () => Response.json({ data: [] }), () => Response.json({ data: 'x' })])
    expect(await fetchProviderModels({ ...options, request: via(detail) })).toEqual({ ids: ['plain-model'] })
  // A refusal of the detail listing is not final; the plain listing's answer is.
  const refused = () => Response.json({ error: 'no' }, { status: 401 })
  expect(await fetchProviderModels({ ...options, credential: 'sk-relay', request: via(refused) })).toEqual({
    ids: ['plain-model'],
  })
  await expect(
    fetchProviderModels({ ...options, credential: 'sk-relay', request: via(refused, refused) }),
  ).rejects.toMatchObject({ status: 401 })
  // A deadline or abort is not retried.
  let calls = 0
  const late: typeof fetch = async () => {
    calls += 1
    throw new DOMException('late', 'TimeoutError')
  }
  expect(await fetchProviderModels({ ...options, request: late })).toEqual({ failure: { reason: 'timeout' } })
  expect(calls).toBe(1)
})

it('normalizes Gemini resource names and excludes credential-shaped model IDs', async () => {
  let body: unknown = { models: [{ name: 'models/gemini-test' }] }
  let status = 200
  const request: typeof fetch = async (url, options) => {
    expect(String(url)).toBe('https://example.invalid/v1beta/models?pageSize=1000')
    expect(options?.headers).toMatchObject({ 'x-goog-api-key': 'fixture-secret' })
    return Response.json(body, { status })
  }
  const options = {
    api: 'google-generative-ai',
    baseUrl: 'https://example.invalid/v1beta',
    credential: 'fixture-secret',
    request,
  }
  expect(await fetchProviderModels(options)).toEqual({ ids: ['gemini-test'] })
  body = { models: [{ name: 'models/fixture-secret' }] }
  expect(await fetchProviderModels(options)).toEqual({ failure: { reason: 'invalid' } })
  for (status of [401, 403]) {
    body = { error: 'reflected fixture-secret' }
    await expect(fetchProviderModels(options)).rejects.toMatchObject({
      code: 'CATALOG_UNAVAILABLE',
      status,
    })
    await expect(fetchProviderModels(options)).rejects.not.toThrow('fixture-secret')
  }
})

it('lists an OpenAI-compatible catalogue without a key and names why a listing failed', async () => {
  let respond: () => Response | Promise<Response> = () => Response.json({ data: [{ id: 'qwen-plus' }] })
  const seen: Headers[] = []
  const request: typeof fetch = async (url, options) => {
    // A refused detail request falls back to the plain listing, which carries the answer under test.
    expect(String(url)).toMatch(/^https:\/\/relay\.invalid\/v1\/models(\?detail=true)?$/)
    seen.push(new Headers(options?.headers))
    return respond()
  }
  const options = { api: 'openai-completions', baseUrl: 'https://relay.invalid/v1', request }
  expect(await fetchProviderModels(options)).toEqual({ ids: ['qwen-plus'] })
  expect(seen[0]?.has('authorization')).toBe(false)
  await fetchProviderModels({ ...options, credential: 'sk-relay' })
  expect(seen[1]?.get('authorization')).toBe('Bearer sk-relay')
  const cases: [() => Response | Promise<Response>, unknown][] = [
    [() => Response.json({ error: 'key required' }, { status: 401 }), { reason: 'http', status: 401 }],
    [() => Response.json({ error: 'key required' }, { status: 403 }), { reason: 'http', status: 403 }],
    [() => new Response('nope', { status: 404 }), { reason: 'http', status: 404 }],
    [
      () => new Response(null, { status: 302, headers: { location: '/v2' } }),
      { reason: 'redirect', status: 302 },
    ],
    [() => new Response('<html>', { headers: { 'content-type': 'text/html' } }), { reason: 'not-json' }],
    [() => new Response('{', { headers: { 'content-type': 'application/json' } }), { reason: 'not-json' }],
    [() => Response.json({ data: [] }), { reason: 'empty' }],
    [() => Response.json({ data: [{ id: 'a b' }] }), { reason: 'invalid' }],
    [() => Promise.reject(new TypeError('fetch failed')), { reason: 'network' }],
    [() => Promise.reject(new DOMException('late', 'TimeoutError')), { reason: 'timeout' }],
  ]
  for (const [next, failure] of cases) {
    respond = next
    expect(await fetchProviderModels(options)).toEqual({ failure })
  }
})

it.each([
  [{ input_modalities: ['text', 'image'] }, ['text', 'image']],
  [{ architecture: { input_modalities: ['image', 'text'] } }, ['image', 'text']],
  [{ input: ['text'] }, ['text']],
  [{}, undefined],
  [{ input_modalities: [] }, undefined],
  [{ input_modalities: 'image' }, undefined],
  [{ input_modalities: ['text', 'audio'] }, undefined],
  [{ input_modalities: ['image', 'image'] }, undefined],
])('reads only declared valid input types from %j', async (metadata, input) => {
  const result = await fetchProviderModels({
    api: 'openai-completions',
    baseUrl: 'https://relay.invalid/v1',
    request: async () => Response.json({ data: [{ id: 'custom', ...metadata }] }),
  })
  expect(result).toEqual({ ids: ['custom'], ...(input ? { inputs: { custom: input } } : {}) })
})
