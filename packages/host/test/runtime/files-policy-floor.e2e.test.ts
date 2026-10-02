import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

const SCOPE: Wire.ScopeRef = {
  kind: 'workspace',
  installationId: 'install-1',
  runtimeId: 'runtime-1',
  workspaceId: 'ws-1',
}

function call(): CallContext {
  return {
    principalRef: 'actor',
    scope: SCOPE,
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

function policy(extra: Wire.FsPolicySnapshot['rules'] = []): Wire.FsPolicySnapshot {
  const body = {
    compilerVersion: 'floor-1',
    policyId: 'policy-1',
    scope: SCOPE,
    roots: [
      { kind: 'workspace' as const, mount: { workspaceId: 'ws-1', mountId: 'mount-workspace' } },
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

describe('file policy floor', () => {
  it('denies the five hard paths on the real filesystem and does not accept a missing path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'policy-floor-'))
    roots.push(directory)
    const work = join(directory, 'work')
    const home = join(directory, 'home')
    const data = join(directory, 'data')
    mkdirSync(join(work, '.git'), { recursive: true })
    mkdirSync(join(work, '.agh'), { recursive: true })
    mkdirSync(join(work, '.agnes'), { recursive: true })
    writeFileSync(join(work, '.git', 'config'), 'secret')
    writeFileSync(join(work, '.agh', 'secrets'), 'secret')
    writeFileSync(join(work, '.agnes', 'secrets'), 'secret')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    mkdirSync(join(data, 'secrets'), { recursive: true })
    writeFileSync(join(work, 'notes.txt'), 'visible')
    symlinkSync(join(work, '.git', 'config'), join(work, 'alias'))
    const workspace = createWorkspaceService({
      directory: join(directory, 'store'),
      authorityId: 'authority-1',
      tenantId: 'tenant-1',
    })
    expect((await workspace.bind('ws-1', work)).ok).toBe(true)
    const acquired = await workspace.acquire(
      { workspaceId: 'ws-1', mode: 'read', expectedRevision: null },
      call(),
    )
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return
    const files = createFilesService({
      store: workspace.store,
      authorityId: 'authority-1',
      policy: policy(),
      places: {
        home: { absolute: home, workspaceId: 'home-ws', mountId: 'mount-home' },
        data: { absolute: data, workspaceId: 'data-ws', mountId: 'mount-data' },
      },
    })
    const proof = await files.verifyPolicy(policy(), call())
    expect(proof.ok).toBe(true)
    if (!proof.ok) return
    expect(proof.value.probes.map((probe) => `${probe.root}:${probe.path}`)).toEqual([
      'workspace:.git',
      'workspace:.agh/secrets',
      'workspace:.agnes/secrets',
      'home:.ssh',
      'data:secrets',
    ])
    expect(
      proof.value.probes.every(
        (probe) => probe.decision === 'denied' && probe.evidenceCode === 'E_FS_DENIED',
      ),
    ).toBe(true)
    expect(proof.value.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(proof.value.workspaceRoot.exists).toBe(true)
    expect(
      detail(
        await files.read(
          { mountRef: acquired.value.mountRef, path: '.git/config', range: null, expectedVersion: null },
          call(),
        ),
      ),
    ).toBe('permission_denied')
    expect(
      detail(
        await files.read(
          { mountRef: acquired.value.mountRef, path: 'alias', range: null, expectedVersion: null },
          call(),
        ),
      ),
    ).toBe('permission_denied')
    const listed = await files.list(
      { mountRef: acquired.value.mountRef, path: '', cursor: null, limit: 20 },
      call(),
    )
    expect(listed.ok && listed.value.items.some((item) => item.path.startsWith('.git'))).toBe(false)
    const incomplete = policy()
    const broken = {
      compilerVersion: incomplete.compilerVersion,
      policyId: incomplete.policyId,
      scope: incomplete.scope,
      roots: incomplete.roots,
      rules: incomplete.rules.filter((rule) => !(rule.root === 'data' && rule.path === 'secrets')),
    }
    const rejected = await files.verifyPolicy({ ...broken, digest: canonicalJsonDigest(broken) }, call())
    expect(detail(rejected)).toBe('invalid_request')
    rmSync(join(data, 'secrets'), { recursive: true, force: true })
    const absent = await files.verifyPolicy(policy(), call())
    expect(detail(absent)).toBe('integrity')
    expect(absent.ok).toBe(false)
    files.close()
    workspace.close()
  }, 20_000)
})
