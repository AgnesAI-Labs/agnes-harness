import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACTIONS, type AdminSurfaceAction, createAdminSurface } from '../src/packages/admin-surface.js'

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
    expire: () => {
      now += 3_600_001
    },
  }
}

describe('local package admin surface trust boundary', () => {
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
      error: { code: 'E_ADMIN_BACKEND', message: '操作未确认，请查询状态或重新连接后台' },
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

  // packages/web/src/admin/plugins/api.ts keeps its own hand-maintained METHOD_BY_PATH map of the
  // exact same BFF surface (@agnes/daemon can't import from @agnes/web — see
  // tools/guards/dependency-allowlist.json — so the expected list is hardcoded here instead of
  // imported). The two maps have no shared source of truth: a route added to one without the other
  // either 404s (missing from ACTIONS here) or fails client-side validation (missing from
  // METHOD_BY_PATH there). This assertion is the tripwire — if you add a route to either side,
  // update BOTH `ACTIONS` above and `METHOD_BY_PATH` in packages/web/src/admin/plugins/api.ts, and
  // this list.
  it('keeps the BFF route allowlist in lockstep with the Web admin API client route map', () => {
    const expectedPaths = [
      'catalog/list',
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
