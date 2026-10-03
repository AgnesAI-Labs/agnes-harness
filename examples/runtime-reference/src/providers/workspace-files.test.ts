import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createFilesService,
  type FilesService,
} from '../../../../packages/host/src/runtime/providers/files.ts'
import {
  createWorkspaceService,
  type WorkspaceService,
} from '../../../../packages/host/src/runtime/providers/workspace.ts'
import { openWorkspaceStore } from '../../../../packages/host/src/runtime/workspace-leases.ts'
import { createReferenceFiles, type ReferenceFiles } from './files.ts'
import { createReferenceWorkspace, openReferenceDesk, type ReferenceWorkspace } from './workspace.ts'

const REFERENCE_FILES = ['workspace.ts', 'files.ts'] as const
const DEFAULT_FILES = {
  'workspace.ts': '../../../../packages/host/src/runtime/providers/workspace.ts',
  'files.ts': '../../../../packages/host/src/runtime/providers/files.ts',
} as const

function collapsedLines(source: string): Set<string> {
  const lines = new Set<string>()
  for (const line of source.split('\n')) {
    const collapsed = line.replace(/\s+/g, '')
    if (collapsed !== '') lines.add(collapsed)
  }
  return lines
}

function sharedFraction(left: Set<string>, right: Set<string>): number {
  const smaller = Math.min(left.size, right.size)
  if (smaller === 0) return 1
  let shared = 0
  for (const line of left) if (right.has(line)) shared += 1
  return shared / smaller
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'reference-files-'))
  roots.push(root)
  return root
}

const SCOPE: Wire.ScopeRef = {
  kind: 'workspace',
  installationId: 'install-1',
  runtimeId: 'runtime-1',
  workspaceId: 'ws-1',
}

let calls = 0
function call(over: Partial<CallContext> = {}): CallContext {
  calls += 1
  return {
    principalRef: 'actor',
    scope: SCOPE,
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

function policy(): Wire.FsPolicySnapshot {
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
        access: ['read', 'write', 'stat', 'list'],
      },
      {
        root: 'workspace' as const,
        path: '.git',
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'],
      },
      {
        root: 'workspace' as const,
        path: '.agh/secrets',
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'],
      },
      {
        root: 'workspace' as const,
        path: '.agnes/secrets',
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'],
      },
      {
        root: 'home' as const,
        path: '.ssh',
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'],
      },
      {
        root: 'data' as const,
        path: 'secrets',
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'],
      },
    ],
  }
  return { ...body, digest: canonicalJsonDigest(body) }
}

type Side = {
  kind: 'default' | 'reference'
  workspace: WorkspaceService | ReferenceWorkspace
  files: FilesService | ReferenceFiles
  work: string
  close(): void
}

async function side(kind: 'default' | 'reference', hooks?: { lose?: boolean }): Promise<Side> {
  const directory = scratch()
  const work = join(directory, 'work')
  const home = join(directory, 'home')
  const data = join(directory, 'data')
  mkdirSync(work)
  mkdirSync(home)
  mkdirSync(data)
  if (kind === 'default') {
    const store = openWorkspaceStore({ directory: join(directory, 'store') })
    const workspace = createWorkspaceService({ store, authorityId: 'authority-1', tenantId: 'tenant-1' })
    const files = createFilesService({
      store,
      authorityId: 'authority-1',
      policy: policy(),
      places: {
        home: { absolute: home, workspaceId: 'home-ws', mountId: 'mount-home' },
        data: { absolute: data, workspaceId: 'data-ws', mountId: 'mount-data' },
      },
      ...(hooks?.lose
        ? {
            afterDurableWrite: () => {
              throw new Error('lost')
            },
          }
        : {}),
    })
    return {
      kind,
      workspace,
      files,
      work,
      close: () => {
        files.close()
        workspace.close()
      },
    }
  }
  const desk = openReferenceDesk(join(directory, 'store'))
  const workspace = createReferenceWorkspace({ desk, authorityId: 'authority-1', tenantId: 'tenant-1' })
  const files = createReferenceFiles({
    desk,
    authorityId: 'authority-1',
    policy: policy(),
    places: { home, data },
    ...(hooks?.lose ? { stall: 'landed' as const } : {}),
  })
  return {
    kind,
    workspace,
    files,
    work,
    close: () => {
      files.close()
      workspace.close()
      desk.close()
    },
  }
}

