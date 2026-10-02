import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { inlineData } from '../../src/runtime/maintenance/authority-publication.js'
import {
  createAuthorityDirectoryProvider,
  createDirectoryAnchor,
} from '../../src/runtime/providers/authority-directory.js'
import { createWorkspaceService } from '../../src/runtime/providers/workspace.js'
import { openWorkspaceStore } from '../../src/runtime/workspace-leases.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'workspace-lease-'))
  roots.push(root)
  return root
}

function scope(workspaceId: string): Wire.ScopeRef {
  return { kind: 'workspace', installationId: 'install-1', runtimeId: 'runtime-1', workspaceId }
}

function call(workspaceId: string, over: Partial<CallContext> = {}): CallContext {
  return {
    principalRef: 'actor',
    scope: scope(workspaceId),
    bindingId: 'binding-1',
    invocationId: `call-${Math.random().toString(16).slice(2)}`,
    deadline: '2030-01-01T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'auth-1',
    signal: new AbortController().signal,
    ...over,
  }
}

function detail(outcome: Outcome<unknown>): string {
  return outcome.ok ? 'ok' : outcome.error.detailCode
}

describe('workspace leases', () => {
  it('binds a directory, grants one exclusive writer, and releases only for the owner', async () => {
    const directory = scratch()
    const work = join(directory, 'work')
    const service = createWorkspaceService({
      directory: join(directory, 'store'),
      authorityId: 'authority-1',
      tenantId: 'tenant-1',
    })
    expect(detail(await service.bind('ws-1', work))).toBe('not_found')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    writeFileSync(join(directory, 'a-file'), 'x')
    expect(detail(await service.bind('ws-1', join(directory, 'a-file')))).toBe('invalid_request')
    mkdirSync(work)
    const ready = await service.bind('ws-1', work)
    expect(ready.ok && ready.value.revision).toBe(1)
    const acquired = await service.acquire(
      { workspaceId: 'ws-1', mode: 'write', expectedRevision: 1 },
      call('ws-1'),
    )
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return
    const reader = await service.acquire(
      { workspaceId: 'ws-1', mode: 'read', expectedRevision: null },
      call('ws-1'),
    )
    expect(detail(reader)).toBe('revision_conflict')
    const other = await service.release(
      { leaseRef: acquired.value.leaseRef },
      call('ws-1', { principalRef: 'other-actor' }),
    )
    expect(detail(other)).toBe('permission_denied')
    const released = await service.release({ leaseRef: acquired.value.leaseRef }, call('ws-1'))
    expect(released.ok && released.value.released).toBe(true)
    const again = await service.release({ leaseRef: acquired.value.leaseRef }, call('ws-1'))
    expect(again.ok && again.value.released).toBe(true)
    service.close()
    const closed = await service.acquire(
      { workspaceId: 'ws-1', mode: 'read', expectedRevision: null },
      call('ws-1'),
    )
    expect(detail(closed)).toBe('blocked')
    expect(ready.ok && ready.value.canonicalRoot.endsWith('work')).toBe(true)
  })

  it('keeps the first workspace id when a second id claims the same directory', async () => {
    const directory = scratch()
    const work = join(directory, 'work')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(work)
    const service = createWorkspaceService({
      directory: join(directory, 'store'),
      authorityId: 'authority-1',
      tenantId: 'tenant-1',
    })
    expect((await service.bind('ws-1', work)).ok).toBe(true)
    const conflict = await service.bind('ws-2', work)
    expect(detail(conflict)).toBe('revision_conflict')
    const still = await service.acquire(
      { workspaceId: 'ws-1', mode: 'read', expectedRevision: null },
      call('ws-1'),
    )
    expect(still.ok).toBe(true)
    service.close()
  })

  it('refuses a stale revision, a foreign tenant, a foreign scope, and a cancelled call', async () => {
    const directory = scratch()
    const work = join(directory, 'work')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(work)
    const store = openWorkspaceStore({ directory: join(directory, 'store'), now: () => 1_000 })
    const service = createWorkspaceService({
      store,
      authorityId: 'authority-1',
      tenantId: 'tenant-1',
      leaseMs: 50,
    })
    expect((await service.bind('ws-1', work)).ok).toBe(true)
    expect(
      detail(await service.acquire({ workspaceId: 'ws-1', mode: 'read', expectedRevision: 4 }, call('ws-1'))),
    ).toBe('revision_conflict')
    const otherTenant = createWorkspaceService({
      store,
      authorityId: 'authority-1',
      tenantId: 'tenant-2',
    })
    expect(
      detail(
        await otherTenant.acquire(
          { workspaceId: 'ws-1', mode: 'read', expectedRevision: null },
          call('ws-1'),
        ),
      ),
    ).toBe('permission_denied')
    expect(
      detail(
        await service.acquire({ workspaceId: 'ws-1', mode: 'read', expectedRevision: null }, call('ws-2')),
      ),
    ).toBe('permission_denied')
    const aborted = new AbortController()
    aborted.abort()
    const cancelled = await service.acquire(
      { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
      call('ws-1', { signal: aborted.signal }),
    )
    expect(detail(cancelled)).toBe('cancelled')
    const held = await service.acquire(
      { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
      call('ws-1'),
    )
    expect(held.ok).toBe(true)
    service.close()
    otherTenant.close()
  })

  it('reclaims an expired lease and leaves the work directory when one generation closes', async () => {
    const directory = scratch()
    const work = join(directory, 'work')
    const { mkdirSync, existsSync, writeFileSync } = await import('node:fs')
    mkdirSync(work)
    writeFileSync(join(work, 'notes.txt'), 'keep')
    let now = 5_000
    const store = openWorkspaceStore({ directory: join(directory, 'store'), now: () => now })
    const first = createWorkspaceService({
      store,
      authorityId: 'authority-1',
      tenantId: 'tenant-1',
      generation: 1,
      leaseMs: 100,
    })
    const second = createWorkspaceService({
      store,
      authorityId: 'authority-1',
      tenantId: 'tenant-1',
      generation: 2,
      leaseMs: 100,
    })
    expect((await first.bind('ws-1', work)).ok).toBe(true)
    const held = await first.acquire(
      { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
      call('ws-1'),
    )
    expect(held.ok).toBe(true)
    expect(
      detail(
        await second.acquire({ workspaceId: 'ws-1', mode: 'write', expectedRevision: null }, call('ws-1')),
      ),
    ).toBe('revision_conflict')
    if (!held.ok) return
    expect(detail(await second.release({ leaseRef: held.value.leaseRef }, call('ws-1')))).toBe(
      'permission_denied',
    )
    now = 5_100
    const reclaimed = await second.acquire(
      { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
      call('ws-1'),
    )
    expect(reclaimed.ok).toBe(true)
    first.close()
    expect(existsSync(join(work, 'notes.txt'))).toBe(true)
    expect(
      detail(
        await second.acquire({ workspaceId: 'ws-1', mode: 'read', expectedRevision: null }, call('ws-1')),
      ),
    ).toBe('revision_conflict')
    second.close()
    const reopened = createWorkspaceService({
      directory: join(directory, 'store'),
      authorityId: 'authority-1',
      tenantId: 'tenant-1',
    })
    const restored = await reopened.bind('ws-1', work)
    expect(restored.ok && restored.value.revision).toBe(1)
    reopened.close()
  })

  it('reads real deployment routes, rejects missing, foreign, or unavailable routes, and reopens durably', async () => {
    const directory = scratch()
    const { mkdirSync } = await import('node:fs')
    const maintenance = call('ws-1', {
      principalRef: 'deployer',
      scope: { kind: 'installation', installationId: 'install-1' },
    })
    const authority = { authorityId: 'directory-1', tenantId: 'tenant-1', authorityEpoch: 1 }
    const options = { directory: join(directory, 'routes'), anchor: join(directory, 'anchor'), authority }
    expect(
      createDirectoryAnchor(
        options.anchor,
        {
          directoryId: authority.authorityId,
          providerLockRef: inlineData({}, 'agh.directory/lock@1'),
          endpointRef: options.directory,
          epoch: 1,
          revision: 1,
          cutoverId: 'bootstrap',
        },
        maintenance.principalRef,
      ).ok,
    ).toBe(true)
    let routing = createAuthorityDirectoryProvider(options)
    const routes: Wire.AuthorityRoute[] = []
    for (const [id, tenant, location] of [
      ['ws-1', 'tenant-1', 'ws-1'],
      ['ws-2', 'tenant-1', 'elsewhere'],
      ['ws-3', 'other-tenant', 'ws-3'],
    ]) {
      const route: Wire.AuthorityRoute = {
        logicalAuthorityId: id!,
        tenantId: tenant!,
        authorityEpoch: 1,
        locationRef: location!,
        providerBinding: {
          bindingId: 'workspace-binding',
          contract: 'agh.workspace',
          logicalName: 'workspace',
          providerId: 'agh.default/workspace',
        },
        cohortDigest: canonicalJsonDigest({ workspace: id! }),
        cutoverId: 'seed-' + id,
        previous: null,
        checkpoint: {
          authorityId: id!,
          authorityEpoch: 1,
          checkpointId: 'checkpoint-' + id,
          snapshotDigest: canonicalJsonDigest({ workspace: id! }),
          recordCount: 1,
          bridgeWatermarks: [],
        },
      }
      expect((await routing.seedRoute(route, maintenance)).ok).toBe(true)
      routes.push(route)
    }
    const service = createWorkspaceService({
      directory: join(directory, 'store'),
      authorityId: 'authority-1',
      tenantId: 'tenant-1',
      directoryRead: { read: (request) => routing.read(request, maintenance) },
    })
    try {
      for (const id of ['ws-1', 'ws-2', 'ws-3', 'ws-4']) {
        const work = join(directory, id)
        mkdirSync(work)
        expect((await service.bind(id, work)).ok).toBe(true)
        expect(
          detail(await service.acquire({ workspaceId: id, mode: 'read', expectedRevision: null }, call(id))),
        ).toBe(id === 'ws-1' ? 'ok' : 'permission_denied')
      }
      const before = await routing.read({ kind: 'authority', logicalAuthorityId: 'ws-1' }, maintenance)
      await routing.dispose()
      expect(
        detail(
          await service.acquire({ workspaceId: 'ws-1', mode: 'read', expectedRevision: null }, call('ws-1')),
        ),
      ).toBe('permission_denied')
      routing = createAuthorityDirectoryProvider(options)
      expect(await routing.read({ kind: 'authority', logicalAuthorityId: 'ws-1' }, maintenance)).toEqual(
        before,
      )
      expect(
        detail(
          await service.acquire({ workspaceId: 'ws-1', mode: 'read', expectedRevision: null }, call('ws-1')),
        ),
      ).toBe('ok')
      // authority-directory-stand-in: isolate a rejected reader promise without corrupting live storage.
      const unavailable = createWorkspaceService({
        store: service.store,
        authorityId: 'authority-1',
        tenantId: 'tenant-1',
        directoryRead: {
          async read() {
            throw new Error('isolated directory outage')
          },
        },
      })
      expect(
        detail(
          await unavailable.acquire(
            { workspaceId: 'ws-1', mode: 'read', expectedRevision: null },
            call('ws-1'),
          ),
        ),
      ).toBe('permission_denied')
      unavailable.close()
      expect(detail(await service.authorityFence({}, call('ws-1')))).toBe('unsupported')
    } finally {
      service.close()
      await routing.dispose()
    }
  })
})
