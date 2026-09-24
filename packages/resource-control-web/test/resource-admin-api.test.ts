import { expect, it, vi } from 'vitest'
import { ResourceAdminApi } from '../src/api.js'
import { SKILL_EMPTY_COPY, SKILL_LOCATION_HINTS } from '../src/skill-copy.js'

const context = {
  profile: 'local-dev',
  clientId: 'resource-web',
  permissions: ['resources.read'],
  readOnly: false,
}

it('sends an MCP create only through its fixed resource BFF route and only with SecretRef DTO data', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify({ operationId: 'op-1', state: 'received' }), { status: 200 }),
    )
  const api = new ResourceAdminApi(context, fetcher)
  await api.mcpCreate({
    serverId: 'github',
    displayName: 'GitHub',
    transport: { kind: 'stdio', executable: 'mcp-github', args: [] },
    secretBinding: { kind: 'stdio-env', env: { TOKEN: 'secret://local/github' } },
  })
  const [url, init] = fetcher.mock.calls[0] ?? []
  expect(url).toBe('/admin/resources/api/mcp/create')
  expect(init?.credentials).toBe('same-origin')
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>
  expect(body).toMatchObject({
    profile: 'local-dev',
    clientId: 'resource-web',
    definition: { secretBinding: { env: { TOKEN: 'secret://local/github' } } },
  })
  expect(body.commandId).toEqual(expect.stringMatching(/^web-resource-/))
  expect(JSON.stringify(body)).not.toContain('TOKEN=')
})

it('reads resource context from its independent fixed route', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(context), { status: 200 }))
  await expect(ResourceAdminApi.context(fetcher)).resolves.toEqual(context)
  expect(fetcher).toHaveBeenCalledWith('/admin/resources/api/context', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
})

it('rejects malformed BFF context instead of rendering an unauthenticated resource page', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ profile: 'local-dev' })))
  await expect(ResourceAdminApi.context(fetcher)).rejects.toMatchObject({
    details: { code: 'RESOURCE_ADMIN_CONTEXT_INVALID' },
  })
})

it('keeps pagination, operation progress reads, and cancellation on fixed typed BFF routes', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], nextCursor: 'cursor-2' }), { status: 200 }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          operationId: 'op-1',
          state: 'running',
          progress: 42,
          updatedAt: '2026-09-14T00:00:00.000Z',
        }),
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ operationId: 'op-1', state: 'received' }), { status: 200 }),
    )
  const api = new ResourceAdminApi(context, fetcher)
  await expect(api.mcp('cursor-1')).resolves.toMatchObject({ nextCursor: 'cursor-2' })
  await expect(api.operation('op-1')).resolves.toMatchObject({ state: 'running', progress: 42 })
  await api.cancel('op-1')
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    '/admin/resources/api/mcp/list',
    '/admin/resources/api/operations/get',
    '/admin/resources/api/operations/cancel',
  ])
  const [, statusInit] = fetcher.mock.calls[1] ?? []
  const [, cancelInit] = fetcher.mock.calls[2] ?? []
  expect(JSON.parse(String(statusInit?.body))).toMatchObject({ profile: 'local-dev', operationId: 'op-1' })
  expect(JSON.parse(String(cancelInit?.body))).toMatchObject({
    profile: 'local-dev',
    operationId: 'op-1',
    clientId: 'resource-web',
  })
})

it('explains Skill roots with templates and never interpolates an absolute path', () => {
  expect(SKILL_LOCATION_HINTS).toEqual([
    '<当前工作区>/.agh/skills/<名称>/SKILL.md',
    '~/.agh/skills/<名称>/SKILL.md',
    '~/.agents/skills/<名称>/SKILL.md',
    '~/.claude/skills/<名称>/SKILL.md',
    '~/.codex/skills/<名称>/SKILL.md',
  ])
  expect(SKILL_EMPTY_COPY).toContain('不会读取普通 skills/ 文件夹')
  expect(SKILL_EMPTY_COPY).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\/)
})

it('sends deletion and priority changes by identity with revision and priority preconditions', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json({ operationId: 'op', state: 'received' }))
  const api = new ResourceAdminApi(context, fetcher)
  await api.skillRemove('skill/user/user-agnes/id', 'a'.repeat(64))
  await api.skillPriority('skill/user/user-agnes/id', 'a'.repeat(64), 400, 500)
  await api.skillPriority('skill/user/user-agnes/id', 'a'.repeat(64), 500, null)
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    '/admin/resources/api/skills/remove',
    '/admin/resources/api/skills/priority',
    '/admin/resources/api/skills/priority',
  ])
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
    expectedPriority: 400,
    priority: 500,
  })
  expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toMatchObject({
    expectedPriority: 500,
    priority: null,
  })
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).not.toHaveProperty('path')
})
