import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createResourceAdminSurface,
  type ResourceAdminSurfaceAction,
} from '../src/resources/admin-surface.js'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

async function server(
  invoke = vi.fn(
    async (_action: ResourceAdminSurfaceAction, _params: unknown): Promise<unknown> => ({ items: [] }),
  ),
) {
  let now = Date.now()
  let handler: ReturnType<typeof createResourceAdminSurface>
  const http = createServer(async (req, res) => {
    if (!(await handler.handle(req, res))) res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('listener missing')
  const origin = `http://127.0.0.1:${address.port}`
  const token = 'resource-lifecycle-token-with-enough-entropy'
  handler = createResourceAdminSurface({
    origin,
    token,
    profile: 'local-dev',
    clientId: 'resource-admin-web',
    invoke,
    clock: () => now,
  })
  closers.push(async () => {
    handler.close()
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })
  let cookie = ''
  const request = (action: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}/admin/resources/api/${action}`, {
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
    origin,
    cookie: () => cookie,
    request,
    login,
    invoke,
    expire: () => {
      now += 3_600_001
    },
  }
}

describe('local resource admin surface trust boundary', () => {
  it('uses the exact-origin BFF and has a safe read-only recovery mode', async () => {
    const s = await server()
    expect(await (await s.request('context')).json()).toMatchObject({
      profile: 'local-dev',
      clientId: 'resource-admin-web',
      readOnly: false,
    })
  })

  it('rejects cross-origin, scope-spoofed and arbitrary RPC requests before SDK dispatch', async () => {
    const s = await server()
    await s.login()
    await s.request('context')
    s.invoke.mockClear()
    expect(
      (
        await s.request(
          'skills/list',
          { profile: 'local-dev', kind: 'skill' },
          { Origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403)
    expect((await s.request('skills/list', { profile: 'other', kind: 'skill' })).status).toBe(403)
    expect(
      (await s.request('skills/list', { profile: 'local-dev', kind: 'skill', authority: 'admin' })).status,
    ).toBe(400)
    expect((await s.request('_agnes/v1/mcp.servers.create', {})).status).toBe(404)
    expect(s.invoke).not.toHaveBeenCalled()
  })

  it('rejects oversized JSON before resource dispatch and keeps malformed JSON at 400', async () => {
    const s = await server()
    const oversized = JSON.stringify({ profile: 'local-dev', padding: 'x'.repeat(1_048_576) })
    const session = await fetch(`${s.origin}/admin/resources/api/skills/list`, {
      method: 'POST',
      headers: { Origin: s.origin, 'Content-Type': 'application/json' },
      body: oversized,
    })
    expect(session.status).toBe(413)
    expect(await session.json()).toEqual({
      error: { code: 'E_RESOURCE_ADMIN_BODY_TOO_LARGE', message: '资源管理请求体超过大小限制' },
    })
    await s.request('context')
    s.invoke.mockClear()
    const action = await s.request('skills/list', {
      profile: 'local-dev',
      padding: 'x'.repeat(1_048_576),
    })
    expect(action.status).toBe(413)
    expect(await action.json()).toEqual({
      error: { code: 'E_RESOURCE_ADMIN_BODY_TOO_LARGE', message: '资源管理请求体超过大小限制' },
    })
    expect(s.invoke).not.toHaveBeenCalled()
    const malformed = await fetch(`${s.origin}/admin/resources/api/skills/list`, {
      method: 'POST',
      headers: {
        Origin: s.origin,
        'Content-Type': 'application/json',
        Cookie: s.cookie(),
      },
      body: '{',
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({
      error: { code: 'E_RESOURCE_ADMIN_REQUEST', message: '资源管理请求格式无效' },
    })
  })

  it('accepts only schema-checked safe DTOs and never relays backend exception text', async () => {
    const s = await server()
    await s.login()
    await s.request('context')
    expect(await (await s.request('skills/list', { profile: 'local-dev', kind: 'skill' })).json()).toEqual({
      items: [],
    })
    const rejectedValue = ['sentinel', 'not', 'allowed'].join('-')
    s.invoke.mockResolvedValueOnce({ items: [], secret: rejectedValue })
    const invalid = await s.request('skills/list', { profile: 'local-dev', kind: 'skill' })
    expect(invalid.status).toBe(502)
    expect(await invalid.text()).not.toContain(rejectedValue)
    s.invoke.mockRejectedValueOnce(new Error(`/private/home/token=${rejectedValue}`))
    expect(await (await s.request('skills/list', { profile: 'local-dev', kind: 'skill' })).json()).toEqual({
      error: { code: 'E_RESOURCE_ADMIN_BACKEND', message: '操作未确认，请查询状态或重新连接后台' },
    })
  })

  it('shows only the explicit unsupported state when a daemon does not expose resource methods', async () => {
    const s = await server()
    await s.login()
    await s.request('context')
    s.invoke.mockRejectedValueOnce(
      Object.assign(new Error('backend details must not leak'), {
        data: { code: 'RESOURCE_METHOD_UNAVAILABLE' },
      }),
    )
    const response = await s.request('mcp/list', { profile: 'local-dev' })
    expect(response.status).toBe(501)
    expect(await response.json()).toEqual({
      error: { code: 'E_RESOURCE_UNSUPPORTED', message: '当前后台版本不支持此资源管理能力。' },
    })
  })

  it('preserves only a stable revision-conflict signal and permits a bounded operation cancel DTO', async () => {
    const s = await server()
    await s.login()
    await s.request('context')
    s.invoke.mockRejectedValueOnce(
      Object.assign(new Error('revision and private details'), {
        data: { code: 'REVISION_CONFLICT', private: 'not-for-browser' },
      }),
    )
    const conflict = await s.request('mcp/enable', {
      profile: 'local-dev',
      serverId: 'github',
      expectedRevision: 'a'.repeat(64),
      clientId: 'resource-admin-web',
      commandId: 'enable-1',
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({
      error: { code: 'REVISION_CONFLICT', message: '资源已被另一项操作更新，请刷新后核对最新版本。' },
    })
    s.invoke.mockResolvedValueOnce({ operationId: 'resource-op-1', state: 'received' })
    const cancel = await s.request('operations/cancel', {
      profile: 'local-dev',
      operationId: 'resource-op-1',
      clientId: 'resource-admin-web',
      commandId: 'cancel-1',
    })
    expect(cancel.status).toBe(200)
    expect(await cancel.json()).toEqual({ operationId: 'resource-op-1', state: 'received' })
  })
})
