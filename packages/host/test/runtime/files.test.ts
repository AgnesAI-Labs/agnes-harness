import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFilesService } from '../../src/runtime/providers/files.js'
import { createWorkspaceService } from '../../src/runtime/providers/workspace.js'

const durability = vi.hoisted(() => ({ fail: false, recoverFail: false }))
vi.mock('@agnes/system-node', async (importOriginal) => {
  const system = await importOriginal<typeof import('@agnes/system-node')>()
  return {
    ...system,
    syncDirectory: async (...args: Parameters<typeof system.syncDirectory>) => {
      if (durability.recoverFail) throw new Error('Injected recovery flush failure')
      await system.syncDirectory(...args)
    },
    renameWriteThrough: async (...args: Parameters<typeof system.renameWriteThrough>) => {
      await system.renameWriteThrough(...args)
      if (durability.fail) {
        durability.fail = false
        durability.recoverFail = false
        throw new Error('Injected publication flush failure')
      }
    },
  }
})

const roots: string[] = []
const disposals: (() => void)[] = []

afterEach(() => {
  durability.fail = false
  durability.recoverFail = false
  for (const dispose of disposals.splice(0).reverse()) dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'workspace-files-'))
  roots.push(root)
  return root
}

function scope(workspaceId = 'ws-1'): Wire.ScopeRef {
  return { kind: 'workspace', installationId: 'install-1', runtimeId: 'runtime-1', workspaceId }
}

