import type { ResolvedDeployment } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import {
  createSurfaceRoutes,
  type PortalSubject,
  type SurfaceRelay,
  type SurfaceRelayRequest,
} from '../src/surfaces/routes.js'

const deployment = {
  id: 'customer',
  version: '1.0.0',
  inventoryHash: 'inventory',
  deploymentHash: 'deployment',
  policyHash: 'policy',
  hash: 'resolved',
  surfaces: [
    {
      package: 'acme-dashboard',
      version: '1.0.0',
      integrity: `sha256-${'a'.repeat(64)}`,
      descriptor: {
        id: 'dashboard',
        apiRange: '^1.0.0',
        artifact: { kind: 'node', entry: './dist/server.js' },
        healthPath: '/healthz',
        requires: {
          services: [{ extension: 'acme/dashboard', name: 'sales.query', range: '^1.0.0' }],
        },
      },
      instance: {
        package: 'acme-dashboard',
        surfaceId: 'dashboard',
        mount: '/sales',
        sourceId: 'sales-bff',
        config: {},
        secrets: {},
        grants: [{ extension: 'acme/dashboard', name: 'sales.query', range: '^1.0.0' }],
      },
      services: [
        {
          extension: 'acme/dashboard',
          name: 'sales.query',
          version: '1.0.0',
          package: 'acme-dashboard',
          integrity: `sha256-${'b'.repeat(64)}`,
        },
      ],
    },
  ],
} as const satisfies ResolvedDeployment

function subject(sessionId = 'login-1', subjectId = 'user-1', token = 'server-only'): PortalSubject {
  return { sessionId, subjectId, credential: { kind: 'portal-identity', token } }
}

function setup(resolveSubject: () => Promise<PortalSubject | null> = async () => subject()) {
  const requests: SurfaceRelayRequest[] = []
  const bindings: unknown[] = []
  const relays: SurfaceRelay[] = []
  const factory = vi.fn(async (binding) => {
    bindings.push(binding)
    const relay: SurfaceRelay = {
      request: vi.fn(async (request) => {
        requests.push(request)
        return { status: 200, headers: { 'content-type': 'application/json' }, body: { ok: true } }
      }),
      close: vi.fn(async () => undefined),
    }
    relays.push(relay)
    return relay
  })
  const routes = createSurfaceRoutes({
    deployment,
    resolveSubject,
    connectionFactory: factory,
    secretLease: { complete: true, values: [] },
  })
  return { bindings, factory, relays, requests, routes }
}

