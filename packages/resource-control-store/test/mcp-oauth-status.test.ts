import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createResourceControlService,
  McpResourceStore,
  RESOURCE_ALL_PERMISSIONS,
  type ResourceAuthority,
} from '../src/index.js'

/**
 * Task 5 (mcp-oauth-authorization plan) - `mcp.servers.oauth.status` (read) and
 * `mcp.servers.oauth.status.set` (write). Both are pure durable-journal operations dispatched
 * directly inside McpResourceStore.call(), the exact same test harness (a real McpResourceStore on
 * a temp directory, driven through createResourceControlService(store).call(method, params,
 * authority)) packages/resource-control-store/test/mcp-control.test.ts already uses for the sibling
 * mcp.servers.* methods - no new test-driving mechanism introduced, per the Task 5 brief's own
 * instruction to copy the existing fixture style.
 */
const profile = 'local-dev'
const scope = { allowedProfiles: [profile] }
const authority: ResourceAuthority = {
  audience: 'admin',
  principalId: 'owner',
  clientId: 'client',
  permissions: RESOURCE_ALL_PERMISSIONS,
}
const readOnlyAuthority: ResourceAuthority = { ...authority, permissions: ['mcp.read'] as const }
const noPermissionAuthority: ResourceAuthority = { ...authority, permissions: [] }

const oauthDefinition = {
  serverId: 'oauth-server',
  displayName: 'OAuth Server',
  transport: { kind: 'http' as const, url: 'https://mcp.example.test/api' },
  secretBinding: { kind: 'oauth' as const, staticClientId: 'static-client-id' },
}
const plainDefinition = {
  serverId: 'plain-server',
  displayName: 'Plain Server',
  transport: { kind: 'stdio' as const, executable: 'example-mcp', args: [] },
  secretBinding: { kind: 'none' as const },
}

type OAuthStatusResult = Readonly<{
  authorizationStatus: 'pending' | 'authorized' | 'needs-reconnect' | 'error' | null
  lastSafeError?: { code: string; message: string }
}>
type TestService = Omit<ReturnType<typeof createResourceControlService>, 'call'> & {
  call(
    ...args: Parameters<ReturnType<typeof createResourceControlService>['call']>
  ): Promise<OAuthStatusResult>
}
const testService = (service: ReturnType<typeof createResourceControlService>): TestService =>
  service as TestService

let directory = ''
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = ''
})

const ready = (serverId: string) => ({
  serverId,
  connectionState: 'ready' as const,
  observedRevision: null,
  catalogRevision: null,
  toolCount: 0,
  observedAt: new Date().toISOString(),
})

/** mcp.servers.create always kicks off an async drive() -> adapter.reconcile() in the background
 * (see McpResourceStore.effect()), even though none of the tests below care about connection state
 * - only reconnect/test/tools are genuinely unreachable from a status-only flow. reconcile answers
 * with a trivial "ready" status rather than throwing, matching mcp-control.test.ts's own `ready()`
 * fixture precedent: a throwing reconcile would still run to completion via drive()'s catch/finish
 * path, racing this file's own afterEach directory cleanup for no test-relevant reason. */
function statusOnlyAdapter() {
  const unreachable = () => {
    throw new Error('adapter should not be invoked by an oauth-status-only test')
  }
  return {
    reconcile: async ({ serverId }: { serverId: string }) => ({ status: ready(serverId) }),
    reconnect: unreachable,
    test: unreachable,
    tools: unreachable,
  }
}

async function settled(service: TestService, operationId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const op = await service.call('_agnes/v1/resources.operation.get', { profile, operationId }, authority)
    if (['succeeded', 'failed', 'cancelled'].includes((op as unknown as { state: string }).state)) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('operation did not settle')
}

async function createOAuthServer(
  service: TestService,
  definition: typeof oauthDefinition | typeof plainDefinition,
) {
  const receipt = await service.call(
    '_agnes/v1/mcp.servers.create',
    { profile, definition, clientId: 'client', commandId: 'create-1' },
    authority,
  )
  await settled(service, (receipt as unknown as { operationId: string }).operationId)
}

