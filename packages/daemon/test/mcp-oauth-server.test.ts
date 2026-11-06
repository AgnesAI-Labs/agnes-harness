import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createResourceControlService,
  McpResourceStore,
  RESOURCE_ALL_PERMISSIONS,
  type ResourceAuthority,
} from '@agnes/resource-control-store'
import { afterEach, describe, expect, it } from 'vitest'
import { mcpOAuthServerLookup } from '../src/supervisor/mcp-oauth-server.js'

const profile = 'local-dev'
const owner: ResourceAuthority = {
  audience: 'admin',
  principalId: 'owner',
  clientId: 'client',
  permissions: RESOURCE_ALL_PERMISSIONS,
}
const definition = {
  serverId: 'docs',
  displayName: 'Docs',
  transport: { kind: 'http' as const, url: 'https://mcp.example.test/mcp' },
  secretBinding: { kind: 'oauth' as const, staticClientId: 'client-1' },
}

describe('MCP server lookup for the daemon OAuth sign-in', () => {
  let directory = ''
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = ''
  })

  async function service() {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-oauth-lookup-'))
    const store = new McpResourceStore(directory, { allowedProfiles: [profile] }, {
      reconcile: async ({ serverId }: { serverId: string }) => ({
        status: {
          serverId,
          connectionState: 'disabled' as const,
          observedRevision: null,
          catalogRevision: null,
          toolCount: 0,
          observedAt: new Date().toISOString(),
        },
      }),
      reconnect: async () => {
        throw new Error('not used')
      },
      test: async () => ({ toolCount: 0, catalogRevision: 'a'.repeat(64) }),
    } as never)
    store.setDeferredDrive(true)
    const control = createResourceControlService(store)
    const receipt = (await control.call(
      '_agnes/v1/mcp.servers.create',
      { profile, definition, clientId: 'client', commandId: 'create-docs' },
      owner,
    )) as { operationId: string }
    await store.driveOperation(profile, receipt.operationId)
    return control
  }

  it('reads a real definition with its own read-only authority', async () => {
    const lookup = mcpOAuthServerLookup(await service())
    expect(await lookup(profile, 'docs')).toMatchObject(definition)
  })

  it('an unknown server or another profile reads as no server', async () => {
    const lookup = mcpOAuthServerLookup(await service())
    expect(await lookup(profile, 'missing')).toBeUndefined()
    expect(await lookup('other-profile', 'docs')).toBeUndefined()
  })

  it('any other failure is rethrown, not reported as a missing server', async () => {
    const failure = new Error('journal read failed')
    const lookup = mcpOAuthServerLookup(
      createResourceControlService({
        call: async () => {
          throw failure
        },
        recover: async () => undefined,
      }),
    )
    await expect(lookup(profile, 'docs')).rejects.toBe(failure)
  })
})
