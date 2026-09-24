import { describe, expect, it } from 'vitest'
import {
  AuthProfileOverlayError,
  assertWorkspaceAuthSafe,
  createApiKeyOverlay,
  createDeepSeekApiKeyOverlay,
  DEEPSEEK_API_BASE_URL,
  DEEPSEEK_API_CREDENTIAL_REF,
  DEEPSEEK_API_MODELS_URL,
  DEEPSEEK_API_ROUTE,
} from '../src/onboarding/profile-overlay.js'

const overlay = () =>
  createDeepSeekApiKeyOverlay({
    profile: 'local-dev',
    modelId: 'deepseek-v4-pro',
    modelIds: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    fetchedAt: '2026-09-11T00:00:00.000Z',
  })

describe('DeepSeek auth-generated profile overlay', () => {
  it('pins the official OpenAI-compatible route and stores only catalogue metadata', () => {
    expect(overlay()).toEqual({
      version: 1,
      kind: 'auth-generated',
      profile: 'local-dev',
      route: {
        id: DEEPSEEK_API_ROUTE,
        api: 'openai-completions',
        baseUrl: DEEPSEEK_API_BASE_URL,
        credentialRef: DEEPSEEK_API_CREDENTIAL_REF,
      },
      model: { id: 'deepseek-v4-pro', thinking: 'high' },
      catalog: {
        source: DEEPSEEK_API_MODELS_URL,
        fetchedAt: '2026-09-11T00:00:00.000Z',
        modelIds: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      },
    })
    expect(new URL(overlay().route.baseUrl).origin).toBe('https://api.deepseek.com')
    expect(Object.isFrozen(overlay())).toBe(true)
    expect(Object.isFrozen(overlay().route)).toBe(true)
    expect(Object.isFrozen(overlay().catalog.modelIds)).toBe(true)
  })

  it('rejects invalid profile/model metadata and a selected model absent from the snapshot', () => {
    for (const input of [
      { profile: '../escape', modelId: 'deepseek-v4-pro', modelIds: ['deepseek-v4-pro'] },
      { profile: 'local-dev', modelId: 'bad\nmodel', modelIds: ['bad\nmodel'] },
      { profile: 'local-dev', modelId: 'invented', modelIds: ['deepseek-v4-pro'] },
      {
        profile: 'local-dev',
        modelId: 'deepseek-v4-pro',
        modelIds: ['deepseek-v4-pro', 'deepseek-v4-pro'],
      },
    ])
      expect(() =>
        createDeepSeekApiKeyOverlay({
          ...input,
          fetchedAt: '2026-09-11T00:00:00.000Z',
        }),
      ).toThrow(AuthProfileOverlayError)
  })

  it.each([
    {
      route: DEEPSEEK_API_ROUTE,
      api: 'openai-completions',
      baseUrl: 'https://evil.invalid/v1',
      credentialRef: DEEPSEEK_API_CREDENTIAL_REF,
    },
    {
      route: DEEPSEEK_API_ROUTE,
      api: 'openai-completions',
      baseUrl: DEEPSEEK_API_BASE_URL,
      credentialRef: 'secret://evil/stolen',
    },
    {
      route: DEEPSEEK_API_ROUTE,
      api: 'anthropic-messages',
      baseUrl: DEEPSEEK_API_BASE_URL,
      credentialRef: DEEPSEEK_API_CREDENTIAL_REF,
    },
    { route: DEEPSEEK_API_ROUTE },
  ])('rejects workspace mutation of protected auth route fields: $route', (route) => {
    expect(() => assertWorkspaceAuthSafe(overlay(), { provider: { routes: [route] } })).toThrowError(
      expect.objectContaining({ code: 'AUTH_PROFILE_OVERRIDE' }),
    )
  })

  it('accepts unrelated workspace routes and an exact protected declaration', () => {
    expect(() =>
      assertWorkspaceAuthSafe(overlay(), {
        provider: {
          routes: [
            { route: 'other', api: 'openai-completions', baseUrl: 'https://other.invalid/v1' },
            {
              route: DEEPSEEK_API_ROUTE,
              api: 'openai-completions',
              baseUrl: DEEPSEEK_API_BASE_URL,
              credentialRef: DEEPSEEK_API_CREDENTIAL_REF,
            },
          ],
        },
      }),
    ).not.toThrow()
  })

  it('has no field into which a secret or caller-selected origin can be serialized', () => {
    const built = overlay()
    const json = JSON.stringify(built)
    for (const forbidden of ['key', 'token', 'authorization', 'headers'])
      expect(Object.keys(built)).not.toContain(forbidden)
    expect(json).not.toContain('test-secret-sentinel')
    expect(json).not.toContain('evil.invalid')
  })
})

describe('generic API-key auth-generated profile overlay', () => {
  it('supports a non-DeepSeek Pi provider without serializing credentials', () => {
    const built = createApiKeyOverlay({
      profile: 'local-dev',
      route: {
        id: 'anthropic',
        api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        credentialRef: 'secret://anthropic/default',
      },
      modelId: 'claude-sonnet-4',
      modelIds: ['claude-sonnet-4'],
      fetchedAt: '2026-09-11T00:00:00.000Z',
      catalogSource: 'https://api.anthropic.com/models',
      thinking: 'medium',
    })
    expect(built.route).toEqual({
      id: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      credentialRef: 'secret://anthropic/default',
    })
    expect(built.model).toEqual({ id: 'claude-sonnet-4', thinking: 'medium' })
    expect(Object.isFrozen(built)).toBe(true)
    expect(Object.isFrozen(built.route)).toBe(true)
  })

  it.each([
    {
      route: {
        id: 'Anthropic',
        api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        credentialRef: 'secret://anthropic/default',
      },
    },
    {
      route: {
        id: 'anthropic',
        api: 'anthropic-messages',
        baseUrl: 'http://api.anthropic.com',
        credentialRef: 'secret://anthropic/default',
      },
    },
    {
      route: {
        id: 'anthropic',
        api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        credentialRef: 'secret://other/default',
      },
    },
  ])('rejects unsafe generic route metadata', ({ route }) => {
    expect(() =>
      createApiKeyOverlay({
        profile: 'local-dev',
        route,
        modelId: 'claude-sonnet-4',
        modelIds: ['claude-sonnet-4'],
        fetchedAt: '2026-09-11T00:00:00.000Z',
        catalogSource: 'https://api.anthropic.com/models',
      }),
    ).toThrowError(expect.objectContaining({ code: 'AUTH_PROFILE_INVALID' }))
  })
})
