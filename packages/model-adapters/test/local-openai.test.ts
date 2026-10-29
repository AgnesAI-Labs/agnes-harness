import { expect, it } from 'vitest'
import { discoverLocalModels, localOpenAIAdapter } from '../src/index.js'

it('discovers local ids without Authorization, normalizes /v1, and refuses redirects and invalid catalogs', async () => {
  let seen: { url: string; init?: RequestInit } | undefined
  const request: typeof fetch = async (url, init) => {
    seen = { url: String(url), ...(init ? { init } : {}) }
    return Response.json({ data: [{ id: 'qwen2.5:7b' }] })
  }
  expect(await discoverLocalModels({ baseUrl: 'http://127.0.0.1:11434', request })).toEqual(['qwen2.5:7b'])
  expect(seen).toMatchObject({
    url: 'http://127.0.0.1:11434/v1/models',
    init: { redirect: 'error', headers: { Accept: 'application/json' } },
  })
  expect(seen?.init?.headers).not.toHaveProperty('Authorization')
  await expect(
    discoverLocalModels({ baseUrl: 'http://user:password@localhost/v1', request }),
  ).rejects.toThrow('endpoint')
  await expect(
    discoverLocalModels({
      baseUrl: 'http://localhost/v1',
      request: async () => Response.json({ data: [{ id: 'same' }, { id: 'same' }] }),
    }),
  ).rejects.toThrow('duplicate')
})
it('requires explicit keyless discovery and configured capacities without contacting a fallback', async () => {
  const base = { route: 'local', api: 'local-openai', baseUrl: 'http://127.0.0.1:11434/v1', models: [] }
  await expect(
    localOpenAIAdapter.create({ routes: [{ ...base, compat: { discover: true } }] }),
  ).rejects.toThrow('explicit keyless')
  await expect(
    localOpenAIAdapter.create({
      routes: [{ ...base, credentialRef: 'local-key', compat: { keyless: true } }],
    }),
  ).rejects.toThrow('cannot name a credential')
  await expect(
    localOpenAIAdapter.create({ routes: [{ ...base, compat: { keyless: true, discover: true } }] }),
  ).rejects.toThrow('modelDefaults')
})
