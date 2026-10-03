import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Outcome } from '@agnes/extension-api/runtime'
import type { ResourceDescriptor, ResourceRef } from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import { createReferenceResources } from '../../../../examples/runtime-reference/src/providers/resources.js'
import {
  exerciseResourceCatalog,
  type ResourceCatalogContractBinding,
  resourceCatalogContext,
  resourceCatalogDescriptor,
  resourceCatalogFixtureInput,
} from '../../../extension-api/testkit/runtime/contracts/resources.js'
import { createResourcesService } from '../../src/runtime/providers/resources.js'
import { ResourceRetention } from '../../src/runtime/resource-retention.js'

const implementations = [
  { name: 'default' as const, create: createResourcesService },
  { name: 'reference' as const, create: createReferenceResources },
]
export const catalogTestBuild = {
  codeSha: 'a'.repeat(40),
  buildDigest: 'b'.repeat(64),
  lockDigest: 'c'.repeat(64),
  specVersion: 'fixture',
  sdkVersion: 'fixture',
  sdkDigest: 'd'.repeat(64),
  platform: 'fixture',
}
const refusal = (result: Outcome<unknown>) => (result.ok ? 'ok' : result.error.detailCode)

describe('parallel resource catalog contracts', () => {
  for (const impl of implementations) {
    it.each(['select', 'normal', 'deny', 'cancel', 'dispose'] as const)(
      `${impl.name} catalog %s`,
      async (scenario) => {
        const binding: ResourceCatalogContractBinding = {
          providerId: impl.name,
          providerDigest: 'e'.repeat(64),
          command: 'fixture',
          build: catalogTestBuild,
          create: impl.create,
          coldRead: async () => {
            throw new Error('cold recovery belongs to the heavy tier')
          },
        }
        await exerciseResourceCatalog(binding, scenario)
      },
    )
  }

  it('returns identical results and refusal codes, filters current permission, and triggers discovery without a Loop', async () => {
    const traces: unknown[][] = []
    for (const impl of implementations) {
      const directory = mkdtempSync(join(tmpdir(), 'resource-cross-'))
      const options = resourceCatalogFixtureInput(directory)
      const events: string[] = []
      let revoked = false,
        ready = true,
        valid = true
      options.authorize = (_method, d, ctx) =>
        ctx.principalRef === 'fixture-principal' && d?.id !== 'private' && !revoked
      options.contributionReady = () => ready
      options.schemaAvailable = () => valid
      options.discover = async (event, resources) => {
        events.push(event)
        expect(resources.some((d) => d.id === 'private')).toBe(false)
      }
      const service = impl.create(options)
      const call = (method: string, data: unknown) => service.call(method, data, resourceCatalogContext())
      const trace: unknown[] = []
      try {
        trace.push(
          await call('register', {
            descriptor: resourceCatalogDescriptor(),
            ownerReleaseSetId: 'fixture-release',
          }),
        )
        options.authorize = () => true
        trace.push(
          await call('register', {
            descriptor: resourceCatalogDescriptor('private'),
            ownerReleaseSetId: 'fixture-release',
          }),
        )
        options.authorize = (_method, d) => d?.id !== 'private' && !revoked
        const query = {
          kind: 'skill',
          filter: { tags: ['review'], namespace: 'fixture' },
          cursor: null,
          limit: 2,
        }
        const result = await call('list', query)
        trace.push(result)
        expect(result).toMatchObject({ ok: true, value: { items: [{ id: 'review' }], complete: true } })
        const disclosed = await call('describe', { resourceId: 'review', version: '1' })
        trace.push(disclosed)
        if (disclosed.ok) (disclosed.value as ResourceDescriptor).tags.push('caller-mutation')
        trace.push(await call('describe', { resourceId: 'review', version: '1' }))
        expect(events).toEqual(['resources_discover', 'resources_discover', 'resources_discover'])
        ready = false
        trace.push(await call('describe', { resourceId: 'review', version: null }))
        expect(refusal(trace.at(-1) as Outcome<unknown>)).toBe('resources_not_ready')
        ready = true
        valid = false
        trace.push(await call('describe', { resourceId: 'review', version: null }))
        expect(refusal(trace.at(-1) as Outcome<unknown>)).toBe('resources_schema_stale')
        valid = true
        options.discover = async () => {
          revoked = true
        }
        trace.push(await call('describe', { resourceId: 'review', version: null }))
        expect(refusal(trace.at(-1) as Outcome<unknown>)).toBe('resources_denied')
        trace.push(
          await service.call('list', query, {
            ...resourceCatalogContext(),
            scope: {
              kind: 'workspace',
              installationId: 'fixture-installation',
              runtimeId: 'fixture-runtime',
              workspaceId: 'foreign',
            },
          }),
        )
        expect(refusal(trace.at(-1) as Outcome<unknown>)).toBe('resources_scope')
        trace.push(await call('call', {}))
        trace.push(await call('list', { ...query, unexpected: true }))
        traces.push(trace)
      } finally {
        service.close()
        rmSync(directory, { recursive: true, force: true })
      }
    }
    expect(traces[0]).toEqual(traces[1])
  })

  it('invalidates discovery when a Hook changes the catalog, and denies an unavailable authorizer', async () => {
    for (const impl of implementations) {
      const directory = mkdtempSync(join(tmpdir(), 'resource-race-'))
      const options = resourceCatalogFixtureInput(directory)
      const service = impl.create(options)
      try {
        await service.call(
          'register',
          { descriptor: resourceCatalogDescriptor(), ownerReleaseSetId: 'fixture-release' },
          resourceCatalogContext(),
        )
        options.discover = async () => {
          await service.call(
            'register',
            { descriptor: resourceCatalogDescriptor('other'), ownerReleaseSetId: 'fixture-release' },
            resourceCatalogContext(),
          )
        }
        expect(
          refusal(
            await service.call(
              'list',
              { kind: 'skill', filter: {}, cursor: null, limit: 2 },
              resourceCatalogContext(),
            ),
          ),
        ).toBe('resources_snapshot_stale')
        options.authorize = () => {
          throw new Error('authority offline')
        }
        expect(
          refusal(
            await service.call('describe', { resourceId: 'review', version: null }, resourceCatalogContext()),
          ),
        ).toBe('resources_dependency_unavailable')
        options.authorize = () => true
        options.discover = async () => {
          await new Promise<void>(() => {})
        }
        vi.useFakeTimers()
        try {
          const context = {
            ...resourceCatalogContext(),
            deadline: new Date(Date.now() + 1_000).toISOString(),
          }
          const expired = service.call('list', { kind: 'skill', filter: {}, cursor: null, limit: 2 }, context)
          await vi.advanceTimersByTimeAsync(1_001)
          expect(refusal(await expired)).toBe('resources_cancelled')
        } finally {
          vi.useRealTimers()
        }
        const closing = service.call(
          'list',
          { kind: 'skill', filter: {}, cursor: null, limit: 2 },
          resourceCatalogContext(),
        )
        service.close()
        expect(refusal(await closing)).toBe('resources_closed')
      } finally {
        service.close()
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })
})

describe('process-local resource ownership', () => {
  const ref: ResourceRef = { resourceId: 'old-connection', version: '1', digest: 'a'.repeat(64) }
  it('keeps the retired generation until the last owner exits, with idempotent retain and release', async () => {
    const ledger = new ResourceRetention(),
      disposed: string[] = []
    ledger.track(ref, () => {
      disposed.push('old')
    })
    expect(ledger.retain(ref, 'run-old', 'first')).toBe(true)
    expect(ledger.retain(ref, 'run-old', 'first')).toBe(false)
    ledger.retain(ref, 'job-old', 'second')
    expect(ledger.count(ref)).toBe(2)
    await ledger.retire(ref)
    expect(() => ledger.retain(ref, 'run-new', 'new')).toThrow('retention_unavailable')
    const fresh = { ...ref, version: '2', digest: 'b'.repeat(64) }
    ledger.track(fresh, () => {
      disposed.push('new')
    })
    ledger.retain(fresh, 'run-new', 'fresh')
    await ledger.ownerExit('run-old')
    expect(ledger.count(ref)).toBe(1)
    expect(disposed).toEqual([])
    expect(await ledger.release(ref, 'run-old', 'first')).toBe(false)
    await expect(ledger.release(ref, 'intruder', 'second')).rejects.toThrow('retention_identity_conflict')
    expect(() => ledger.retain(fresh, 'run-new', 'second')).toThrow('retention_identity_conflict')
    await ledger.close()
    expect(disposed).toEqual([])
    await Promise.all([ledger.ownerExit('job-old'), ledger.ownerExit('job-old')])
    expect(disposed).toEqual(['old'])
    await ledger.ownerExit('run-new')
    expect(disposed).toEqual(['old', 'new'])
    await ledger.close()
    expect(disposed).toEqual(['old', 'new'])
    expect(() => ledger.retain(ref, 'run-old', 'first')).toThrow('retention_released')
  })
  it('preserves disposal failure for a retry and refuses unknown release tokens', async () => {
    const ledger = new ResourceRetention()
    let available = false,
      disposed = false,
      otherDisposed = false
    ledger.track(ref, () => {
      if (!available) throw new Error('dispose failed')
      disposed = true
    })
    await expect(ledger.release(ref, 'owner', 'unknown')).rejects.toThrow('retention_unknown_token')
    await expect(ledger.retire(ref)).rejects.toThrow('dispose failed')
    expect(disposed).toBe(false)
    available = true
    await ledger.retire(ref)
    expect(disposed).toBe(true)
    const failing = { ...ref, version: '2' },
      other = { ...ref, version: '3' }
    let retryReady = false,
      retried = false
    ledger.track(failing, () => {
      if (!retryReady) throw new Error('another disposal failed')
      retried = true
    })
    ledger.track(other, () => {
      otherDisposed = true
    })
    ledger.retain(failing, 'owner', 'failing')
    ledger.retain(other, 'owner', 'other')
    await ledger.retire(failing)
    await ledger.retire(other)
    await expect(ledger.ownerExit('owner')).rejects.toThrow('retention_dispose_failed')
    expect(otherDisposed).toBe(true)
    expect(ledger.count(failing)).toBe(0)
    expect(ledger.count(other)).toBe(0)
    retryReady = true
    await ledger.ownerExit('owner')
    expect(retried).toBe(true)
  })
})
