import { expect, it } from 'vitest'
import { fetchProviderModels } from '../src/adapters/pi/probe-models.js'

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
    expect(String(url)).toBe('https://relay.invalid/v1/models')
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