async function mounted(opened: Side) {
  expect((await opened.workspace.bind('ws-1', opened.work)).ok).toBe(true)
  const acquired = await opened.workspace.acquire(
    { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
    call(),
  )
  expect(acquired.ok).toBe(true)
  if (!acquired.ok) throw new Error('acquire failed')
  return acquired.value.mountRef
}

describe('reference workspace and file providers', () => {
  it('does not import the default workspace implementation', () => {
    for (const name of REFERENCE_FILES) {
      const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
      expect(source).not.toContain('@agnes/host')
      expect(source).not.toContain('packages/host')
    }
  })

  it('does not share more than half of its collapsed lines with the default file', () => {
    for (const name of REFERENCE_FILES) {
      const reference = collapsedLines(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'))
      const counterpart = collapsedLines(readFileSync(new URL(DEFAULT_FILES[name], import.meta.url), 'utf8'))
      expect(sharedFraction(reference, counterpart)).toBeLessThanOrEqual(0.5)
    }
  })

  it('agrees with the default service on bytes, versions, and refusal codes', async () => {
    const samples = [await side('default'), await side('reference')]
    const mounts = []
    for (const opened of samples) mounts.push(await mounted(opened))
    const digests: string[] = []
    const versions: number[] = []
    const refusals: string[][] = []
    for (const [index, opened] of samples.entries()) {
      const mount = mounts[index]
      if (!mount) throw new Error('missing mount')
      const staged = await opened.files.stageBytes(Buffer.from('hello'))
      expect(staged.ok).toBe(true)
      if (!staged.ok) return
      const wrote = await opened.files.write(
        { mountRef: mount, path: 'notes.txt', bytesRef: staged.value, expectedVersion: { kind: 'absent' } },
        call(),
      )
      expect(wrote.ok).toBe(true)
      if (!wrote.ok) return
      digests.push(wrote.value.digest)
      versions.push(wrote.value.version)
      expect(wrote.value.checkpoint.before).toBe('absent')
      expect(wrote.value.checkpoint.beforeVersion).toBeNull()
      const read = await opened.files.read(
        { mountRef: mount, path: 'notes.txt', range: null, expectedVersion: 1 },
        call(),
      )
      expect(read.ok).toBe(true)
      if (!read.ok) return
      const loaded = await opened.files.loadBytes(read.value.bytesRef)
      expect(loaded.ok && Buffer.from(loaded.value).toString()).toBe('hello')
      expect(wrote.value.digest).toBe(createHash('sha256').update('hello').digest('hex'))
      const codes = [
        detail(
          await opened.files.write(
            {
              mountRef: mount,
              path: '../outside',
              bytesRef: staged.value,
              expectedVersion: { kind: 'absent' },
            },
            call(),
          ),
        ),
        detail(
          await opened.files.write(
            {
              mountRef: mount,
              path: join(tmpdir(), 'outside'),
              bytesRef: staged.value,
              expectedVersion: { kind: 'absent' },
            },
            call(),
          ),
        ),
        detail(
          await opened.files.write(
            {
              mountRef: mount,
              path: 'notes.txt',
              bytesRef: staged.value,
              expectedVersion: { kind: 'exact', revision: 9 },
            },
            call(),
          ),
        ),
      ]
      mkdirSync(join(opened.work, '.git'))
      writeFileSync(join(opened.work, '.git', 'config'), 'secret')
      symlinkSync(join(opened.work, '.git', 'config'), join(opened.work, 'alias'))
      codes.push(
        detail(
          await opened.files.read(
            { mountRef: mount, path: 'alias', range: null, expectedVersion: null },
            call(),
          ),
        ),
      )
      const second = await opened.workspace.acquire(
        { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
        call(),
      )
      codes.push(detail(second))
      expect((await opened.workspace.release({ leaseRef: mount.lease }, call())).ok).toBe(true)
      codes.push(
        detail(
          await opened.files.read(
            { mountRef: mount, path: 'notes.txt', range: null, expectedVersion: null },
            call(),
          ),
        ),
      )
      refusals.push(codes)
      opened.close()
    }
    expect(digests[0]).toBe(digests[1])
    expect(versions).toEqual([1, 1])
    expect(refusals[0]).toEqual(refusals[1])
    expect(refusals[0]).toEqual([
      'invalid_request',
      'invalid_request',
      'revision_conflict',
      'permission_denied',
      'revision_conflict',
      'revoked',
    ])
  })

  it('replays one lost write from the journal and keeps the directory after close', async () => {
    const directory = scratch()
    const work = join(directory, 'work')
    mkdirSync(work)
    const desk = openReferenceDesk(join(directory, 'store'))
    const workspace = createReferenceWorkspace({ desk, authorityId: 'authority-1', tenantId: 'tenant-1' })
    const files = createReferenceFiles({
      desk,
      authorityId: 'authority-1',
      policy: policy(),
      places: { home: work, data: work },
      stall: 'landed',
    })
    expect((await workspace.bind('ws-1', work)).ok).toBe(true)
    const acquired = await workspace.acquire(
      { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
      call(),
    )
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return
    const staged = await files.stageBytes(Buffer.from('durable'))
    expect(staged.ok).toBe(true)
    if (!staged.ok) return
    const context = call()
    const lost = await files.write(
      {
        mountRef: acquired.value.mountRef,
        path: 'notes.txt',
        bytesRef: staged.value,
        expectedVersion: { kind: 'absent' },
      },
      context,
    )
    expect(detail(lost)).toBe('effect_unknown')
    if (!lost.ok) expect(lost.error.retryAdvice.kind).toBe('reconcile')
    files.close()
    workspace.close()
    desk.close()
    const reopened = openReferenceDesk(join(directory, 'store'))
    const againWorkspace = createReferenceWorkspace({
      desk: reopened,
      authorityId: 'authority-1',
      tenantId: 'tenant-1',
    })
    const againFiles = createReferenceFiles({
      desk: reopened,
      authorityId: 'authority-1',
      policy: policy(),
      places: { home: work, data: work },
    })
    const recovered = await againFiles.write(
      {
        mountRef: acquired.value.mountRef,
        path: 'notes.txt',
        bytesRef: staged.value,
        expectedVersion: { kind: 'absent' },
      },
      context,
    )
    expect(recovered.ok && recovered.value.version).toBe(1)
    const other = await againFiles.stageBytes(Buffer.from('other'))
    expect(other.ok).toBe(true)
    if (!other.ok) return
    expect(
      detail(
        await againFiles.write(
          {
            mountRef: acquired.value.mountRef,
            path: 'notes.txt',
            bytesRef: other.value,
            expectedVersion: { kind: 'exact', revision: 1 },
          },
          context,
        ),
      ),
    ).toBe('idempotency_conflict')
    expect(readFileSync(join(work, 'notes.txt'), 'utf8')).toBe('durable')
    againFiles.close()
    againWorkspace.close()
    reopened.close()
    expect(readFileSync(join(work, 'notes.txt'), 'utf8')).toBe('durable')
    const remote = createReferenceFiles({
      desk: openReferenceDesk(join(directory, 'remote')),
      authorityId: 'authority-1',
      policy: policy(),
      places: { home: work, data: work },
      remote: true,
    })
    expect(detail(await remote.authorityFence({}, call()))).toBe('unsupported')
    expect(
      detail(
        await remote.write(
          {
            mountRef: acquired.value.mountRef,
            path: 'notes.txt',
            bytesRef: staged.value,
            expectedVersion: { kind: 'exact', revision: 1 },
          },
          call(),
        ),
      ),
    ).toBe('unsupported')
    remote.close()
  })
})
