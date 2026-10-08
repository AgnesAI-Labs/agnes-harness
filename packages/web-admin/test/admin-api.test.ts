import { expect, it, vi } from 'vitest'
import { type AdminApiError, PluginAdminApi } from '../src/admin/plugins/api.js'
import { ADMIN_FEATURES, hasFeature } from '../src/admin/plugins/types.js'
import { loadRuntimeCatalog } from '../src/settings/api.js'

const context = {
  profile: 'local-dev',
  clientId: 'web-client',
  permissions: ['packages.read', 'packages.install'] as const,
  readOnly: false,
  authScope: 'auth.test-scope',
  features: ['packages.composite-activation.v1'],
}

it('shows newly installed bundles from the admin catalog while the shared worker retains its boot profile', async () => {
  const runtime = {
    providers: [],
    presets: [{ id: 'standard', isDefault: true }],
    bundles: [],
    localPluginFolders: { home: '/fixture/home-plugins', workspace: '/workspace/plugins' },
  }
  const catalog = [{ id: '@agnes-fde/knowledge-qa#knowledge-qa', sourcePackage: '@agnes-fde/knowledge-qa' }]
  const fetcher = vi.fn<typeof fetch>(
    async (url) =>
      new Response(
        JSON.stringify(
          url === '/admin/api/runtime'
            ? runtime
            : { revision: 0, bundles: [], effect: 'restart-required', catalog },
        ),
      ),
  )
  expect(await loadRuntimeCatalog(fetcher)).toEqual({ ...runtime, bundles: catalog })
  for (const invalid of [{ catalog: 'unknown' }, { catalog: [{ id: 1 }] }, null]) {
    fetcher.mockImplementation(
      async (url) => new Response(JSON.stringify(url === '/admin/api/runtime' ? runtime : invalid)),
    )
    await expect(loadRuntimeCatalog(fetcher)).rejects.toThrow('invalid bundle catalog')
  }
  fetcher.mockImplementation(async (url) =>
    url === '/admin/api/runtime' ? new Response(JSON.stringify(runtime)) : new Response('', { status: 503 }),
  )
  await expect(loadRuntimeCatalog(fetcher)).rejects.toThrow('bundle catalog unavailable')
})

it('reads typed composition information through the existing route and retains legacy tool groups', async () => {
  const snapshot = {
    status: 'live',
    validation: 'static',
    sessions: [
      {
        sessionKey: 'fixture',
        compositionHash: 'hash',
        preset: 'standard',
        bundles: [],
        toolGroups: [{ packageId: 'fixture', reason: 'enabled-plugin', bundles: [], tools: ['read'] }],
      },
    ],
  }
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(snapshot)))
  const api = new PluginAdminApi(context, fetcher)
  expect(await api.composition()).toEqual(snapshot)
  expect(fetcher.mock.calls[0]?.[0]).toBe('/admin/api/composition')
  fetcher.mockResolvedValue(new Response(JSON.stringify({ ...snapshot, capabilities: { tools: [] } })))
  await expect(api.composition()).rejects.toThrow()
})

it('sends the generated install DTO through the fixed BFF route', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify({ operationId: 'op-1', profile: 'local-dev' }), { status: 200 }),
    )
  const api = new PluginAdminApi(context, fetcher)

  await api.install(
    { type: 'npm', ref: 'npm:@acme/plugin@1.2.3' },
    'sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  )

  expect(fetcher).toHaveBeenCalledOnce()
  const [url, init] = fetcher.mock.calls[0] ?? []
  expect(url).toBe('/admin/plugins/api/install')
  expect(init?.credentials).toBe('same-origin')
  expect(init?.method).toBe('POST')
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>
  expect(body).toMatchObject({
    profile: 'local-dev',
    clientId: 'web-client',
    source: { type: 'npm', ref: 'npm:@acme/plugin@1.2.3' },
    expectedIntegrity: 'sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  })
  expect(body.commandId).toEqual(expect.stringMatching(/^web-/))
  expect(body).not.toHaveProperty('profileId')
  expect(body).not.toHaveProperty('pluginId')
})

it('sends a revocation DTO through the fixed BFF route with its immutable CAS baselines', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify({ operationId: 'op-untrust', profile: 'local-dev' }), { status: 200 }),
    )
  const api = new PluginAdminApi(context, fetcher)
  const integrity = `sha256-${'a'.repeat(64)}`
  const capabilityHash = 'b'.repeat(64)

  await api.untrust('acme/plugin', integrity, capabilityHash)

  const [url, init] = fetcher.mock.calls[0] ?? []
  expect(url).toBe('/admin/plugins/api/untrust')
  expect(JSON.parse(String(init?.body))).toMatchObject({
    profile: 'local-dev',
    clientId: 'web-client',
    id: 'acme/plugin',
    expectedIntegrity: integrity,
    capabilityHash,
  })
})