describe('Surface Portal authorization', () => {
  it('refuses to start without a complete server-side secret lease', () => {
    expect(() =>
      (createSurfaceRoutes as (options: unknown) => unknown)({
        deployment,
        resolveSubject: async () => subject(),
        connectionFactory: async () => ({ request: async () => ({ status: 200 }) }),
      }),
    ).toThrow('complete Surface secret redaction lease')
    expect(() =>
      (createSurfaceRoutes as (options: unknown) => unknown)({
        deployment,
        resolveSubject: async () => subject(),
        connectionFactory: async () => ({ request: async () => ({ status: 200 }) }),
        secretLease: { complete: false, values: [] },
      }),
    ).toThrow('complete Surface secret redaction lease')
  })

  it('publishes only explicit deployment mounts and blocks daemon/internal and unsafe paths', async () => {
    const { factory, routes } = setup()
    for (const url of [
      '/unknown/api',
      '/_agnes/v1/extension.call',
      '/sales/_agnes/v1/extension.call',
      '/sales/../admin',
      '/sales/%2e%2e/admin',
      '/sales/api%2fadmin',
      '/sales/api%5cadmin',
      '/sales/api%252fadmin',
      '/sales/api%25252fadmin',
      '/sales/%25252e%25252e/admin',
      '/sales/%255fagnes/v1/extension.call',
      '/sales/api%00admin',
      '/sales//api',
      '//evil.example/sales',
      'https://evil.example/sales',
    ]) {
      const response = await routes.handle({ method: 'GET', url })
      expect(response.status, url).toBeGreaterThanOrEqual(400)
    }
    expect(factory).not.toHaveBeenCalled()
  })

  it('requires a Portal subject before creating a source-bound relay', async () => {
    const { factory, routes } = setup(async () => null)
    const response = await routes.handle({ method: 'POST', url: '/sales/api/report', body: {} })
    expect(response).toMatchObject({ status: 401 })
    expect(factory).not.toHaveBeenCalled()
  })

  it('binds source and subject in the factory and strips forged identity recursively', async () => {
    const { bindings, requests, routes } = setup()
    const response = await routes.handle({
      method: 'POST',
      url: '/sales/api/report?period=q1',
      headers: {
        authorization: 'Bearer browser-forgery',
        cookie: 'portal=do-not-forward',
        'content-type': 'application/json',
        'x-request-id': 'request-1',
        'x-agnes-source-auth': 'forged',
      },
      body: {
        query: 'north',
        actor: { id: 'admin' },
        principalId: 'root',
        nested: { credential: { kind: 'local' }, keep: true },
      },
    })

    expect(response.status).toBe(200)
    expect(bindings).toEqual([
      {
        sourceId: 'sales-bff',
        sessionId: 'login-1',
        subjectId: 'user-1',
        subjectCredential: { kind: 'portal-identity', token: 'server-only' },
        grants: [{ extension: 'acme/dashboard', name: 'sales.query', range: '^1.0.0' }],
        signal: expect.any(AbortSignal),
      },
    ])
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/api/report?period=q1',
        headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' },
        body: { query: 'north', nested: { keep: true } },
        signal: expect.any(AbortSignal),
      },
    ])
  })

  it('parses JSON text before removing forged identity fields', async () => {
    const { requests, routes } = setup()
    const response = await routes.handle({
      method: 'POST',
      url: '/sales/api/report',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ value: 1, actor: { id: 'root' }, nested: { principal_id: 'root' } }),
    })
    expect(response.status).toBe(200)
    expect(requests[0]?.body).toEqual({ value: 1, nested: {} })
  })

  it('never pools across login sessions or permits a session id to change subject', async () => {
    let active = subject('login-1', 'user-1')
    const { factory, relays, routes } = setup(async () => active)
    expect((await routes.handle({ method: 'GET', url: '/sales/api/me' })).status).toBe(200)
    active = subject('login-2', 'user-1')
    expect((await routes.handle({ method: 'GET', url: '/sales/api/me' })).status).toBe(200)
    expect(factory).toHaveBeenCalledTimes(2)

    active = subject('login-1', 'user-2')
    expect((await routes.handle({ method: 'GET', url: '/sales/api/me' })).status).toBe(401)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(relays[0]?.close).toHaveBeenCalledOnce()
  })

  it('closes and replaces an initialized relay when the same login subject refreshes credentials', async () => {
    let active = subject('login-1', 'user-1', 'old-token')
    let finishOldRequest:
      | ((response: { status: number; headers: { 'content-type': string }; body: unknown }) => void)
      | undefined
    let oldSignal: AbortSignal | undefined
    const oldClose = vi.fn()
    const freshRequest = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { credential: 'fresh' },
    }))
    const factory = vi.fn(async ({ subjectCredential }: { subjectCredential: unknown }) => {
      const token = (subjectCredential as { token: string }).token
      if (token === 'old-token')
        return {
          request: async ({ signal }: SurfaceRelayRequest) => {
            oldSignal = signal
            return new Promise<{ status: number; headers: { 'content-type': string }; body: unknown }>(
              (resolve) => {
                finishOldRequest = resolve
              },
            )
          },
          close: oldClose,
        }
      return { request: freshRequest, close: vi.fn() }
    })
    const routes = createSurfaceRoutes({
      deployment,
      resolveSubject: async () => active,
      connectionFactory: factory,
      secretLease: { complete: true, values: [] },
    })

    const oldRequest = routes.handle({ method: 'GET', url: '/sales/api/me' })
    await vi.waitFor(() => expect(oldSignal).toBeDefined())
    active = subject('login-1', 'user-1', 'fresh-token')
    await expect(routes.handle({ method: 'GET', url: '/sales/api/me' })).resolves.toMatchObject({
      status: 200,
    })

    expect(factory).toHaveBeenCalledTimes(2)
    expect(oldSignal?.aborted).toBe(true)
    await vi.waitFor(() => expect(oldClose).toHaveBeenCalledOnce())
    finishOldRequest?.({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { credential: 'stale' },
    })
    await expect(oldRequest).resolves.toMatchObject({ status: 401 })
    expect(freshRequest).toHaveBeenCalledOnce()
  })

  it('does not let a slow stale credential replace a newer concurrent connection', async () => {
    let resolveOld: ((value: PortalSubject) => void) | undefined
    const freshClose = vi.fn()
    const factory = vi.fn(async () => ({
      request: async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { ok: true },
      }),
      close: freshClose,
    }))
    const routes = createSurfaceRoutes({
      deployment,
      resolveSubject: async (request) => {
        if (request.headers?.['x-request-id'] === 'old')
          return new Promise<PortalSubject>((resolve) => {
            resolveOld = resolve
          })
        return subject('login-1', 'user-1', 'fresh-token')
      },
      connectionFactory: factory,
      secretLease: { complete: true, values: [] },
    })

    const stale = routes.handle({ method: 'GET', url: '/sales/api/me', headers: { 'x-request-id': 'old' } })
    await vi.waitFor(() => expect(resolveOld).toBeDefined())
    await expect(
      routes.handle({ method: 'GET', url: '/sales/api/me', headers: { 'x-request-id': 'fresh' } }),
    ).resolves.toMatchObject({ status: 200 })
    resolveOld?.(subject('login-1', 'user-1', 'old-token'))

    await expect(stale).resolves.toMatchObject({ status: 401 })
    expect(factory).toHaveBeenCalledOnce()
    expect(freshClose).not.toHaveBeenCalled()
  })

  it('aborts a pending factory and never invokes its relay after a subject switch', async () => {
    let active = subject('login-1', 'user-1')
    let finishFactory: ((relay: SurfaceRelay) => void) | undefined
    let factorySignal: AbortSignal | undefined
    const relay: SurfaceRelay = { request: vi.fn(), close: vi.fn() }
    const routes = createSurfaceRoutes({
      deployment,
      resolveSubject: async () => active,
      connectionFactory: async ({ signal }) => {
        factorySignal = signal
        return new Promise<SurfaceRelay>((resolve) => {
          finishFactory = resolve
        })
      },
      secretLease: { complete: true, values: [] },
    })

    const oldRequest = routes.handle({ method: 'GET', url: '/sales/api/me' })
    await vi.waitFor(() => expect(factorySignal).toBeDefined())
    active = subject('login-1', 'user-2')
    expect((await routes.handle({ method: 'GET', url: '/sales/api/me' })).status).toBe(401)
    expect(factorySignal?.aborted).toBe(true)
    finishFactory?.(relay)
    expect((await oldRequest).status).toBe(401)
    expect(relay.request).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(relay.close).toHaveBeenCalledOnce())
  })

  it('aborts and suppresses an in-flight response when its login session closes', async () => {
    let finishRequest:
      | ((response: { status: number; headers: { 'content-type': string }; body: unknown }) => void)
      | undefined
    let relaySignal: AbortSignal | undefined
    const close = vi.fn()
    const routes = createSurfaceRoutes({
      deployment,
      resolveSubject: async () => subject(),
      connectionFactory: async () => ({
        request: async ({ signal }) => {
          relaySignal = signal
          return new Promise((resolve) => {
            finishRequest = resolve
          })
        },
        close,
      }),
      secretLease: { complete: true, values: ['old-private-value'] },
    })

    const pending = routes.handle({ method: 'GET', url: '/sales/api/me' })
    await vi.waitFor(() => expect(relaySignal).toBeDefined())
    await routes.closeSession('login-1')
    expect(relaySignal?.aborted).toBe(true)
    finishRequest?.({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { value: 'old-private-value' },
    })
    const response = await pending
    expect(response.status).toBe(401)
    expect(response.body).not.toContain('old-private-value')
    expect(close).toHaveBeenCalledOnce()
  })

  it('aborts pending factories on global close without waiting for an uncooperative factory', async () => {
    let factorySignal: AbortSignal | undefined
    const routes = createSurfaceRoutes({
      deployment,
      resolveSubject: async () => subject(),
      connectionFactory: async ({ signal }) => {
        factorySignal = signal
        return new Promise<SurfaceRelay>(() => undefined)
      },
      secretLease: { complete: true, values: [] },
    })
    void routes.handle({ method: 'GET', url: '/sales/api/me' })
    await vi.waitFor(() => expect(factorySignal).toBeDefined())
    await routes.close()
    expect(factorySignal?.aborted).toBe(true)
    expect((await routes.handle({ method: 'GET', url: '/sales/api/me' })).status).toBe(503)
  })

  it('does not leak factory, relay, identity, or configured secret values in responses', async () => {
    const factorySecret = 'factory-secret-value'
    const routes = createSurfaceRoutes({
      deployment,
      resolveSubject: async () => subject(),
      connectionFactory: async () => ({
        request: async () => ({
          status: 200,
          headers: {
            'content-type': 'application/json',
            refresh: '0; url=https://evil.example/phish',
            'x-upstream-note': `contains xy and ${factorySecret}`,
            'set-cookie': `session=${factorySecret}`,
            'x-agnes-debug': factorySecret,
          },
          body: {
            value: `prefix ${factorySecret} suffix`,
            short: 'value xy suffix',
            xyField: 17,
            token: factorySecret,
            actor: { id: 'user-1' },
          },
        }),
      }),
      secretLease: { complete: true, values: [factorySecret, 'xy', '7'] },
    })
    const response = await routes.handle({ method: 'GET', url: '/sales/api/report' })
    expect(JSON.stringify(response)).not.toContain(factorySecret)
    expect(response.headers).not.toHaveProperty('set-cookie')
    expect(response.headers).not.toHaveProperty('x-agnes-debug')
    expect(response.headers).not.toHaveProperty('refresh')
    expect(response.headers['x-upstream-note']).toBe('contains [REDACTED] and [REDACTED]')
    expect(JSON.stringify(response)).not.toContain('xy')
    expect(JSON.stringify(response)).not.toContain('7')
    expect(JSON.parse(response.body)).toEqual({
      value: 'prefix [REDACTED] suffix',
      short: 'value [REDACTED] suffix',
      '[REDACTED]Field': '1[REDACTED]',
    })

    const failed = createSurfaceRoutes({
      deployment,
      resolveSubject: async () => subject(),
      connectionFactory: async () => {
        throw new Error(factorySecret)
      },
      secretLease: { complete: true, values: [factorySecret] },
    })
    const error = await failed.handle({ method: 'GET', url: '/sales/api/report' })
    expect(error.status).toBe(502)
    expect(JSON.stringify(error)).not.toContain(factorySecret)
  })
})
