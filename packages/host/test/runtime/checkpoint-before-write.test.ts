import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { createFilesService } from '../../src/runtime/providers/files.js'
import { createWorkspaceService } from '../../src/runtime/providers/workspace.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function call(): CallContext {
  return {
    principalRef: 'actor',
    scope: { kind: 'workspace', installationId: 'install-1', runtimeId: 'runtime-1', workspaceId: 'ws-1' },
    bindingId: 'binding-1',
    invocationId: `call-${Math.random().toString(16).slice(2)}`,
    deadline: '2030-01-01T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'auth-1',
    signal: new AbortController().signal,
  }
}

function detail(outcome: Outcome<unknown>): string {
  return outcome.ok ? 'ok' : outcome.error.detailCode
}

function policy(): Wire.FsPolicySnapshot {
  const body = {
    compilerVersion: 'floor-1',
    policyId: 'policy-1',
    scope: {
      kind: 'workspace' as const,
      installationId: 'install-1',
      runtimeId: 'runtime-1',
      workspaceId: 'ws-1',
    },
    roots: [{ kind: 'workspace' as const, mount: { workspaceId: 'ws-1', mountId: 'mount-workspace' } }],
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
    ],
  }
  return { ...body, digest: canonicalJsonDigest(body) }
}

describe('checkpoint before write', () => {
  it('records the snapshot id and refuses the write when the snapshot fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'checkpoint-write-'))
    roots.push(directory)
    const work = join(directory, 'work')
    mkdirSync(work)
    const workspace = createWorkspaceService({
      directory: join(directory, 'store'),
      authorityId: 'authority-1',
      tenantId: 'tenant-1',
    })
    expect((await workspace.bind('ws-1', work)).ok).toBe(true)
    const acquired = await workspace.acquire(
      { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
      call(),
    )
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return
    const seen: string[] = []
    const files = createFilesService({
      store: workspace.store,
      authorityId: 'authority-1',
      policy: policy(),
      places: {
        home: { absolute: work, workspaceId: 'home-ws', mountId: 'mount-home' },
        data: { absolute: work, workspaceId: 'data-ws', mountId: 'mount-data' },
      },
      checkpoint: {
        async snapshot(absolutePath) {
          seen.push(absolutePath)
          return { id: 'snap-kept' }
        },
      },
    })
    const staged = await files.stageBytes(Buffer.from('kept'))
    expect(staged.ok).toBe(true)
    if (!staged.ok) return
    const wrote = await files.write(
      {
        mountRef: acquired.value.mountRef,
        path: 'notes.txt',
        bytesRef: staged.value,
        expectedVersion: { kind: 'absent' },
      },
      call(),
    )
    expect(wrote.ok && wrote.value.checkpoint.restoration.resourceId).toBe('snap-kept')
    expect(seen).toHaveLength(1)
    expect(readFileSync(join(work, 'notes.txt'), 'utf8')).toBe('kept')
    files.close()
    const failing = createFilesService({
      store: workspace.store,
      authorityId: 'authority-1',
      policy: policy(),
      places: {
        home: { absolute: work, workspaceId: 'home-ws', mountId: 'mount-home' },
        data: { absolute: work, workspaceId: 'data-ws', mountId: 'mount-data' },
      },
      checkpoint: {
        async snapshot() {
          throw new Error('snapshot failed')
        },
      },
    })
    const next = await failing.stageBytes(Buffer.from('nope'))
    expect(next.ok).toBe(true)
    if (!next.ok) return
    const refused = await failing.write(
      {
        mountRef: acquired.value.mountRef,
        path: 'other.txt',
        bytesRef: next.value,
        expectedVersion: { kind: 'absent' },
      },
      call(),
    )
    expect(detail(refused)).toBe('blocked')
    expect(() => readFileSync(join(work, 'other.txt'), 'utf8')).toThrow()
    expect(readFileSync(join(work, 'notes.txt'), 'utf8')).toBe('kept')
    const retry = await failing.write(
      {
        mountRef: acquired.value.mountRef,
        path: 'other.txt',
        bytesRef: next.value,
        expectedVersion: { kind: 'absent' },
      },
      call(),
    )
    expect(detail(retry)).toBe('blocked')
    failing.close()
    workspace.close()
    expect(readFileSync(join(work, 'notes.txt'), 'utf8')).toBe('kept')
  })
})