it('calls a stored fetch without rebinding its browser receiver to the API facade', async () => {
  let receiver: unknown = 'not-called'
  const fetcher = function (this: unknown): Promise<Response> {
    receiver = this
    return Promise.resolve(new Response(JSON.stringify({ packages: [] }), { status: 200 }))
  } as typeof fetch
  const api = new PluginAdminApi(context, fetcher)

  await api.list()

  expect(receiver).toBeUndefined()
})

it('reads validated same-origin Surface links from the admin BFF', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      surfaces: [{ packageId: 'agnes/demo-surface', surfaceId: 'demo', mount: '/demo' }],
    }),
  )
  const api = new PluginAdminApi(context, fetcher)

  await expect(api.surfaceLinks()).resolves.toEqual({
    surfaces: [{ packageId: 'agnes/demo-surface', surfaceId: 'demo', mount: '/demo' }],
  })
  expect(fetcher).toHaveBeenCalledWith('/admin/plugins/api/surfaces', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })

  fetcher.mockResolvedValueOnce(
    Response.json({
      surfaces: [{ packageId: 'agnes/demo-surface', surfaceId: 'demo', mount: 'https://evil.example' }],
    }),
  )
  await expect(api.surfaceLinks()).rejects.toMatchObject({
    details: { code: 'ADMIN_RESPONSE_INVALID' },
  })
})

it('keeps a read-only recovery context available when inventory reads need separate recovery', async () => {
  const recovery = { ...context, readOnly: true }
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(recovery), { status: 200 }))

  await expect(PluginAdminApi.context(fetcher)).resolves.toEqual(recovery)
  expect(fetcher).toHaveBeenCalledWith('/admin/plugins/api/context', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
})

it('accepts a legacy context but treats every optional hot-update feature as unsupported', async () => {
  const legacy = {
    profile: context.profile,
    clientId: context.clientId,
    permissions: [...context.permissions],
    readOnly: false,
  }
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(legacy), { status: 200 }))

  const resolved = await PluginAdminApi.context(fetcher)

  expect(resolved).toEqual(legacy)
  expect(hasFeature(resolved, ADMIN_FEATURES.compositeActivation)).toBe(false)
  expect(hasFeature(resolved, ADMIN_FEATURES.rollbackTarget)).toBe(false)
  expect(hasFeature(resolved, ADMIN_FEATURES.operationControl)).toBe(false)
})

it('keeps safe BFF errors actionable without exposing a raw response', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({ error: { code: 'E_PACKAGE_BLOCKED', message: '部署引用仍在使用此插件。' } }),
      {
        status: 409,
      },
    ),
  )
  const api = new PluginAdminApi(context, fetcher)

  await expect(api.remove('acme/plugin')).rejects.toMatchObject<Partial<AdminApiError>>({
    name: 'AdminApiError',
    details: { code: 'E_PACKAGE_BLOCKED', message: '部署引用仍在使用此插件。' },
  })
})

it('forwards the atomic activation binding for update and rollback', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ operationId: 'op-composite', profile: 'local-dev' }), {
        status: 200,
      }),
    ),
  )
  const api = new PluginAdminApi(context, fetcher)
  const oldIntegrity = `sha256-${'a'.repeat(64)}`
  const targetIntegrity = `sha256-${'b'.repeat(64)}`
  const activation = {
    expectedInstalledIntegrity: oldIntegrity,
    expectedActiveIntegrity: oldIntegrity,
    trust: { integrity: targetIntegrity, capabilityHash: 'c'.repeat(64) },
  }

  await api.update('acme/plugin', { type: 'npm', ref: 'npm:@acme/plugin@2.0.0' }, targetIntegrity, activation)
  await api.rollback('acme/plugin', targetIntegrity, activation)

  const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
  expect(bodies[0]).toMatchObject({ activation })
  expect(bodies[1]).toMatchObject({ expectedTargetIntegrity: targetIntegrity, activation })
})

