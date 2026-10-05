import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type { DataRef, ResourceDescriptor, ResourceRef, RetentionRef } from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import { createReferenceResources } from '../../../../examples/runtime-reference/src/providers/resources.js'
import { upgradeAssemblyFixture } from '../../../extension-api/testkit/runtime/contracts/assembly-publish.js'
import {
  exerciseResourceCatalog,
  type ResourceCatalogContractBinding,
  resourceCatalogContext,
  resourceCatalogDescriptor,
  resourceCatalogFixtureInput,
} from '../../../extension-api/testkit/runtime/contracts/resources.js'
import { releaseSnapshot } from '../../src/runtime/assembly/maintenance-journal.js'
import { createResourcesService } from '../../src/runtime/providers/resources.js'
import { ResourceRetention } from '../../src/runtime/resource-retention.js'
import {
  maintenanceFixtureRecord,
  maintenancePayload,
  persistentAssemblyFixture,
} from './fixtures/assembly-maintenance.js'

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

function resourceRef(descriptor: ResourceDescriptor) {
  return {
    kind: 'resource' as const,
    value: { resourceId: descriptor.id, version: descriptor.version, digest: descriptor.digest },
  }
}
function pinIdentity(descriptor: ResourceDescriptor, purpose: string) {
  return `rp-${canonicalJsonDigest({
    digest: descriptor.digest,
    ownerId: 'fixture-principal',
    purpose,
    resourceId: descriptor.id,
    version: descriptor.version,
  })}`
}
function retainedRef(descriptor: ResourceDescriptor, purpose: string): RetentionRef {
  return {
    kind: 'domain-record',
    authorityId: 'agh.resources',
    resourceId: descriptor.id,
    version: descriptor.version,
    digest: descriptor.digest,
    pinId: pinIdentity(descriptor, purpose),
  }
}
function pauseGate() {
  let opened!: () => void
  let resume!: () => void
  const entered = new Promise<void>((resolve) => {
    opened = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    resume = resolve
  })
  return {
    entered,
    resume,
    gate: async () => {
      opened()
      await blocked
    },
  }
}
function packageReceipt(pin: { pinId: string; releaseSetId: string; ownerId: string }): DataRef {
  const value = { pinId: pin.pinId, releaseSetId: pin.releaseSetId, ownerId: pin.ownerId, status: 'active' }
  return {
    kind: 'inline',
    schema: {
      typeId: 'agh.assembly/package-pin-receipt@1',
      revision: 1,
      digest: canonicalJsonDigest(value),
    },
    value,
    digest: canonicalJsonDigest(value),
    bytes: Buffer.byteLength(JSON.stringify(value)),
  }
}
const ledgerError = (detailCode: string): Outcome<never> => ({
  ok: false,
  error: {
    code: 'incompatible',
    detailCode,
    message: 'Synthetic package pin refused',
    diagnosticId: 'resource-pin-fixture',
    retryAdvice: { kind: 'never' },
  },
})
function runtimeCaller(context: CallContext): CallContext {
  if (context.scope.kind !== 'workspace') return context
  return {
    ...context,
    scope: {
      kind: 'runtime',
      installationId: context.scope.installationId,
      runtimeId: context.scope.runtimeId,
    },
  }
}

