import { describe, expect, it, vi } from 'vitest'
import { ApiKeyProviderError, getApiKeyProvider } from '../src/index.js'

const key = 'direct-key-marker'
const catalogue = {
  object: 'list',
  data: [{ id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' }],
}

describe('DeepSeek API-key model catalogue', () => {
  it('uses only the pinned /models URL and explicit Bearer credential', async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(catalogue), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const entry = getApiKeyProvider('deepseek')
    expect(entry?.modelsUrl).toBe('https://api.deepseek.com/models')
    const models = await entry?.fetchModels?.({
      credential: key,
      signal: new AbortController().signal,
      request,
    })
    expect(models).toEqual(['deepseek-v4-pro'])
    expect(request).toHaveBeenCalledTimes(1)
    const [input, init] = request.mock.calls[0] ?? []
    expect(String(input)).toBe('https://api.deepseek.com/models')
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
    })
  })

  it.each([
    ['wrong envelope object', { ...catalogue, object: 'models' }],
    ['unknown top-level field', { ...catalogue, baseUrl: 'https://evil.invalid' }],
    ['wrong item object', { object: 'list', data: [{ ...catalogue.data[0], object: 'account' }] }],
    [
      'unknown item field',
      { object: 'list', data: [{ ...catalogue.data[0], endpoint: 'https://evil.invalid' }] },
    ],
    ['unsafe id', { object: 'list', data: [{ ...catalogue.data[0], id: 'bad\nmodel' }] }],
    ['duplicate id', { object: 'list', data: [catalogue.data[0], catalogue.data[0]] }],
  ])('rejects %s without accepting remote routing metadata', async (_name, body) => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const entry = getApiKeyProvider('deepseek')
    await expect(
      entry?.fetchModels?.({ credential: key, signal: new AbortController().signal, request }),
    ).rejects.toMatchObject({ code: 'CATALOG_INVALID' })
  })

  it('never forwards a reflected key or raw response body in an error', async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            object: 'list',
            data: [{ id: `deepseek-${key}`, object: 'model', owned_by: 'deepseek' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const entry = getApiKeyProvider('deepseek')
    let failure: unknown
    try {
      await entry?.fetchModels?.({ credential: key, signal: new AbortController().signal, request })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ApiKeyProviderError)
    expect(JSON.stringify(failure)).not.toContain(key)
    expect(String(failure)).not.toContain(key)
  })

  it('rejects an oversized declared body before parsing it', async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(catalogue), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(1024 * 1024 + 1),
          },
        }),
    )
    const entry = getApiKeyProvider('deepseek')
    await expect(
      entry?.fetchModels?.({ credential: key, signal: new AbortController().signal, request }),
    ).rejects.toMatchObject({ code: 'CATALOG_INVALID' })
  })

  it('drops an unauthorized response body and exposes only safe status metadata', async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(`rejected ${key}`, { status: 401 }),
    )
    const entry = getApiKeyProvider('deepseek')
    let failure: unknown
    try {
      await entry?.fetchModels?.({ credential: key, signal: new AbortController().signal, request })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'CATALOG_UNAVAILABLE', status: 401 })
    expect(JSON.stringify(failure)).not.toContain(key)
    expect(String(failure)).not.toContain(key)
  })

  it('does not pretend static-only provider catalogues were remotely verified', () => {
    expect(getApiKeyProvider('openai')?.fetchModels).toBeUndefined()
    expect(getApiKeyProvider('anthropic')?.fetchModels).toBeUndefined()
  })
})
