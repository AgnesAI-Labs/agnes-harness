import { describe, expect, it } from 'vitest'
import { createClient } from '../src/index.node.js'
import { memoryJournal } from '../src/journal.js'
import { fakeEndpoint } from './helpers/fake-endpoint.js'

const profile = 'local-dev'
const revision = 'a'.repeat(64)
const receipt = { operationId: 'resource-op', state: 'received' as const }
const skill = {
  kind: 'skill' as const,
  resourceId: `skill/user-agnes/${'b'.repeat(64)}`,
  name: 'example',
  revision,
  sourceIdentity: { scope: 'user' as const, rootKey: 'user-agnes' as const, sourceId: 'b'.repeat(64) },
  priority: 400,
  resolution: { winner: true, shadowed: [] },
  trust: 'untrusted' as const,
  desired: 'disabled' as const,
  actual: 'disabled' as const,
  stale: false,
}
const definition = {
  serverId: 'example',
  displayName: 'Example',
  transport: { kind: 'stdio' as const, executable: 'example', args: [] },
  secretBinding: { kind: 'none' as const },
}
const mcp = {
  kind: 'mcp' as const,
  resourceId: 'mcp/example',
  serverId: 'example',
  displayName: 'Example',
  revision,
  definition,
  transportKind: 'stdio' as const,
  secretBindingKind: 'none' as const,
  trust: 'untrusted' as const,
  desired: 'disabled' as const,
  actual: 'disabled' as const,
  source: 'managed' as const,
}

describe('Node resource control client', () => {
  it('forwards profile, cursor, revision and caller command identity to every frozen resource RPC', async () => {
    const endpoint = fakeEndpoint({
      initialize: fakeEndpoint({}).initialize,
      '_agnes/v1/resources.list': () => ({ items: [skill] }),
      '_agnes/v1/resources.get': () => skill,
      '_agnes/v1/resources.desired.set': () => receipt,
      '_agnes/v1/resources.operation.get': () => ({
        operationId: 'resource-op',
        kind: 'skills.refresh',
        state: 'succeeded',
        profile,
        target: skill.resourceId,
        revision,
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:00.000Z',
      }),
      '_agnes/v1/resources.operation.cancel': () => receipt,
      '_agnes/v1/skills.refresh': () => receipt,
      '_agnes/v1/skills.trust.set': () => receipt,
      '_agnes/v1/mcp.servers.list': () => ({ items: [mcp] }),
      '_agnes/v1/mcp.servers.get': () => mcp,
      '_agnes/v1/mcp.servers.status': () => ({
        serverId: 'example',
        connectionState: 'disabled',
        observedRevision: null,
        catalogRevision: null,
        toolCount: 0,
        observedAt: '2026-09-14T00:00:00.000Z',
      }),
      '_agnes/v1/mcp.servers.tools.list': () => ({
        serverId: 'example',
        catalogRevision: revision,
        items: [],
      }),
      '_agnes/v1/mcp.servers.create': () => receipt,
      '_agnes/v1/mcp.servers.update': () => receipt,
      '_agnes/v1/mcp.servers.remove': () => receipt,
      '_agnes/v1/mcp.servers.trust.set': () => receipt,
      '_agnes/v1/mcp.servers.test': () => receipt,
      '_agnes/v1/mcp.servers.enable': () => receipt,
      '_agnes/v1/mcp.servers.disable': () => receipt,
      '_agnes/v1/mcp.servers.reconnect': () => receipt,
      '_agnes/v1/mcp.servers.oauth.status': () => ({ authorizationStatus: 'pending' }),
      '_agnes/v1/mcp.servers.oauth.status.set': () => ({ authorizationStatus: 'authorized' }),
    })
    const client = createClient({
      transport: { kind: 'inproc', endpoint: endpoint.endpoint },
      journal: memoryJournal('resource-sdk'),
    })
    const identity = { profile, clientId: 'resource-sdk', commandId: 'resource-command' }
    try {
      await client.resources.list({ profile, kind: 'skill', cursor: 'next' })
      await client.resources.get({ profile, resourceId: skill.resourceId })
      await client.resources.desiredSet({
        ...identity,
        resourceId: skill.resourceId,
        state: 'enabled',
        expectedRevision: revision,
        config: { kind: 'none' },
      })
      await client.resources.operation.get({ profile, operationId: 'resource-op' })
      await client.resources.operation.cancel({ ...identity, operationId: 'resource-op' })
      await client.skills.refresh(identity)
      await client.skills.trustSet({
        ...identity,
        resourceId: skill.resourceId,
        expectedRevision: revision,
        trust: 'trusted',
      })
      await client.mcp.servers.list({ profile, cursor: 'next' })
      await client.mcp.servers.get({ profile, serverId: 'example' })
      await client.mcp.servers.status({ profile, serverId: 'example' })
      await client.mcp.servers.tools.list({ profile, serverId: 'example', cursor: 'next' })
      await client.mcp.servers.create({ ...identity, definition })
      await client.mcp.servers.update({
        ...identity,
        serverId: 'example',
        expectedRevision: revision,
        definition,
      })
      await client.mcp.servers.remove({ ...identity, serverId: 'example', expectedRevision: revision })
      await client.mcp.servers.trustSet({
        ...identity,
        serverId: 'example',
        expectedRevision: revision,
        trust: 'trusted',
      })
      await client.mcp.servers.test({ ...identity, serverId: 'example', expectedRevision: revision })
      await client.mcp.servers.enable({ ...identity, serverId: 'example', expectedRevision: revision })
      await client.mcp.servers.disable({ ...identity, serverId: 'example', expectedRevision: revision })
      await client.mcp.servers.reconnect({ ...identity, serverId: 'example', expectedRevision: revision })
      await client.mcp.servers.oauth.status({ profile, serverId: 'example' })
      await client.mcp.servers.oauth.statusSet({ profile, serverId: 'example', status: 'authorized' })
      expect(endpoint.calls.find((call) => call.method === '_agnes/v1/resources.list')?.params).toMatchObject(
        { profile, cursor: 'next' },
      )
      expect(
        endpoint.calls.find((call) => call.method === '_agnes/v1/mcp.servers.update')?.params,
      ).toMatchObject({ expectedRevision: revision, commandId: 'resource-command' })
      expect(
        endpoint.calls.find((call) => call.method === '_agnes/v1/mcp.servers.oauth.status')?.params,
      ).toMatchObject({ profile, serverId: 'example' })
      expect(
        endpoint.calls.find((call) => call.method === '_agnes/v1/mcp.servers.oauth.status.set')?.params,
      ).toMatchObject({ profile, serverId: 'example', status: 'authorized' })
    } finally {
      await client.close()
    }
  })
})
