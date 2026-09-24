import { readFile } from 'node:fs/promises'
import type { CredentialWriter } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import {
  ApiKeyOnboardingError,
  type ApiKeyRequest,
  onboardDeepSeekApiKey,
  probeDeepSeekApiKey,
} from '../src/onboarding/api-key.js'
import {
  type AuthProfileOverlayStore,
  DEEPSEEK_API_BASE_URL,
  DEEPSEEK_API_CREDENTIAL_REF,
  DEEPSEEK_API_MODELS_URL,
  DEEPSEEK_API_ROUTE,
} from '../src/onboarding/profile-overlay.js'

const response = (status: number, body: unknown, headers?: Record<string, string>): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    ...(headers === undefined ? {} : { headers }),
  })

const successfulRequest = (ids = ['deepseek-flash', 'deepseek-v4-pro']): ApiKeyRequest =>
  vi.fn(async () => response(200, { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }))

function harness(
  over: {
    request?: ApiKeyRequest
    chooseModel?: (models: readonly { id: string }[], signal: AbortSignal) => Promise<string | null>
    write?: AuthProfileOverlayStore['write']
    verify?: AuthProfileOverlayStore['verify']
    removeOverlay?: AuthProfileOverlayStore['remove']
    putApiKey?: CredentialWriter['putApiKey']
    removeCredential?: CredentialWriter['remove']
    timeoutMs?: number
  } = {},
) {
  const credentials: CredentialWriter = {
    putApiKey: over.putApiKey ?? vi.fn(async () => {}),
    putOAuth: vi.fn(async () => {}),
    remove: over.removeCredential ?? vi.fn(async () => {}),
  }
  const overlays: AuthProfileOverlayStore = {
    write: over.write ?? vi.fn(async () => {}),
    verify: over.verify ?? vi.fn(async () => {}),
    remove: over.removeOverlay ?? vi.fn(async () => {}),
  }
  return {
    credentials,
    overlays,
    deps: {
      request: over.request ?? successfulRequest(),
      chooseModel:
        over.chooseModel ?? (async (models: readonly { id: string }[]) => models.at(-1)?.id ?? null),
      credentials,
      overlays,
      now: () => '2026-09-11T00:00:00.000Z',
      ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }),
    },
  }
}