describe('durable resource pins', () => {
  it('returns the same first pin, replay, and release refusal from both catalogs', async () => {
    const traces: unknown[][] = []
    for (const impl of implementations) {
      const directory = mkdtempSync(join(tmpdir(), 'resource-pin-cross-'))
      const service = impl.create(resourceCatalogFixtureInput(directory))
      const descriptor = resourceCatalogDescriptor()
      const call = (method: string, data: unknown) => service.call(method, data, resourceCatalogContext())
      const trace: unknown[] = []
      try {
        trace.push(await call('register', { descriptor, ownerReleaseSetId: 'fixture-release' }))
        trace.push(await call('list', { kind: 'skill', filter: {}, cursor: null, limit: 10 }))
        const retained = await call('retain', { resource: resourceRef(descriptor), purpose: 'artifact' })
        trace.push(retained)
        trace.push(await call('retain', { resource: resourceRef(descriptor), purpose: 'artifact' }))
        trace.push(await call('retain', { resource: resourceRef(descriptor), purpose: 'history' }))
        if (!retained.ok) throw new Error(refusal(retained))
        trace.push(await call('release', { retention: retained.value, reason: 'artifact kept' }))
        trace.push(await call('release', { retention: retained.value, reason: 'other reason' }))
        trace.push(await call('release', { retention: retained.value, reason: 'artifact kept' }))
        traces.push(trace)
      } finally {
        service.close()
        rmSync(directory, { recursive: true, force: true })
      }
    }
    expect(traces[0]).toEqual(traces[1])
    expect(traces[0]?.[2]).toMatchObject({
      ok: true,
      value: { version: '1', kind: 'domain-record', authorityId: 'agh.resources' },
    })
    expect(traces[0]?.[5]).toMatchObject({ ok: true, value: { state: 'released' } })
    expect(refusal(traces[0]?.[6] as Outcome<unknown>)).toBe('resources_release_conflict')
  })

  it('refuses the first retain and stores nothing when the row or grant changes first', async () => {
    for (const impl of implementations) {
      for (const change of ['remove', 'replace', 'revoke'] as const) {
        const directory = mkdtempSync(join(tmpdir(), 'resource-pin-before-'))
        const options = resourceCatalogFixtureInput(directory)
        const service = impl.create(options)
        const descriptor = resourceCatalogDescriptor()
        const call = (method: string, data: unknown) => service.call(method, data, resourceCatalogContext())
        try {
          expect((await call('register', { descriptor, ownerReleaseSetId: 'fixture-release' })).ok).toBe(true)
          expect((await call('describe', { resourceId: descriptor.id, version: '1' })).ok).toBe(true)
          if (change === 'remove') {
            expect((await call('remove', { id: descriptor.id, expectedRevision: 1 })).ok).toBe(true)
          } else if (change === 'replace') {
            expect(
              (
                await call('register', {
                  descriptor: { ...descriptor, version: '2' },
                  ownerReleaseSetId: 'fixture-release',
                })
              ).ok,
            ).toBe(true)
          } else options.authorize = () => false
          expect(refusal(await call('retain', { resource: resourceRef(descriptor), purpose: 'job' }))).toBe(
            change === 'remove'
              ? 'resources_not_found'
              : change === 'replace'
                ? 'resources_version_stale'
                : 'resources_denied',
          )
          options.authorize = () => true
          expect(
            refusal(await call('release', { retention: retainedRef(descriptor, 'job'), reason: 'absent' })),
          ).toBe('resources_pin_unknown')
        } finally {
          service.close()
          rmSync(directory, { recursive: true, force: true })
        }
      }
    }
  })

  it('keeps the original version when removal, replacement, or revocation lands after the pending pin', async () => {
    for (const impl of implementations) {
      for (const change of ['remove', 'replace', 'revoke'] as const) {
        const directory = mkdtempSync(join(tmpdir(), 'resource-pin-during-'))
        const paused = pauseGate()
        const options = {
          ...resourceCatalogFixtureInput(directory),
          pinGate: paused.gate,
          holdPin: paused.gate,
        }
        const service = impl.create(options)
        const descriptor = resourceCatalogDescriptor()
        const call = (method: string, data: unknown) => service.call(method, data, resourceCatalogContext())
        try {
          expect((await call('register', { descriptor, ownerReleaseSetId: 'fixture-release' })).ok).toBe(true)
          expect((await call('describe', { resourceId: descriptor.id, version: '1' })).ok).toBe(true)
          const pending = call('retain', { resource: resourceRef(descriptor), purpose: 'continuation' })
          await paused.entered
          if (change === 'remove') {
            expect((await call('remove', { id: descriptor.id, expectedRevision: 1 })).ok).toBe(true)
          } else if (change === 'replace') {
            expect(
              (
                await call('register', {
                  descriptor: { ...descriptor, version: '2' },
                  ownerReleaseSetId: 'fixture-release',
                })
              ).ok,
            ).toBe(true)
          } else options.authorize = () => false
          paused.resume()
          const retained = await pending
          expect(retained.ok, JSON.stringify(retained)).toBe(true)
          if (!retained.ok) throw new Error(retained.error.detailCode)
          expect(retained.value).toMatchObject({
            kind: 'domain-record',
            authorityId: 'agh.resources',
            resourceId: descriptor.id,
            version: '1',
            digest: descriptor.digest,
          })
          options.authorize = () => true
          if (change === 'remove') {
            expect(refusal(await call('describe', { resourceId: descriptor.id, version: null }))).toBe(
              'resources_not_found',
            )
          }
          if (change === 'replace') {
            expect(refusal(await call('describe', { resourceId: descriptor.id, version: '1' }))).toBe(
              'resources_version_stale',
            )
          }
          expect(await call('release', { retention: retained.value, reason: 'race finished' })).toMatchObject(
            { ok: true, value: { state: 'released' } },
          )
        } finally {
          paused.resume()
          service.close()
          rmSync(directory, { recursive: true, force: true })
        }
      }
    }
  })

  it('confirms a pending pin on the next retain after confirmation is interrupted', async () => {
    for (const impl of implementations) {
      const directory = mkdtempSync(join(tmpdir(), 'resource-pin-uncertain-'))
      const gate = async () => {
        throw new Error('confirmation interrupted')
      }
      const service = impl.create({
        ...resourceCatalogFixtureInput(directory),
        pinGate: gate,
        holdPin: gate,
      })
      const descriptor = resourceCatalogDescriptor()
      const call = (method: string, data: unknown) => service.call(method, data, resourceCatalogContext())
      try {
        expect((await call('register', { descriptor, ownerReleaseSetId: 'fixture-release' })).ok).toBe(true)
        expect((await call('describe', { resourceId: descriptor.id, version: '1' })).ok).toBe(true)
        expect(
          refusal(await call('retain', { resource: resourceRef(descriptor), purpose: 'continuation' })),
        ).toBe('resources_dependency_unavailable')
        const retained = await call('retain', { resource: resourceRef(descriptor), purpose: 'continuation' })
        expect(retained.ok, JSON.stringify(retained)).toBe(true)
        if (!retained.ok) throw new Error(retained.error.detailCode)
        expect(retained.value).toMatchObject({ version: descriptor.version, digest: descriptor.digest })
        expect(await call('release', { retention: retained.value, reason: 'recovered' })).toMatchObject({
          ok: true,
          value: { state: 'released' },
        })
      } finally {
        service.close()
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })

  it('keeps a reference pin while its external ledger still names it or cannot be read', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resource-pin-ledger-'))
    const live: DataRef[] = []
    let rejectKeep = false
    let failKeep = false
    const service = createReferenceResources({
      ...resourceCatalogFixtureInput(directory),
      externalLedger: {
        async keep(pin) {
          if (failKeep) throw new Error('ledger down')
          if (rejectKeep) return ledgerError('release_route_unavailable')
          const receipt = packageReceipt(pin)
          live.push(receipt)
          return { ok: true, value: receipt }
        },
        async current() {
          return { ok: true, value: live.slice() }
        },
      },
    })
    const descriptor = resourceCatalogDescriptor()
    const call = (method: string, data: unknown) => service.call(method, data, resourceCatalogContext())
    try {
      expect((await call('register', { descriptor, ownerReleaseSetId: 'fixture-release' })).ok).toBe(true)
      expect((await call('list', { kind: 'skill', filter: {}, cursor: null, limit: 10 })).ok).toBe(true)
      const retained = await call('retain', { resource: resourceRef(descriptor), purpose: 'continuation' })
      expect(retained.ok, JSON.stringify(retained)).toBe(true)
      if (!retained.ok) throw new Error(retained.error.detailCode)
      expect(await call('release', { retention: retained.value, reason: 'still listed' })).toMatchObject({
        ok: true,
        value: { state: 'release-pending' },
      })
      live.splice(0, live.length)
      expect(await call('release', { retention: retained.value, reason: 'still listed' })).toMatchObject({
        ok: true,
        value: { state: 'released' },
      })
      rejectKeep = true
      expect(
        refusal(await call('retain', { resource: resourceRef(descriptor), purpose: 'continuation' })),
      ).toBe('resources_package_pin_rejected')
      expect(
        refusal(
          await call('release', { retention: retainedRef(descriptor, 'continuation'), reason: 'absent' }),
        ),
      ).toBe('resources_pin_unknown')
      rejectKeep = false
      failKeep = true
      expect(
        refusal(await call('retain', { resource: resourceRef(descriptor), purpose: 'continuation' })),
      ).toBe('resources_pin_uncertain')
      const recovered = await call('retain', { resource: resourceRef(descriptor), purpose: 'continuation' })
      expect(recovered.ok, JSON.stringify(recovered)).toBe(true)
      if (!recovered.ok) throw new Error(recovered.error.detailCode)
      expect(await call('release', { retention: recovered.value, reason: 'uncertain ledger' })).toMatchObject(
        {
          ok: true,
          value: { state: 'release-pending' },
        },
      )
    } finally {
      service.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  // Full publication validation plus durable pin writes exceeded 5s on hosted Linux.
  it('binds a resource pin to the published release and stores nothing when that bind is refused', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resource-package-pin-'))
    const input = upgradeAssemblyFixture()
    const release = input.plan.targetReleaseSet
    const fixture = await persistentAssemblyFixture(input, join(directory, 'maintenance.sqlite'), {
      lifecycle: false,
    })
    const admit = fixture.ports.authorize.bind(fixture.ports)
    fixture.ports.authorize = async (context, plan) => {
      if (
        context.scope.kind === 'workspace' &&
        context.principalRef === 'fixture-principal' &&
        context.authorizationRef === 'fixture-authorization' &&
        plan === null
      )
        return true
      return admit(context, plan)
    }
    const store = fixture.ports.store
    fixture.ports.store = {
      query: (request, context) => store.query(request, runtimeCaller(context)),
      commit: (request, context) => store.commit(request, runtimeCaller(context)),
    }
    try {
      const missing = createResourcesService({
        ...resourceCatalogFixtureInput(join(directory, 'missing')),
        maintenance: fixture.ports,
      })
      const missingDescriptor = resourceCatalogDescriptor('missing-pin')
      const missingCall = (method: string, data: unknown) =>
        missing.call(method, data, resourceCatalogContext())
      expect(
        (
          await missingCall('register', {
            descriptor: missingDescriptor,
            ownerReleaseSetId: 'fixture-release',
          })
        ).ok,
      ).toBe(true)
      expect((await missingCall('describe', { resourceId: missingDescriptor.id, version: '1' })).ok).toBe(
        true,
      )
      expect(
        refusal(
          await missingCall('retain', { resource: resourceRef(missingDescriptor), purpose: 'continuation' }),
        ),
      ).toBe('resources_package_pin_rejected')
      expect(
        refusal(
          await missingCall('release', {
            retention: retainedRef(missingDescriptor, 'continuation'),
            reason: 'absent',
          }),
        ),
      ).toBe('resources_pin_unknown')
      expect(fixture.database.inspect().records.some((row) => row.recordId.startsWith('pin:'))).toBe(false)
      missing.close()

      fixture.database.seed(
        maintenanceFixtureRecord(
          `release:${release.releaseSetId}`,
          'release-snapshot',
          releaseSnapshot(release),
        ),
      )
      const paused = pauseGate()
      const service = createResourcesService({
        ...resourceCatalogFixtureInput(join(directory, 'bound')),
        contributionReady: (_resource, id) => id === release.releaseSetId,
        maintenance: fixture.ports,
        pinGate: paused.gate,
      })
      const descriptor = resourceCatalogDescriptor('pinned-skill')
      const call = (method: string, data: unknown) => service.call(method, data, resourceCatalogContext())
      try {
        expect((await call('register', { descriptor, ownerReleaseSetId: release.releaseSetId })).ok).toBe(
          true,
        )
        expect((await call('describe', { resourceId: descriptor.id, version: '1' })).ok).toBe(true)
        const pending = call('retain', { resource: resourceRef(descriptor), purpose: 'continuation' })
        await paused.entered
        expect((await call('remove', { id: descriptor.id, expectedRevision: 1 })).ok).toBe(true)
        paused.resume()
        const retained = await pending
        expect(retained.ok, JSON.stringify(retained)).toBe(true)
        if (!retained.ok) throw new Error(retained.error.detailCode)
        const pin = retained.value as RetentionRef
        expect(pin).toMatchObject({ version: '1', digest: descriptor.digest })
        const stored = fixture.database.get(`pin:${pin.pinId}`)
        expect(maintenancePayload(stored ?? undefined)).toMatchObject({
          pinId: pin.pinId,
          ownerId: 'fixture-principal',
          ownerKind: 'action',
          releaseSetId: release.releaseSetId,
          status: 'active',
          scope: { kind: 'workspace', workspaceId: 'fixture-workspace' },
        })
        expect(refusal(await call('describe', { resourceId: descriptor.id, version: null }))).toBe(
          'resources_not_found',
        )
        expect(await call('release', { retention: pin, reason: 'package still active' })).toMatchObject({
          ok: true,
          value: { state: 'release-pending' },
        })
        expect(maintenancePayload(fixture.database.get(`pin:${pin.pinId}`) ?? undefined)).toMatchObject({
          status: 'active',
        })
        const other = resourceCatalogDescriptor('gone')
        expect(
          (await call('register', { descriptor: other, ownerReleaseSetId: release.releaseSetId })).ok,
        ).toBe(true)
        expect((await call('describe', { resourceId: other.id, version: '1' })).ok).toBe(true)
        expect((await call('remove', { id: other.id, expectedRevision: 3 })).ok).toBe(true)
        expect(refusal(await call('retain', { resource: resourceRef(other), purpose: 'job' }))).toBe(
          'resources_not_found',
        )
        expect(fixture.database.get(`pin:${pinIdentity(other, 'job')}`)).toBeNull()
      } finally {
        paused.resume()
        service.close()
      }
    } finally {
      await fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 15_000)
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