it('reuses an auth-scope intent identity after an ambiguous network failure', async () => {
  const values = new Map<string, string>()
  const storage = {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  } as Storage
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
  sessionStorage.clear()
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('network unavailable'))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ operationId: 'op-recovered', profile: 'local-dev' }), { status: 200 }),
    )
  const api = new PluginAdminApi(context, fetcher)

  try {
    await expect(api.remove('acme/plugin')).rejects.toThrow('network unavailable')
    await expect(api.remove('acme/plugin')).resolves.toEqual({
      operationId: 'op-recovered',
      profile: 'local-dev',
    })

    const commands = fetcher.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body)) as { commandId: string }
      return body.commandId
    })
    expect(commands[0]).toBe(commands[1])
    expect([...Array(sessionStorage.length)].map((_, index) => sessionStorage.key(index))).not.toEqual(
      expect.arrayContaining([expect.stringContaining('agnes-plugin-intent:auth.test-scope:local-dev')]),
    )
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous)
    else Reflect.deleteProperty(globalThis, 'sessionStorage')
  }
})

it('rejects unknown context fields instead of widening the browser boundary', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ ...context, actor: 'browser' }), { status: 200 }))
  await expect(PluginAdminApi.context(fetcher)).rejects.toMatchObject({
    details: { code: 'ADMIN_CONTEXT_INVALID' },
  })
})

it('rejects unknown fields in successful BFF results', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ packages: [], secret: 'not-a-dto' }), { status: 200 }))
  const api = new PluginAdminApi(context, fetcher)
  await expect(api.list()).rejects.toMatchObject({ details: { code: 'ADMIN_RESPONSE_INVALID' } })
})

it('pinsInspect calls packages.pins.inspect and returns orphaned pins', async () => {
  const orphan = {
    pinId: 'pin-1',
    purpose: 'candidate',
    packageId: 'acme/plugin',
    version: '1.0.0',
    snapshotId: 'snap-1',
    operationId: 'op-1',
  }
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ orphans: [orphan] }), { status: 200 }))
  const api = new PluginAdminApi(context, fetcher)

  const result = await api.pinsInspect()

  expect(fetcher).toHaveBeenCalledOnce()
  const [url, init] = fetcher.mock.calls[0] ?? []
  expect(url).toBe('/admin/plugins/api/pins/inspect')
  expect(init?.method).toBe('POST')
  expect(JSON.parse(String(init?.body))).toEqual({ profile: 'local-dev' })
  expect(result).toEqual({ orphans: [orphan] })
})

it('pinsRelease calls packages.pins.release with clientId/commandId', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify({ results: [{ pinId: 'pin-1', outcome: 'released' }] }), { status: 200 }),
    )
  const api = new PluginAdminApi(context, fetcher)

  const result = await api.pinsRelease(['pin-1'])

  expect(fetcher).toHaveBeenCalledOnce()
  const [url, init] = fetcher.mock.calls[0] ?? []
  expect(url).toBe('/admin/plugins/api/pins/release')
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>
  expect(body).toMatchObject({ profile: 'local-dev', clientId: 'web-client', pinIds: ['pin-1'] })
  expect(body.commandId).toEqual(expect.stringMatching(/^web-/))
  expect(result).toEqual({ results: [{ pinId: 'pin-1', outcome: 'released' }] })
})

