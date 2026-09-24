import { expect, it } from 'vitest'
import { fetchProviderModels } from '../src/adapters/pi/probe-models.js'

it('normalizes Gemini resource names and excludes credential-shaped model IDs', async () => {
  let body: unknown = { models: [{ name: 'models/gemini-test' }] }
  const request: typeof fetch = async (url, options) => {
    expect(String(url)).toBe('https://example.invalid/v1beta/models?pageSize=1000')
    expect(options?.headers).toMatchObject({ 'x-goog-api-key': 'fixture-secret' })
    return Response.json(body)
  }
  const options = {
    api: 'google-generative-ai',
    baseUrl: 'https://example.invalid/v1beta',
    credential: 'fixture-secret',
    request,
  }
  expect(await fetchProviderModels(options)).toEqual({ ids: ['gemini-test'] })
  body = { models: [{ name: 'models/fixture-secret' }] }
  expect(await fetchProviderModels(options)).toBeUndefined()
})
