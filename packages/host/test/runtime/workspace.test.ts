import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspaceService } from '../../src/runtime/providers/workspace.js'
import { openWorkspaceStore, runtimeError } from '../../src/runtime/workspace-leases.js'

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

  it('honors a directory stand-in and reports authority transfer as unsupported', async () => {
    const directory = scratch()
    const work = join(directory, 'work')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(work)
    const locations = new Map<string, string | 'missing' | 'down'>([
      ['ws-1', 'ws-1'],
      ['ws-2', 'elsewhere'],
      ['ws-3', 'missing'],
      ['ws-4', 'down'],
    ])
    const service = createWorkspaceService({
      directory: join(directory, 'store'),
      authorityId: 'authority-1',
      tenantId: 'tenant-1',
      directoryRead: {
        async read(request) {
          if (request.kind !== 'authority') return { ok: false, error: runtimeError('not_found', 'absent') }
          const location = locations.get(request.logicalAuthorityId)
          if (location === 'missing' || location === undefined)
            return { ok: false, error: runtimeError('not_found', 'absent') }
          if (location === 'down')
            return { ok: false, error: runtimeError('blocked', 'directory unavailable') }
          return {
            ok: true,
            value: {
              kind: 'authority',
              route: { locationRef: location },
            } as Wire.AuthorityDirectoryReadResult,
          }
        },
      },
    })
    expect((await service.bind('ws-1', work)).ok).toBe(true)
    expect((await service.bind('ws-2', join(directory, 'other'))).ok).toBe(false)
    const { mkdirSync: mkdir } = await import('node:fs')
    mkdir(join(directory, 'other'))
    expect((await service.bind('ws-2', join(directory, 'other'))).ok).toBe(true)
    expect((await service.bind('ws-3', join(directory, 'third'))).ok).toBe(false)
    mkdir(join(directory, 'third'))
    expect((await service.bind('ws-3', join(directory, 'third'))).ok).toBe(true)
    expect(
      detail(
        await service.acquire({ workspaceId: 'ws-1', mode: 'read', expectedRevision: null }, call('ws-1')),
      ),
    ).toBe('ok')
    expect(
      detail(
        await service.acquire({ workspaceId: 'ws-2', mode: 'read', expectedRevision: null }, call('ws-2')),
      ),
    ).toBe('permission_denied')
    expect(
      detail(
        await service.acquire({ workspaceId: 'ws-3', mode: 'read', expectedRevision: null }, call('ws-3')),
      ),
    ).toBe('ok')
    expect(
      detail(
        await service.acquire({ workspaceId: 'ws-4', mode: 'read', expectedRevision: null }, call('ws-4')),
      ),
    ).toBe('permission_denied')
    expect(detail(await service.authorityFence({}, call('ws-1')))).toBe('unsupported')
    service.close()
  })
})