it('treeList and treeApply use the plugins.tree BFF routes', async () => {
  const view = {
    actual: false,
    pending: true,
    desiredDigest: `sha256-${'a'.repeat(64)}`,
  }
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(view), { status: 200 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ desiredDigest: view.desiredDigest, pending: true }), { status: 200 }),
    )
  const api = new PluginAdminApi(context, fetcher)
  await expect(api.treeList()).resolves.toEqual(view)
  expect(String(fetcher.mock.calls[0]?.[0])).toBe('/admin/plugins/api/tree/list')
  await expect(
    api.treeApply({
      encoding: 'base64',
      canonicalBase64: 'Zg==',
      digest: view.desiredDigest,
      identity: {
        treeHash: 'b'.repeat(64),
        resourceRevision: 'c'.repeat(64),
        compositeRevision: 'd'.repeat(64),
      },
    }),
  ).resolves.toEqual({ desiredDigest: view.desiredDigest, pending: true })
  expect(String(fetcher.mock.calls[1]?.[0])).toBe('/admin/plugins/api/tree/apply')
})

it('validates catalogs and sends defaults through fixed same-origin GET/PUT routes', async () => {
  const loop = { id: 'loop', version: '1.0.0', sourcePackage: '@acme/loop', capabilities: ['resume'] }
  const snapshot = { revision: 1, defaults: { loop: { id: loop.id, version: loop.version } } }
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ loops: [loop], ...snapshot }))
    .mockResolvedValueOnce(
      Response.json({
        modelAdapters: [
          {
            ...loop,
            api: 'custom',
            capabilities: { imageInput: true, tools: true, streaming: true },
            models: [{ id: 'model' }],
          },
        ],
      }),
    )
    .mockResolvedValueOnce(Response.json({ ...snapshot, revision: 2 }))
  const api = new PluginAdminApi(context, fetcher)
  expect((await api.loops()).loops).toEqual([loop])
  expect((await api.modelAdapters()).modelAdapters[0]?.models).toEqual([{ id: 'model' }])
  await expect(api.saveDefaults(snapshot)).resolves.toEqual({ ...snapshot, revision: 2 })
  expect(fetcher.mock.calls.map(([path, init]) => [path, init?.method, init?.credentials])).toEqual([
    ['/admin/api/loops', 'GET', 'same-origin'],
    ['/admin/api/model-adapters', 'GET', 'same-origin'],
    ['/admin/api/defaults', 'PUT', 'same-origin'],
  ])
  expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual(snapshot)
  fetcher.mockResolvedValueOnce(Response.json({ loops: [{ ...loop, token: 'secret' }], ...snapshot }))
  await expect(api.loops()).rejects.toMatchObject({ details: { code: 'ADMIN_RESPONSE_INVALID' } })
  fetcher.mockResolvedValueOnce(
    Response.json({
      modelAdapters: [
        {
          ...loop,
          api: 'custom',
          capabilities: { imageInput: true, tools: true, streaming: true },
          models: [null],
        },
      ],
    }),
  )
  await expect(api.modelAdapters()).rejects.toMatchObject({ details: { code: 'ADMIN_RESPONSE_INVALID' } })
  fetcher.mockResolvedValueOnce(
    Response.json({ error: { code: 'CONFIG_REVISION_CONFLICT', message: 'Reload.' } }, { status: 409 }),
  )
  await expect(api.saveDefaults(snapshot)).rejects.toMatchObject({
    details: { code: 'CONFIG_REVISION_CONFLICT' },
  })
})

it('reads publication reports and migrates a session through the scoped BFF contracts', async () => {
  const report = {
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
  const migration = {
    previousGenerationId: '11111111-1111-4111-8111-111111111111',
    generationId: '22222222-2222-4222-8222-222222222222',
    changed: true,
  }
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(report))
    .mockResolvedValueOnce(Response.json(migration))
    .mockResolvedValueOnce(Response.json({ publication: { ok: true } }))
  const api = new PluginAdminApi({ ...context, permissions: ['packages.read', 'packages.activate'] }, fetcher)
  await expect(api.publicationStatus()).resolves.toEqual(report)
  await expect(api.migrateSession('closed')).resolves.toEqual(migration)
  expect(fetcher.mock.calls[0]?.[0]).toBe('/admin/plugins/api/publication-status')
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ profile: 'local-dev' })
  expect(fetcher.mock.calls[1]?.[0]).toBe('/admin/plugins/api/sessions/migrate')
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
    profile: 'local-dev',
    clientId: 'web-client',
    commandId: expect.any(String),
    sessionId: 'closed',
  })
  await expect(api.publicationStatus()).rejects.toMatchObject({ details: { code: 'ADMIN_RESPONSE_INVALID' } })
})
