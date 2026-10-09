import { createServer } from 'node:http'
import type { AdminSessionSelection, DiagnosticsExportResult, PackageAdminPermission } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIONS,
  type AdminSurfaceAction,
  type AdminSurfaceOptions,
  createAdminSurface,
} from '../src/packages/admin-surface.js'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

async function server(
  invoke = vi.fn(
    async (_action: AdminSurfaceAction, _params: unknown): Promise<unknown> => ({ packages: [] }),
  ),
  surfaceLinks: () => Promise<readonly { packageId: string; surfaceId: string; mount: string }[]> = vi.fn(
    async () => [],
  ),
  selectionOptions: {
    sessionSelection?: AdminSessionSelection
    permissions?: readonly PackageAdminPermission[]
    composition?: NonNullable<AdminSurfaceOptions['composition']>
    sessionTools?: NonNullable<AdminSurfaceOptions['sessionTools']>
    diagnostics?: NonNullable<AdminSurfaceOptions['diagnostics']>
    systemPrompt?: NonNullable<AdminSurfaceOptions['systemPrompt']>
    factChain?: NonNullable<AdminSurfaceOptions['factChain']>
    runtimeAdmin?: NonNullable<AdminSurfaceOptions['runtimeAdmin']>
  } = {},
) {
  let now = Date.now()
  let handler: ReturnType<typeof createAdminSurface>
  const http = createServer(async (req, res) => {
    if (!(await handler.handle(req, res))) res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('listener missing')
  const origin = `http://127.0.0.1:${address.port}`
  const token = 'test-lifecycle-token-not-real-secret'
  handler = createAdminSurface({
    ...selectionOptions,
    origin,
    token,
    profile: 'local-dev',
    clientId: 'admin-web',
    invoke,
    surfaceLinks,
    clock: () => now,
  })
  closers.push(async () => {
    handler.close()
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })
  let cookie = ''
  const request = (action: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}/admin/plugins/api/${action}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const login = async () => {
    const response = await request('session', { token })
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
    return response
  }
  return {
    request,
    login,
    invoke,
    surfaceLinks,
    selectionRequest: (route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
      fetch(`${origin}/admin/api/${route}`, {
        method,
        headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    expire: () => {
      now += 3_600_001
    },
  }
}

describe('local package admin surface trust boundary', () => {
  it('exports strict metadata diagnostics behind the read permission and exact origin, including in recovery', async () => {
    const bundle: DiagnosticsExportResult = {
      schemaVersion: 1,
      collectedAt: '2026-10-08T00:00:00Z',
      agh: { version: 'test' },
      runtime: { platform: 'test', arch: 'test', osRelease: 'test', node: '24', pid: 1, uptimeMs: 0 },
      profile: { hash: 'a'.repeat(64) },
      generations: { available: false, current: null, items: [] },
      doctor: [],
      errors: [],
      audit: [],
      limits: { audit: 100, errors: 4096 },
      telemetry: { enabled: false, includeContent: false, endpointHosts: ['collector.example:4318'] },
    }
    const diagnostics = { export: vi.fn(async () => bundle) }
    const s = await server(undefined, undefined, { diagnostics, permissions: ['packages.read'] })
    await s.login()
    s.invoke.mockRejectedValueOnce(new Error('backend recovery'))
    expect(await (await s.request('context')).json()).toMatchObject({ readOnly: true })
    await expect((await s.selectionRequest('diagnostics')).json()).resolves.toEqual({
      bundle,
      doctorAvailable: false,
    })
    await expect((await s.selectionRequest('diagnostics', 'POST', {})).json()).resolves.toEqual(bundle)
    for (const input of [{ sessionId: 'foreign' }, { limit: 501 }, { method: 'arbitrary' }])
      expect((await s.selectionRequest('diagnostics', 'POST', input)).status).toBe(400)
    expect(
      (await s.selectionRequest('diagnostics', 'POST', {}, { Origin: 'http://evil.invalid' })).status,
    ).toBe(403)
    expect((await s.selectionRequest('diagnostics/doctor', 'POST', {})).status).toBe(503)
    const denied = await server(undefined, undefined, { diagnostics, permissions: [] })
    expect((await denied.selectionRequest('diagnostics')).status).toBe(403)
    const invalid = await server(undefined, undefined, {
      diagnostics: { export: async () => ({ ...bundle, password: 'secret' }) },
    })
    const failure = await invalid.selectionRequest('diagnostics')
    expect(failure.status).toBe(502)
    expect(await failure.text()).not.toContain('secret')
    const supported = await server(undefined, undefined, {
      diagnostics: {
        ...diagnostics,
        doctor: async () => ({
          checks: [
            {
              id: 'credentials',
              status: 'ok',
              fixHintKey: 'doctor.fix.credentials',
              message: 'private path',
            },
            { id: 'private path', status: 'fail' },
          ],
        }),
      },
    })
    await expect(
      (await supported.selectionRequest('diagnostics/doctor', 'POST', {})).json(),
    ).resolves.toEqual({ sections: [{ name: 'credentials', status: 'ok' }] })
  })

  it('returns a session tool catalog only through the authorized exact-origin BFF', async () => {
    const catalog = { sessionId: 'student:session', tools: [], resources: [] }
    const s = await server(undefined, undefined, {
      sessionTools: async (key) => {
        if (key !== catalog.sessionId) throw new Error('unavailable')
        return catalog
      },
    })
    await expect((await s.selectionRequest('tools/student%3Asession')).json()).resolves.toEqual(catalog)
    expect((await s.selectionRequest('tools/unknown')).status).toBe(404)
    expect(
      (
        await s.selectionRequest('tools/student%3Asession', 'GET', undefined, {
          Origin: 'http://evil.invalid',
        })
      ).status,
    ).toBe(403)
    const denied = await server(undefined, undefined, { permissions: [], sessionTools: async () => catalog })
    expect((await denied.selectionRequest('tools/student%3Asession')).status).toBe(403)
  })
  it('rejects an admin context that cannot pass the public strict DTO', () => {
    expect(() =>
      createAdminSurface({
        origin: 'http://127.0.0.1:43210',
        token: 'context-token',
        profile: 'local-dev',
        clientId: 'admin-web',
        features: ['Packages.Not-Canonical'],
        invoke: async () => ({ packages: [] }),
      }),
    ).toThrow('invalid local admin context')
  })

  it('allows the exact-origin local BFF without a cookie or lifecycle token', async () => {
    const s = await server()
    const context = await (await s.request('context')).json()
    expect(context).toMatchObject({
      profile: 'local-dev',
      clientId: 'admin-web',
      permissions: expect.arrayContaining(['packages.read', 'packages.install', 'packages.activate']),
      readOnly: false,
      features: [],
    })
    expect(context.authScope).toMatch(/^auth\.[a-f0-9]{32}$/)
  })

  it('returns only validated live Surface links through the exact-origin BFF', async () => {
    const surfaceLinks = vi.fn(async () => [
      { packageId: 'agnes/demo-surface', surfaceId: 'demo', mount: '/demo' },
    ])
    const s = await server(undefined, surfaceLinks)
    await expect((await s.request('surfaces')).json()).resolves.toEqual({
      surfaces: [{ packageId: 'agnes/demo-surface', surfaceId: 'demo', mount: '/demo' }],
    })
    expect(surfaceLinks).toHaveBeenCalledOnce()
    surfaceLinks.mockResolvedValueOnce([
      { packageId: 'agnes/demo-surface', surfaceId: 'demo', mount: 'https://evil.example' },
    ])
    expect((await s.request('surfaces')).status).toBe(502)
  })

  it('exposes validated generation counts through the read-only admin route', async () => {
    const status = {
      generations: [],
      plugins: [{ id: 'example', state: 'draining', boundSessions: 2, drainingSessions: 2 }],
    }
    const s = await server(
      vi.fn(async () => status),
      undefined,
      { permissions: ['packages.read'] },
    )
    expect(await (await s.request('generations', { profile: 'local-dev' })).json()).toEqual(status)
    expect((await s.request('generations', { profile: 'local-dev', sessionId: 'spoofed' })).status).toBe(400)
    const denied = await server(undefined, undefined, { permissions: [] })
    expect((await denied.request('generations', { profile: 'local-dev' })).status).toBe(403)
    const publication = {
      publication: {
        operation: 'models',
        ok: false,
        recovery: 'retry-same-input',
        containers: [
          { compositionHash: 'reader', status: 'applied' },
          { compositionHash: 'writer', status: 'failed' },
        ],
      },
    }
    s.invoke.mockResolvedValue(publication)
    expect(await (await s.request('publication-status')).json()).toEqual(publication)
    expect((await s.request('publication-status', { profile: 'other' })).status).toBe(403)
    expect((await denied.request('publication-status')).status).toBe(403)
    s.invoke.mockResolvedValue({ publication: { ...publication.publication, recovery: 'rollback' } })
    expect((await s.request('publication-status')).status).toBe(502)
  })

  it('rejects cross-site writes, scope spoofing and raw method forwarding before SDK dispatch', async () => {
    const s = await server()
    await s.login()
    await s.request('context')
    s.invoke.mockClear()
    expect(
      (await s.request('list', { profile: 'local-dev' }, { Origin: 'https://evil.example' })).status,
    ).toBe(403)
    expect(
      (await s.request('list', { profile: 'local-dev' }, { 'Sec-Fetch-Site': 'cross-site' })).status,
    ).toBe(403)
    expect((await s.request('list', { profile: 'other' })).status).toBe(403)
    expect((await s.request('list', { profile: 'local-dev', actor: 'admin' })).status).toBe(400)
    expect((await s.request('_agnes/v1/packages.install', {})).status).toBe(404)
    expect(s.invoke).not.toHaveBeenCalled()
  })

  it('allows only valid fixed-scope DTOs and does not leak backend exception text', async () => {
    const s = await server()
    await s.login()
    await s.request('context')
    expect(await (await s.request('list', { profile: 'local-dev' })).json()).toEqual({ packages: [] })
    s.invoke.mockResolvedValueOnce({ packages: [], secret: 'not-allowed' })
    const invalid = await s.request('list', { profile: 'local-dev' })
    expect(invalid.status).toBe(502)
    expect(await invalid.text()).not.toContain('not-allowed')
    s.invoke.mockRejectedValueOnce(new Error('/private/home/key?token=do-not-leak'))
    const failed = await s.request('list', { profile: 'local-dev' })
    expect(await failed.json()).toEqual({
      error: {
        code: -32603,
        message: 'INTERNAL_ERROR',
        data: {
          code: 'E_ADMIN_BACKEND',
          messageKey: 'appServer.errors.internal',
          diagnosticId: expect.any(String),
        },
      },
    })
  })

  it('strictly forwards a composite update DTO through the fixed BFF route', async () => {
    const invoke = vi.fn(
      async (action: AdminSurfaceAction): Promise<unknown> =>
        action === 'list' ? { packages: [] } : { operationId: 'op-composite', profile: 'local-dev' },
    )
    const s = await server(invoke)
    await s.login()
    await s.request('context')
    invoke.mockClear()
    const integrity = `sha256-${'a'.repeat(64)}`
    const body = {
      profile: 'local-dev',
      clientId: 'admin-web',
      commandId: 'composite-update',
      id: 'acme/plugin',
      source: { type: 'file', ref: 'file:./candidate-v2' },
      expectedIntegrity: integrity,
      activation: {
        expectedInstalledIntegrity: `sha256-${'b'.repeat(64)}`,
        expectedActiveIntegrity: null,
        trust: { integrity, capabilityHash: 'c'.repeat(64) },
      },
    }
    expect((await s.request('update', body)).status).toBe(200)
    expect(invoke).toHaveBeenCalledWith('update', body)
    expect(
      (await s.request('update', { ...body, activation: { ...body.activation, actor: 'browser' } })).status,
    ).toBe(400)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('keeps recovery read-only after a failed backend probe, including inspect', async () => {
    const s = await server()
    await s.login()
    s.invoke.mockRejectedValueOnce(new Error('bad lock'))
    expect(await (await s.request('context')).json()).toMatchObject({
      readOnly: true,
      permissions: ['packages.read'],
    })
    s.invoke.mockClear()
    const response = await s.request('inspect', {
      profile: 'local-dev',
      clientId: 'admin-web',
      commandId: 'inspect-1',
      source: { type: 'file', ref: 'file:./fixture' },
    })
    expect(response.status).toBe(409)
    expect(s.invoke).not.toHaveBeenCalled()
    expect((await s.request('list', { profile: 'local-dev' })).status).toBe(200)
    await s.request('context')
    expect(s.invoke).toHaveBeenCalledTimes(2)
  })

  // packages/web-admin/src/admin/plugins/api.ts keeps its own hand-maintained METHOD_BY_PATH map of the
  // exact same BFF surface (@agnes/daemon can't import from @agnes/web — see
  // tools/guards/dependency-allowlist.json — so the expected list is hardcoded here instead of
  // imported). The two maps have no shared source of truth: a route added to one without the other
  // either 404s (missing from ACTIONS here) or fails client-side validation (missing from
  // METHOD_BY_PATH there). This assertion is the tripwire — if you add a route to either side,
  // update BOTH `ACTIONS` above and `METHOD_BY_PATH` in packages/web-admin/src/admin/plugins/api.ts, and
  // this list.
  it('keeps the BFF route allowlist in lockstep with the Web admin API client route map', () => {
    const expectedPaths = [
      'candidates/list',
      'candidates/show',
      'candidates/create',
      'candidates/write',
      'candidates/test',
      'candidates/submit',
      'candidates/approve',
      'candidates/reject',
      'catalog/list',
      'generations',
      'provenance',
      'source-policy',
      'publication-status',
      'sessions/migrate',
      'catalog/get',
      'list',
      'inspect',
      'install',
      'trust',
      'untrust',
      'enable',
      'disable',
      'update',
      'rollback',
      'remove',
      'operation/get',
      'operation/cancel',
      'pins/inspect',
      'pins/release',
      'trust-workspace',
      'tree/get',
      'tree/list',
      'tree/apply',
      'tree/rollback',
    ]
    expect(Object.keys(ACTIONS).sort()).toEqual([...expectedPaths].sort())
  })
})

it('reads real selection catalogs and protects defaults with the existing admin boundary', async () => {
  const loop = { id: 'default', version: '1.0.0', sourcePackage: '@acme/loop', capabilities: ['resume'] }
  const adapter = {
    ...loop,
    id: 'adapter',
    api: 'custom',
    capabilities: { imageInput: true, tools: true, streaming: true },
    models: [{ id: 'model' }],
  }
  const snapshot = { revision: 4, defaults: { loop: { id: loop.id, version: loop.version } } }
  const provider: AdminSessionSelection = {
    loops: async () => [loop],
    modelAdapters: async () => [adapter],
    getDefaults: async () => snapshot,
    saveDefaults: vi.fn(async (input) => ({ ...input, revision: input.revision + 1 })),
  }
  const s = await server(undefined, undefined, { sessionSelection: provider })
  expect((await s.selectionRequest('defaults', 'PUT', snapshot)).status).toBe(409)
  await s.request('context')
  expect(await (await s.selectionRequest('loops')).json()).toEqual({ loops: [loop], ...snapshot })
  expect(await (await s.selectionRequest('model-adapters')).json()).toEqual({ modelAdapters: [adapter] })
  expect((await s.selectionRequest('defaults', 'PUT', { ...snapshot, actor: 'forged' })).status).toBe(400)
  expect(
    (await s.selectionRequest('defaults', 'PUT', snapshot, { Origin: 'https://foreign.example' })).status,
  ).toBe(403)
  expect(await (await s.selectionRequest('defaults', 'PUT', snapshot)).json()).toEqual({
    ...snapshot,
    revision: 5,
  })
  expect(provider.saveDefaults).toHaveBeenCalledExactlyOnceWith(snapshot)
  const denied = await server(undefined, undefined, {
    sessionSelection: provider,
    permissions: ['packages.read'],
  })
  await denied.request('context')
  expect((await denied.selectionRequest('defaults', 'PUT', snapshot)).status).toBe(403)
})

it('refuses absent or malformed catalogs and redacts failures and revision conflicts', async () => {
  const absent = await server()
  expect((await absent.selectionRequest('loops')).status).toBe(503)
  const selection: AdminSessionSelection = {
    loops: async () => [{ id: 'x', version: '1', sourcePackage: 'pkg', capabilities: [] }],
    modelAdapters: async () => [],
    getDefaults: async () => ({ revision: 1, defaults: {} }),
    saveDefaults: vi.fn(async () => {
      throw Object.assign(new Error('private-path secret'), { code: 'CONFIG_REVISION_CONFLICT' })
    }),
  }
  const s = await server(undefined, undefined, { sessionSelection: selection })
  await s.request('context')
  const conflict = await s.selectionRequest('defaults', 'PUT', { revision: 0, defaults: {} })
  expect(conflict.status).toBe(409)
  expect(await conflict.text()).not.toContain('private-path')
  selection.loops = async () => [
    { id: 'x', version: '1', sourcePackage: 'pkg', capabilities: [], secret: 'bad' } as never,
  ]
  expect((await s.selectionRequest('loops')).status).toBe(502)
})

it('exposes composition and gates bundle selection behind activation and recovery checks', async () => {
  const composition = {
    bundles: async () => ({
      revision: 0,
      bundles: [],
      catalog: [{ id: 'acme/research#base' }],
      effect: 'restart-required',
    }),
    dump: async (preset?: string) => ({
      preset: preset ?? 'standard',
      status: 'desired',
      sources: { loop: { layer: 'profile', name: 'local-dev' } },
    }),
    saveBundles: async (input: { revision: number; bundles: string[] }) => ({
      ...input,
      revision: input.revision + 1,
      effect: 'restart-required',
    }),
  }
  const app = await server(undefined, undefined, { composition })
  expect(
    await (await app.selectionRequest('composition', 'POST', { preset: 'research' })).json(),
  ).toMatchObject({ preset: 'research', status: 'desired' })
  expect((await app.selectionRequest('bundles', 'PUT', { revision: 0, bundles: [] })).status).toBe(409)
  await app.request('context')
  expect(
    await (
      await app.selectionRequest('bundles', 'PUT', { revision: 0, bundles: ['acme/research#base'] })
    ).json(),
  ).toMatchObject({ revision: 1, effect: 'restart-required' })
  expect((await app.selectionRequest('composition', 'POST', { preset: '../escape' })).status).toBe(400)
  const denied = await server(undefined, undefined, { composition, permissions: ['packages.read'] })
  expect((await denied.selectionRequest('bundles', 'PUT', { revision: 0, bundles: [] })).status).toBe(403)
})

it('serves runtime descriptions, gates rescan and rejects secret-bearing catalog data', async () => {
  const snapshot = {
    providers: [
      {
        kind: 'sandbox',
        id: 'local',
        version: '1.0.0',
        sourcePackage: '@agnes/host',
        capabilities: ['workspace'],
        restartRequired: true,
        active: true,
        selectedFor: ['profile'],
      },
    ],
    presets: [{ id: 'read-only', isDefault: true }],
    localPluginFolders: { home: '/synthetic/plugins', workspace: '/synthetic/.agh/plugins' },
  }
  const runtimeAdmin = { snapshot: vi.fn(async () => snapshot), reloadLocal: vi.fn(async () => {}) }
  const s = await server(undefined, undefined, { runtimeAdmin })
  expect((await s.selectionRequest('reload-local', 'POST', {})).status).toBe(409)
  await s.request('context')
  expect(await (await s.selectionRequest('runtime')).json()).toEqual(snapshot)
  expect((await s.selectionRequest('reload-local', 'POST', { path: '/forged' })).status).toBe(400)
  expect(
    (await s.selectionRequest('reload-local', 'POST', {}, { Origin: 'https://foreign.example' })).status,
  ).toBe(403)
  expect((await s.selectionRequest('reload-local', 'POST', {})).status).toBe(200)
  expect(runtimeAdmin.reloadLocal).toHaveBeenCalledTimes(1)
  const denied = await server(undefined, undefined, { runtimeAdmin, permissions: ['packages.read'] })
  await denied.request('context')
  expect((await denied.selectionRequest('reload-local', 'POST', {})).status).toBe(403)
  runtimeAdmin.snapshot.mockResolvedValueOnce({ ...snapshot, secret: 'private' } as typeof snapshot)
  const invalid = await s.selectionRequest('runtime')
  expect(invalid.status).toBe(502)
  expect(await invalid.text()).not.toContain('private')
  runtimeAdmin.reloadLocal.mockRejectedValueOnce(new Error('private path secret'))
  expect(await (await s.selectionRequest('reload-local', 'POST', {})).text()).not.toContain('private')
})

it('gates migration through admin activation permission and reports a safe refusal', async () => {
  const migration = {
    previousGenerationId: '11111111-1111-4111-8111-111111111111',
    generationId: '22222222-2222-4222-8222-222222222222',
    changed: true,
  }
  const s = await server()
  await s.request('context')
  const params = {
    profile: 'local-dev',
    clientId: 'admin-web',
    commandId: 'migration-1',
    sessionId: 'closed',
  }
  s.invoke.mockResolvedValue(migration)
  expect(await (await s.request('sessions/migrate', params)).json()).toEqual(migration)
  s.invoke.mockRejectedValue(
    Object.assign(new Error('/private/config'), { data: { reason: 'E_GENERATION_SESSION_OPEN' } }),
  )
  const refused = await s.request('sessions/migrate', params)
  expect(refused.status).toBe(409)
  expect(await refused.json()).toEqual({
    error: {
      code: -32011,
      message: 'SEMANTIC_REJECTED',
      data: {
        code: 'E_GENERATION_SESSION_OPEN',
        messageKey: 'appServer.errors.generation',
        diagnosticId: expect.any(String),
        cause: { code: 'E_GENERATION_SESSION_OPEN' },
      },
    },
  })
  s.invoke.mockRejectedValue(
    Object.assign(new Error('denied'), { data: { reason: 'session owner unavailable' } }),
  )
  expect((await s.request('sessions/migrate', params)).status).toBe(403)
  const denied = await server(undefined, undefined, { permissions: ['packages.read'] })
  await denied.request('context')
  expect((await denied.request('sessions/migrate', params)).status).toBe(403)
  expect((await s.request('sessions/migrate', { ...params, principalId: 'spoof' })).status).toBe(400)
})

it('guards fixed prompt reads and writes by origin, permission, schema and recovery mode', async () => {
  const snapshot: import('@agnes/protocol').SystemPromptSnapshot = {
    config: {},
    sections: [],
    hash: 'a'.repeat(64),
    effect: 'new-sessions',
    preview: 'default-sections',
  }
  const bridge = {
    get: async () => snapshot,
    save: async (input: import('@agnes/protocol').SystemPromptSaveParams) => ({
      ...snapshot,
      config: input.config,
    }),
  }
  const writable = await server(undefined, undefined, { systemPrompt: bridge })
  expect((await writable.selectionRequest('system-prompt')).status).toBe(200)
  expect(
    (await writable.selectionRequest('system-prompt/session', 'POST', { sessionId: 'owned' })).status,
  ).toBe(200)
  expect(
    (
      await writable.selectionRequest('system-prompt/session', 'POST', {
        sessionId: 'owned',
        principalId: 'spoof',
      })
    ).status,
  ).toBe(400)
  expect((await writable.selectionRequest('system-prompt', 'POST', { config: {} })).status).toBe(409)
  await writable.login()
  await writable.request('context')
  expect(
    (await writable.selectionRequest('system-prompt', 'POST', { config: { personaPrefix: 'hello' } })).status,
  ).toBe(200)
  expect(
    (
      await writable.selectionRequest('system-prompt', 'POST', {
        config: { personaPrefix: 'x'.repeat(8193) },
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await writable.selectionRequest(
        'system-prompt',
        'POST',
        { config: {} },
        { Origin: 'http://evil.invalid' },
      )
    ).status,
  ).toBe(403)
  const reader = await server(undefined, undefined, { systemPrompt: bridge, permissions: ['packages.read'] })
  expect((await reader.selectionRequest('system-prompt', 'POST', { config: {} })).status).toBe(403)
})

it('restricts fact-chain reads to the fixed same-origin read bridge with strict input and output contracts', async () => {
  const input = { sessionId: 'owned', laneId: 'main', anchor: { kind: 'tool', toolUseId: 't1' } }
  const result = {
    sessionId: 'owned',
    laneId: 'main',
    atSeq: 1,
    nodes: [],
    edges: [],
    gaps: [{ at: null, reason: 'source-unavailable' as const }],
  }
  const s = await server(undefined, undefined, {
    permissions: ['packages.read'],
    factChain: async () => result,
  })
  expect((await s.selectionRequest('fact-chain', 'POST', input)).status).toBe(200)
  expect(
    (await s.selectionRequest('fact-chain', 'POST', { ...input, compareSessionId: 'foreign' })).status,
  ).toBe(400)
  expect(
    (await s.selectionRequest('fact-chain', 'POST', input, { Origin: 'http://evil.invalid' })).status,
  ).toBe(403)
  const denied = await server(undefined, undefined, { permissions: [], factChain: async () => result })
  expect((await denied.selectionRequest('fact-chain', 'POST', input)).status).toBe(403)
  const invalid = await server(undefined, undefined, {
    factChain: async () => ({ ...result, password: 'secret' }),
  })
  expect((await invalid.selectionRequest('fact-chain', 'POST', input)).status).toBe(502)
})
