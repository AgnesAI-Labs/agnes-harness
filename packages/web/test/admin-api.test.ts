import { expect, it, vi } from 'vitest'
import { type AdminApiError, PluginAdminApi } from '../src/admin/plugins/api.js'
import { ADMIN_FEATURES, hasFeature } from '../src/admin/plugins/types.js'

const context = {
  profile: 'local-dev',
  clientId: 'web-client',
  permissions: ['packages.read', 'packages.install'] as const,
  readOnly: false,
  authScope: 'auth.test-scope',
  features: ['packages.composite-activation.v1'],
}

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
