import { createHash } from 'node:crypto'
import { WorkspaceDirectoryError } from '@agnes/host'
import { describe, expect, it } from 'vitest'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { registerWorkspaces } from '../src/local/methods/workspaces.js'
import { MemorySessionWorkspaces } from '../src/storage/lister.js'
import { MemoryWorkspaceStore, WorkspaceCatalog } from '../src/storage/workspaces.js'

const request = (id: number, method: string, params: unknown = {}) => ({
  jsonrpc: '2.0' as const,
  id,
  method,
  params,
})

function endpoint(catalog: WorkspaceCatalog): LocalEndpoint {
  const endpoint = new LocalEndpoint({ clock: () => 0, principalId: 'tester' })
  endpoint.conn.initialized = true
  endpoint.conn.authKind = 'local'
  endpoint.conn.credentialKind = 'local'
  registerWorkspaces(endpoint, catalog)
  return endpoint
}

describe('workspace RPC methods', () => {
  it('adds and lists through the catalog', async () => {
    const catalog = new WorkspaceCatalog(
      new MemoryWorkspaceStore(),
      new MemorySessionWorkspaces(),
      async () => ({ path: '/repo/project', name: 'project' }),
      () => 0,
    )
    const ep = endpoint(catalog)

    await expect(
      ep.handle(request(1, '_agnes/v1/workspace.add', { path: '/repo/project' })),
    ).resolves.toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        workspace: {
          path: '/repo/project',
          name: 'project',
          lastUsedAt: null,
          sessionCount: 0,
          available: true,
          workspaceId: createHash('sha256').update('/repo/project', 'utf8').digest('hex'),
          revision: 1,
        },
      },
    })
    await expect(ep.handle(request(2, '_agnes/v1/workspace.list'))).resolves.toMatchObject({
      result: { items: [{ path: '/repo/project', available: true }] },
    })
  })

  it('maps Host validation to a stable workspace error', async () => {
    const catalog = new WorkspaceCatalog(
      new MemoryWorkspaceStore(),
      new MemorySessionWorkspaces(),
      async () => {
        throw new WorkspaceDirectoryError('not-found')
      },
    )
    const ep = endpoint(catalog)

    await expect(
      ep.handle(request(1, '_agnes/v1/workspace.add', { path: '/missing' })),
    ).resolves.toMatchObject({
      error: { code: -32011, data: { code: 'WORKSPACE_INVALID', reason: 'not-found' } },
    })
  })
})