describe('mcp.servers.oauth.status / mcp.servers.oauth.status.set', () => {
  it('defaults a freshly created oauth-bound server to pending, with no lastSafeError', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-oauth-status-'))
    const store = new McpResourceStore(directory, scope, statusOnlyAdapter())
    const service = testService(createResourceControlService(store))
    await createOAuthServer(service, oauthDefinition)

    const result = await service.call(
      '_agnes/v1/mcp.servers.oauth.status',
      { profile, serverId: 'oauth-server' },
      authority,
    )

    expect(result).toEqual({ authorizationStatus: 'pending' })
  })

  it('reports null authorizationStatus for a server that is not oauth-bound', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-oauth-status-'))
    const store = new McpResourceStore(directory, scope, statusOnlyAdapter())
    const service = testService(createResourceControlService(store))
    await createOAuthServer(service, plainDefinition)

    const result = await service.call(
      '_agnes/v1/mcp.servers.oauth.status',
      { profile, serverId: 'plain-server' },
      authority,
    )

    expect(result).toEqual({ authorizationStatus: null })
  })

  it('rejects an unknown serverId with MCP_NOT_FOUND, matching mcp.servers.get', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-oauth-status-'))
    const store = new McpResourceStore(directory, scope, statusOnlyAdapter())
    const service = testService(createResourceControlService(store))

    await expect(
      service.call('_agnes/v1/mcp.servers.oauth.status', { profile, serverId: 'missing' }, authority),
    ).rejects.toMatchObject({ data: { code: 'MCP_NOT_FOUND' } })
  })

  it('status.set transitions authorizationStatus, and the read path reflects it immediately', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-oauth-status-'))
    const store = new McpResourceStore(directory, scope, statusOnlyAdapter())
    const service = testService(createResourceControlService(store))
    await createOAuthServer(service, oauthDefinition)

    const setResult = await service.call(
      '_agnes/v1/mcp.servers.oauth.status.set',
      { profile, serverId: 'oauth-server', status: 'authorized' },
      authority,
    )
    expect(setResult).toEqual({ authorizationStatus: 'authorized' })

    const readBack = await service.call(
      '_agnes/v1/mcp.servers.oauth.status',
      { profile, serverId: 'oauth-server' },
      authority,
    )
    expect(readBack).toEqual({ authorizationStatus: 'authorized' })
  })

  it('status.set can transition to needs-reconnect and to error (a callback only ever moves out of pending)', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-oauth-status-'))
    const store = new McpResourceStore(directory, scope, statusOnlyAdapter())
    const service = testService(createResourceControlService(store))
    await createOAuthServer(service, oauthDefinition)

    await service.call(
      '_agnes/v1/mcp.servers.oauth.status.set',
      { profile, serverId: 'oauth-server', status: 'needs-reconnect' },
      authority,
    )
    await expect(
      service.call('_agnes/v1/mcp.servers.oauth.status', { profile, serverId: 'oauth-server' }, authority),
    ).resolves.toEqual({ authorizationStatus: 'needs-reconnect' })

    await service.call(
      '_agnes/v1/mcp.servers.oauth.status.set',
      { profile, serverId: 'oauth-server', status: 'error' },
      authority,
    )
    await expect(
      service.call('_agnes/v1/mcp.servers.oauth.status', { profile, serverId: 'oauth-server' }, authority),
    ).resolves.toEqual({ authorizationStatus: 'error' })
  })

  it('status.set on an unknown serverId rejects with MCP_NOT_FOUND without creating a row', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-oauth-status-'))
    const store = new McpResourceStore(directory, scope, statusOnlyAdapter())
    const service = testService(createResourceControlService(store))

    await expect(
      service.call(
        '_agnes/v1/mcp.servers.oauth.status.set',
        { profile, serverId: 'missing', status: 'authorized' },
        authority,
      ),
    ).rejects.toMatchObject({ data: { code: 'MCP_NOT_FOUND' } })
  })

  it('surfaces the durable McpStatus.lastSafeError alongside authorizationStatus, without a new field', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-oauth-status-'))
    const failingStatus = {
      serverId: 'oauth-server',
      connectionState: 'unavailable' as const,
      observedRevision: null,
      catalogRevision: null,
      toolCount: 0,
      observedAt: new Date().toISOString(),
      lastSafeError: { code: 'MCP_CONNECT_FAILED', message: 'could not connect' },
    }
    const unreachable = statusOnlyAdapter()
    const store = new McpResourceStore(directory, scope, {
      reconcile: async () => ({ status: failingStatus, error: { code: 'MCP_CONNECT_FAILED', message: 'x' } }),
      reconnect: unreachable.reconnect,
      test: unreachable.test,
      tools: unreachable.tools,
    })
    const service = testService(createResourceControlService(store))
    await createOAuthServer(service, oauthDefinition)

    const result = await service.call(
      '_agnes/v1/mcp.servers.oauth.status',
      { profile, serverId: 'oauth-server' },
      authority,
    )
    expect(result).toEqual({
      authorizationStatus: 'pending',
      lastSafeError: { code: 'MCP_CONNECT_FAILED', message: 'could not connect' },
    })
  })

  it('rejects a status read without mcp.read, matching every other read-execution method', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-oauth-status-'))
    const store = new McpResourceStore(directory, scope, statusOnlyAdapter())
    const service = testService(createResourceControlService(store))
    await createOAuthServer(service, oauthDefinition)

    await expect(
      service.call(
        '_agnes/v1/mcp.servers.oauth.status',
        { profile, serverId: 'oauth-server' },
        noPermissionAuthority,
      ),
    ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  })

  it('rejects a status.set write from an authority that only has mcp.read (matches mcp.manage siblings)', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-oauth-status-'))
    const store = new McpResourceStore(directory, scope, statusOnlyAdapter())
    const service = testService(createResourceControlService(store))
    await createOAuthServer(service, oauthDefinition)

    await expect(
      service.call(
        '_agnes/v1/mcp.servers.oauth.status.set',
        { profile, serverId: 'oauth-server', status: 'authorized' },
        readOnlyAuthority,
      ),
    ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  })
})