let calls = 0
function call(workspaceId = 'ws-1', over: Partial<CallContext> = {}): CallContext {
  calls += 1
  return {
    principalRef: 'actor',
    scope: scope(workspaceId),
    bindingId: 'binding-1',
    invocationId: `call-${calls}`,
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

function policy(workspaceId = 'ws-1', extra: Wire.FsPolicySnapshot['rules'] = []): Wire.FsPolicySnapshot {
  const body = {
    compilerVersion: 'floor-1',
    policyId: 'policy-1',
    scope: scope(workspaceId),
    roots: [
      { kind: 'workspace' as const, mount: { workspaceId, mountId: 'mount-workspace' } },
      { kind: 'home' as const, mount: { workspaceId: 'home-ws', mountId: 'mount-home' } },
      { kind: 'data' as const, mount: { workspaceId: 'data-ws', mountId: 'mount-data' } },
    ],
    rules: [
      {
        root: 'workspace' as const,
        path: '',
        effect: 'allow' as const,
        access: ['read', 'write', 'stat', 'list'] as ('list' | 'read' | 'stat' | 'write')[],
      },
      {
        root: 'workspace' as const,
        path: '.git',
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'] as ('list' | 'read' | 'stat' | 'write')[],
      },
      {
        root: 'workspace' as const,
        path: '.agh/secrets',
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'] as ('list' | 'read' | 'stat' | 'write')[],
      },
      {
        root: 'workspace' as const,
        path: '.agnes/secrets',
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'] as ('list' | 'read' | 'stat' | 'write')[],
      },
      {
        root: 'home' as const,
        path: '.ssh',
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'] as ('list' | 'read' | 'stat' | 'write')[],
      },
      {
        root: 'data' as const,
        path: 'secrets',
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'] as ('list' | 'read' | 'stat' | 'write')[],
      },
      ...extra,
    ],
  }
  return { ...body, digest: canonicalJsonDigest(body) }
}

async function opened(options?: { afterDurableWrite?: () => void; checkpoint?: boolean }) {
  const directory = scratch()
  const work = join(directory, 'work')
  const home = join(directory, 'home')
  const data = join(directory, 'data')
  mkdirSync(work)
  mkdirSync(home)
  mkdirSync(data)
  const workspace = createWorkspaceService({
    directory: join(directory, 'store'),
    authorityId: 'authority-1',
    tenantId: 'tenant-1',
  })
  disposals.push(() => workspace.close())
  expect((await workspace.bind('ws-1', work)).ok).toBe(true)
  const acquired = await workspace.acquire(
    { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
    call(),
  )
  expect(acquired.ok).toBe(true)
  if (!acquired.ok) throw new Error('acquire failed')
  const files = createFilesService({
    store: workspace.store,
    authorityId: 'authority-1',
    policy: policy(),
    places: {
      home: { absolute: home, workspaceId: 'home-ws', mountId: 'mount-home' },
      data: { absolute: data, workspaceId: 'data-ws', mountId: 'mount-data' },
    },
    ...(options?.afterDurableWrite ? { afterDurableWrite: options.afterDurableWrite } : {}),
    ...(options?.checkpoint ? { checkpoint: { snapshot: async () => ({ id: 'snap-1' }) } } : {}),
  })
  return { directory, work, home, data, workspace, files, mount: acquired.value.mountRef }
}

async function stage(files: ReturnType<typeof createFilesService>, text: string) {
  const staged = await files.stageBytes(Buffer.from(text))
  expect(staged.ok).toBe(true)
  if (!staged.ok) throw new Error('stage failed')
  return staged.value
}

describe('file service', () => {
  it('writes, reads, lists, and stats the same bytes under the lease', async () => {
    const { files, mount, workspace } = await opened({ checkpoint: true })
    const bytes = await stage(files, 'hello')
    const wrote = await files.write(
      { mountRef: mount, path: 'notes.txt', bytesRef: bytes, expectedVersion: { kind: 'absent' } },
      call(),
    )
    expect(wrote.ok).toBe(true)
    if (!wrote.ok) return
    expect(wrote.value.version).toBe(1)
    expect(wrote.value.digest).toBe(createHash('sha256').update('hello').digest('hex'))
    expect(wrote.value.checkpoint.before).toBe('absent')
    expect(wrote.value.checkpoint.restoration.kind).toBe('domain-record')
    expect(wrote.value.checkpoint.restoration.resourceId).toBe('snap-1')
    const read = await files.read(
      { mountRef: mount, path: 'notes.txt', range: null, expectedVersion: 1 },
      call(),
    )
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const loaded = await files.loadBytes(read.value.bytesRef)
    expect(loaded.ok && Buffer.from(loaded.value).toString()).toBe('hello')
    const listed = await files.list({ mountRef: mount, path: '', cursor: null, limit: 10 }, call())
    expect(listed.ok && listed.value.items.map((item) => item.path)).toEqual(['notes.txt'])
    const info = await files.stat({ mountRef: mount, path: 'notes.txt' }, call())
    expect(info.ok && info.value.kind).toBe('file')
    expect(info.ok && info.value.version).toBe(1)
    files.close()
    workspace.close()
  })

  it('refuses escapes, symlink replacement, stale versions, and a released mount', async () => {
    const { files, mount, work, workspace } = await opened()
    const bytes = await stage(files, 'next')
    expect(
      detail(
        await files.write(
          { mountRef: mount, path: '../outside', bytesRef: bytes, expectedVersion: { kind: 'absent' } },
          call(),
        ),
      ),
    ).toBe('invalid_request')
    expect(
      detail(
        await files.write(
          { mountRef: mount, path: '/etc/passwd', bytesRef: bytes, expectedVersion: { kind: 'absent' } },
          call(),
        ),
      ),
    ).toBe('invalid_request')
    mkdirSync(join(work, '.git'))
    writeFileSync(join(work, '.git', 'config'), 'secret')
    symlinkSync(join(work, '.git', 'config'), join(work, 'alias'))
    symlinkSync(join(work, 'notes.txt'), join(work, 'linked-name'))
    expect(
      detail(
        await files.read({ mountRef: mount, path: 'alias', range: null, expectedVersion: null }, call()),
      ),
    ).toBe('permission_denied')
    const created = await stage(files, 'body')
    expect(
      (
        await files.write(
          { mountRef: mount, path: 'notes.txt', bytesRef: created, expectedVersion: { kind: 'absent' } },
          call(),
        )
      ).ok,
    ).toBe(true)
    expect(
      detail(
        await files.write(
          {
            mountRef: mount,
            path: 'linked-name',
            bytesRef: created,
            expectedVersion: { kind: 'exact', revision: 1 },
          },
          call(),
        ),
      ),
    ).toBe('permission_denied')
    expect(readFileSync(join(work, 'notes.txt'), 'utf8')).toBe('body')
    expect(
      detail(
        await files.write(
          {
            mountRef: mount,
            path: 'notes.txt',
            bytesRef: bytes,
            expectedVersion: { kind: 'exact', revision: 9 },
          },
          call(),
        ),
      ),
    ).toBe('revision_conflict')
    expect(readFileSync(join(work, 'notes.txt'), 'utf8')).toBe('body')
    expect((await workspace.release({ leaseRef: mount.lease }, call())).ok).toBe(true)
    expect(
      detail(
        await files.read({ mountRef: mount, path: 'notes.txt', range: null, expectedVersion: null }, call()),
      ),
    ).toBe('revoked')
    files.close()
    workspace.close()
  })

  it.each(['response', 'flush'])(
    'reconciles a lost %s and refuses a second payload for the same invocation',
    async (failure) => {
      let trip = failure === 'response'
      const { files, mount, work, workspace } = await opened({
        afterDurableWrite() {
          if (trip) {
            trip = false
            throw new Error('response lost')
          }
        },
      })
      durability.fail = failure === 'flush'
      const bytes = await stage(files, 'durable')
      const context = call()
      const lost = await files.write(
        { mountRef: mount, path: 'notes.txt', bytesRef: bytes, expectedVersion: { kind: 'absent' } },
        context,
      )
      expect(detail(lost)).toBe('effect_unknown')
      expect(lost.ok).toBe(false)
      if (!lost.ok) expect(lost.error.retryAdvice.kind).toBe('reconcile')
      expect(readFileSync(join(work, 'notes.txt'), 'utf8')).toBe('durable')
      if (failure === 'flush') {
        durability.recoverFail = true
        expect(
          detail(
            await files.write(
              { mountRef: mount, path: 'notes.txt', bytesRef: bytes, expectedVersion: { kind: 'absent' } },
              context,
            ),
          ),
        ).toBe('effect_unknown')
        durability.recoverFail = false
      }
      const recovered = await files.write(
        { mountRef: mount, path: 'notes.txt', bytesRef: bytes, expectedVersion: { kind: 'absent' } },
        context,
      )
      expect(recovered.ok && recovered.value.version).toBe(1)
      const other = await stage(files, 'other')
      expect(
        detail(
          await files.write(
            {
              mountRef: mount,
              path: 'notes.txt',
              bytesRef: other,
              expectedVersion: { kind: 'exact', revision: 1 },
            },
            context,
          ),
        ),
      ).toBe('idempotency_conflict')
      expect(readFileSync(join(work, 'notes.txt'), 'utf8')).toBe('durable')
      files.close()
      workspace.close()
    },
  )

  it('hides a hard-deny child and refuses a read of it', async () => {
    const { files, mount, work, workspace } = await opened()
    mkdirSync(join(work, '.git'))
    writeFileSync(join(work, '.git', 'config'), 'secret')
    writeFileSync(join(work, 'notes.txt'), 'visible')
    const listed = await files.list({ mountRef: mount, path: '', cursor: null, limit: 10 }, call())
    expect(listed.ok && listed.value.items.map((item) => item.path)).toEqual(['notes.txt'])
    expect(
      detail(
        await files.read(
          { mountRef: mount, path: '.git/config', range: null, expectedVersion: null },
          call(),
        ),
      ),
    ).toBe('permission_denied')
    const page = await files.list({ mountRef: mount, path: '', cursor: '0', limit: 1 }, call())
    expect(page.ok && page.value.complete).toBe(true)
    files.close()
    workspace.close()
  })
})