describe('DeepSeek API-key discovery', () => {
  it('uses only the pinned /models endpoint with Bearer authentication and returns actual IDs', async () => {
    const key = 'test-api-key-497218'
    const request = successfulRequest(['deepseek-flash', 'deepseek-v4-pro'])
    const models = await probeDeepSeekApiKey(key, new AbortController().signal, { request })
    expect(models).toEqual([{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }])
    expect(request).toHaveBeenCalledOnce()
    const [url, init] = vi.mocked(request).mock.calls[0] as [URL, Parameters<ApiKeyRequest>[1]]
    expect(url.href).toBe(DEEPSEEK_API_MODELS_URL)
    expect(url.origin).toBe('https://api.deepseek.com')
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
    })
  })

  it('intersects the live catalogue with the reviewed text/tool model set', async () => {
    const request = successfulRequest([
      'deepseek-flash',
      'deepseek-v4-flash-vision-exp',
      'future-unreviewed-model',
    ])
    await expect(
      probeDeepSeekApiKey('test-api-key-reviewed-models', new AbortController().signal, { request }),
    ).resolves.toEqual([{ id: 'deepseek-flash' }])
  })

  it.each([
    [401, 'API_KEY_UNAUTHORIZED'],
    [403, 'API_KEY_FORBIDDEN'],
    [429, 'API_KEY_RATE_LIMITED'],
    [500, 'CATALOG_UNAVAILABLE'],
  ] as const)('classifies HTTP %i without exposing response content', async (status, code) => {
    const key = 'test-key-http-sentinel'
    const rawBody = `server echoed ${key}`
    const request = vi.fn(async () => response(status, rawBody, { 'retry-after': '7' }))
    let caught: unknown
    try {
      await probeDeepSeekApiKey(key, new AbortController().signal, { request })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ApiKeyOnboardingError)
    expect(caught).toMatchObject({ code, status })
    if (status === 429) expect(caught).toMatchObject({ retryAfterMs: 7_000 })
    expect(JSON.stringify(caught)).not.toContain(key)
    expect(String(caught)).not.toContain(rawBody)
  })

  it('rejects malformed, empty, control-bearing and key-reflecting catalogues', async () => {
    const key = 'test-key-catalog-sentinel'
    for (const body of [
      'not-json',
      { object: 'list', data: [] },
      { data: [{ id: 'bad\u001bmodel' }] },
      { data: [{ id: key }] },
    ]) {
      const request = vi.fn(async () => response(200, body))
      await expect(probeDeepSeekApiKey(key, new AbortController().signal, { request })).rejects.toMatchObject(
        {
          code: 'CATALOG_UNAVAILABLE',
        },
      )
    }
  })

  it('classifies timeout, while an outer abort remains owned by the caller', async () => {
    const waitsForAbort: ApiKeyRequest = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
    await expect(
      probeDeepSeekApiKey('test-key-timeout', new AbortController().signal, {
        request: waitsForAbort,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE', reason: 'timeout' })

    const ac = new AbortController()
    const pending = probeDeepSeekApiKey('test-key-abort', ac.signal, { request: waitsForAbort })
    ac.abort(new Error('outer abort'))
    await expect(pending).rejects.toThrow('outer abort')
  })
})

describe('DeepSeek API-key onboarding transaction', () => {
  it('does not write before probe and selection, then writes key and secret-free verified overlay', async () => {
    const key = 'test-key-write-sentinel'
    let finish: ((value: Response) => void) | undefined
    const request: ApiKeyRequest = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    const chooseModel = vi.fn(async () => 'deepseek-v4-pro')
    const h = harness({ request, chooseModel })
    const pending = onboardDeepSeekApiKey(
      { key, profile: 'local-dev', signal: new AbortController().signal },
      h.deps,
    )
    expect(h.credentials.putApiKey).not.toHaveBeenCalled()
    expect(h.overlays.write).not.toHaveBeenCalled()
    finish?.(response(200, { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }))

    await expect(pending).resolves.toEqual({
      profile: 'local-dev',
      route: DEEPSEEK_API_ROUTE,
      model: 'deepseek-v4-pro',
      thinking: 'high',
      credentialRef: DEEPSEEK_API_CREDENTIAL_REF,
    })
    expect(chooseModel).toHaveBeenCalledWith(
      [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
      expect.any(AbortSignal),
    )
    expect(h.credentials.putApiKey).toHaveBeenCalledExactlyOnceWith(DEEPSEEK_API_CREDENTIAL_REF, key)
    expect(h.overlays.write).toHaveBeenCalledOnce()
    expect(h.overlays.verify).toHaveBeenCalledOnce()
    const overlay = vi.mocked(h.overlays.write).mock.calls[0]?.[0]
    expect(overlay?.route.baseUrl).toBe(DEEPSEEK_API_BASE_URL)
    expect(overlay?.route.credentialRef).toBe(DEEPSEEK_API_CREDENTIAL_REF)
    expect(JSON.stringify(overlay)).not.toContain(key)
  })

  it('rejects a model not present in the dynamic catalogue without writing', async () => {
    const h = harness({ chooseModel: async () => 'invented-model' })
    await expect(
      onboardDeepSeekApiKey(
        { key: 'test-key-model', profile: 'local-dev', signal: new AbortController().signal },
        h.deps,
      ),
    ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
    expect(h.credentials.putApiKey).not.toHaveBeenCalled()
    expect(h.overlays.write).not.toHaveBeenCalled()
  })

  it('rolls back both credential and overlay when write verification fails', async () => {
    const key = 'test-key-rollback-sentinel'
    const h = harness({ verify: vi.fn(async () => Promise.reject(new Error(`leaked ${key}`))) })
    let caught: unknown
    try {
      await onboardDeepSeekApiKey({ key, profile: 'local-dev', signal: new AbortController().signal }, h.deps)
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'PROFILE_WRITE_FAILED' })
    expect(String(caught)).not.toContain(key)
    expect(h.overlays.remove).toHaveBeenCalledExactlyOnceWith('local-dev')
    expect(h.credentials.remove).toHaveBeenCalledExactlyOnceWith(DEEPSEEK_API_CREDENTIAL_REF)
  })
})

it('keeps network and persistence behind injected seams', async () => {
  const sources = await Promise.all(
    ['api-key.ts', 'profile-overlay.ts'].map((file) =>
      readFile(new URL(`../src/onboarding/${file}`, import.meta.url), 'utf8'),
    ),
  )
  for (const source of sources) {
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/node:(?:fs|http|https|net)/)
    expect(source).not.toMatch(/\b(?:writeFile|appendFile|rename|mkdir)\s*\(/)
  }
})
