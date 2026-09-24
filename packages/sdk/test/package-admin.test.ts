import { describe, expect, it, vi } from 'vitest'
import { createClient } from '../src/index.node.js'
import { memoryJournal } from '../src/journal.js'
import { fakeEndpoint } from './helpers/fake-endpoint.js'

const profile = 'local-dev'
const source = { type: 'npm' as const, ref: 'npm:example@1.0.0' }
const integrity = `sha256-${'a'.repeat(64)}`
const receipt = { operationId: 'op-1', profile }
const preview = {
  id: 'example',
  version: '1.0.0',
  source,
  integrity,
  license: 'MIT',
  provenance: { source, integrity, signatureVerified: false },
  contributions: [],
  capabilityDiff: {
    added: [],
    removed: [],
    runtimeSupportRemoved: [],
    dependenciesAdded: [],
    serviceGrantsAdded: [],
  },
  dependencies: {},
  warnings: [],
  blockers: [],
}

function operation(state: 'received' | 'installing' | 'completed') {
  return {
    operationId: 'op-1',
    profile,
    operation: 'install' as const,
    state,
    progress: state === 'completed' ? 100 : 1,
    startedAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...(state === 'completed'
      ? {
          installed: {
            id: 'example',
            version: '1.0.0',
            source,
            integrity,
            trusted: false,
            desired: 'installed-disabled' as const,
            actual: 'not-running' as const,
            contributions: [],
            blockers: [],
          },
        }
      : {}),
  }
}

describe('Node package admin client', () => {
  it('maps every catalog and package operation to its frozen protocol method', async () => {
    const endpoint = fakeEndpoint({
      initialize: fakeEndpoint({}).initialize,
      '_agnes/v1/packages.catalog.list': () => ({ items: [], nextCursor: null }),
      '_agnes/v1/packages.catalog.get': () => ({
        id: 'example',
        version: '1.0.0',
        source,
        integrity,
        license: 'MIT',
        contributions: [],
        compatibility: 'supported',
        sourceId: 'curated',
        retrievedAt: '2026-09-13T00:00:00.000Z',
      }),
      '_agnes/v1/packages.list': () => ({ packages: [] }),
      '_agnes/v1/packages.inspect': () => receipt,
      '_agnes/v1/packages.install': () => receipt,
      '_agnes/v1/packages.trust': () => receipt,
      '_agnes/v1/packages.untrust': () => receipt,
      '_agnes/v1/packages.enable': () => receipt,
      '_agnes/v1/packages.disable': () => receipt,
      '_agnes/v1/packages.update': () => receipt,
      '_agnes/v1/packages.rollback': () => receipt,
      '_agnes/v1/packages.remove': () => receipt,
      '_agnes/v1/packages.operation.get': () => ({ ...operation('completed'), preview }),
      '_agnes/v1/packages.operation.cancel': () => receipt,
    })
    const client = createClient({
      transport: { kind: 'inproc', endpoint: endpoint.endpoint },
      journal: memoryJournal('sdk-admin'),
    })
    try {
      await client.packages.catalog.list({ profile })
      await client.packages.catalog.get({ profile, id: 'example' })
      await client.packages.list({ profile })
      await client.packages.inspect({ profile, clientId: 'sdk-admin', commandId: 'inspect-1', source })
      await client.packages.install({
        profile,
        clientId: 'sdk-admin',
        commandId: 'install-1',
        source,
        expectedIntegrity: integrity,
      })
      await client.packages.trust({
        profile,
        clientId: 'sdk-admin',
        commandId: 'trust-1',
        id: 'example',
        expectedIntegrity: integrity,
        capabilityHash: 'b'.repeat(64),
      })
      await client.packages.untrust({
        profile,
        clientId: 'sdk-admin',
        commandId: 'untrust-1',
        id: 'example',
        expectedIntegrity: integrity,
        capabilityHash: 'b'.repeat(64),
      })
      await client.packages.enable({
        profile,
        clientId: 'sdk-admin',
        commandId: 'enable-1',
        id: 'example',
        expectedInstalledIntegrity: integrity,
        expectedActiveIntegrity: null,
      })
      await client.packages.disable({ profile, clientId: 'sdk-admin', commandId: 'disable-1', id: 'example' })
      await client.packages.update({
        profile,
        clientId: 'sdk-admin',
        commandId: 'update-1',
        id: 'example',
        source,
        expectedIntegrity: integrity,
        activation: {
          expectedInstalledIntegrity: integrity,
          expectedActiveIntegrity: null,
          trust: { integrity, capabilityHash: 'b'.repeat(64) },
        },
      })
      await client.packages.rollback({
        profile,
        clientId: 'sdk-admin',
        commandId: 'rollback-1',
        id: 'example',
        expectedTargetIntegrity: integrity,
        activation: {
          expectedInstalledIntegrity: integrity,
          expectedActiveIntegrity: null,
          trust: { integrity, capabilityHash: 'b'.repeat(64) },
        },
      })
      await client.packages.remove({ profile, clientId: 'sdk-admin', commandId: 'remove-1', id: 'example' })
      await client.packages.operation.get({ profile, operationId: 'op-1' })
      await client.packages.operation.cancel({
        profile,
        clientId: 'sdk-admin',
        commandId: 'cancel-1',
        operationId: 'op-1',
      })
      expect(endpoint.calls.map((call) => call.method)).toEqual([
        'initialize',
        '_agnes/v1/packages.catalog.list',
        '_agnes/v1/packages.catalog.get',
        '_agnes/v1/packages.list',
        '_agnes/v1/packages.inspect',
        '_agnes/v1/packages.install',
        '_agnes/v1/packages.trust',
        '_agnes/v1/packages.untrust',
        '_agnes/v1/packages.enable',
        '_agnes/v1/packages.disable',
        '_agnes/v1/packages.update',
        '_agnes/v1/packages.rollback',
        '_agnes/v1/packages.remove',
        '_agnes/v1/packages.operation.get',
        '_agnes/v1/packages.operation.cancel',
      ])
      expect(
        endpoint.calls.find((call) => call.method === '_agnes/v1/packages.update')?.params,
      ).toMatchObject({
        activation: {
          expectedInstalledIntegrity: integrity,
          expectedActiveIntegrity: null,
          trust: { integrity, capabilityHash: 'b'.repeat(64) },
        },
      })
    } finally {
      await client.close()
    }
  })

  it('recovers progress through operation.get and stops polling at a terminal state', async () => {
    vi.useFakeTimers()
    let reads = 0
    const endpoint = fakeEndpoint({
      initialize: fakeEndpoint({}).initialize,
      '_agnes/v1/packages.operation.get': () => operation(++reads === 1 ? 'installing' : 'completed'),
    })
    const client = createClient({
      transport: { kind: 'inproc', endpoint: endpoint.endpoint },
      journal: memoryJournal(),
    })
    try {
      const states: string[] = []
      await client.packages.operation.subscribe(
        { profile, operationId: 'op-1' },
        (next) => states.push(next.state),
        {
          intervalMs: 50,
        },
      )
      await vi.advanceTimersByTimeAsync(50)
      expect(states).toEqual(['installing', 'completed'])
      await vi.advanceTimersByTimeAsync(500)
      expect(reads).toBe(2)
    } finally {
      await client.close()
      vi.useRealTimers()
    }
  })
})
