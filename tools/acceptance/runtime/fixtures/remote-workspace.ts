import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext } from '@agnes/extension-api/runtime'
import {
  createFilesService,
  type FilesService,
} from '../../../../packages/host/src/runtime/providers/files.ts'
import { createWorkspaceService } from '../../../../packages/host/src/runtime/providers/workspace.ts'
import { runtimeError } from '../../../../packages/host/src/runtime/workspace-leases.ts'
import type * as Wire from '../../../../packages/protocol/src/runtime/index.ts'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.ts'

import { workspaceDirectory } from './workspace-directory.ts'

/** Hide a committed write so the caller has to reconcile the same invocation. */
export function dropFirstCommittedWrite(files: FilesService): FilesService {
  const hidden = new Set<string>()
  return {
    ...files,
    async write(request, context) {
      const outcome = await files.write(request, context)
      if (hidden.has(context.invocationId) || !outcome.ok) return outcome
      hidden.add(context.invocationId)
      return { ok: false, error: runtimeError('effect_unknown', 'effect is unknown') }
    },
  }
}

function policy(): Wire.FsPolicySnapshot {
  const scope: Wire.ScopeRef = {
    kind: 'workspace',
    installationId: 'install-1',
    runtimeId: 'runtime-1',
    workspaceId: 'ws-1',
  }
  const body = {
    compilerVersion: 'floor-1',
    policyId: 'policy-1',
    scope,
    roots: [{ kind: 'workspace' as const, mount: { workspaceId: 'ws-1', mountId: 'mount-workspace' } }],
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

function call(invocationId: string): CallContext {
  return {
    principalRef: 'actor',
    scope: { kind: 'workspace', installationId: 'install-1', runtimeId: 'runtime-1', workspaceId: 'ws-1' },
    bindingId: 'binding-1',
    invocationId,
    deadline: '2030-01-01T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'auth-1',
    signal: new AbortController().signal,
  }
}

/** A lost response after a committed write replays one version and does not take a different payload. */
export async function proveRemoteWorkspace(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'remote-workspace-'))
  try {
    const work = join(directory, 'work')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(work)
    const routing = await workspaceDirectory(directory)
    const workspace = createWorkspaceService({
      directory: join(directory, 'store'),
      authorityId: 'authority-1',
      tenantId: 'tenant-1',
      directoryRead: routing.reader,
    })
    assert.equal((await workspace.bind('ws-1', work)).ok, true)
    const acquired = await workspace.acquire(
      { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
      call('remote-acquire'),
    )
    assert.equal(acquired.ok, true)
    if (!acquired.ok) return
    const files = createFilesService({
      store: workspace.store,
      authorityId: 'authority-1',
      policy: policy(),
      places: {
        home: { absolute: work, workspaceId: 'home-ws', mountId: 'mount-home' },
        data: { absolute: work, workspaceId: 'data-ws', mountId: 'mount-data' },
      },
    })
    const dropped = dropFirstCommittedWrite(files)
    const staged = await dropped.stageBytes(Buffer.from('kept'))
    assert.equal(staged.ok, true)
    if (!staged.ok) return
    const first = await dropped.write(
      {
        mountRef: acquired.value.mountRef,
        path: 'notes.txt',
        bytesRef: staged.value,
        expectedVersion: { kind: 'absent' },
      },
      call('remote-write'),
    )
    assert.equal(first.ok, false)
    if (!first.ok) assert.equal(first.error.detailCode, 'effect_unknown')
    assert.equal(readFileSync(join(work, 'notes.txt'), 'utf8'), 'kept')
    const replay = await dropped.write(
      {
        mountRef: acquired.value.mountRef,
        path: 'notes.txt',
        bytesRef: staged.value,
        expectedVersion: { kind: 'absent' },
      },
      call('remote-write'),
    )
    assert.equal(replay.ok, true)
    if (replay.ok) assert.equal(replay.value.version, 1)
    const other = await dropped.stageBytes(Buffer.from('other'))
    assert.equal(other.ok, true)
    if (!other.ok) return
    const conflict = await dropped.write(
      {
        mountRef: acquired.value.mountRef,
        path: 'notes.txt',
        bytesRef: other.value,
        expectedVersion: { kind: 'exact', revision: 1 },
      },
      call('remote-write'),
    )
    assert.equal(conflict.ok, false)
    if (!conflict.ok) assert.equal(conflict.error.detailCode, 'idempotency_conflict')
    assert.equal(readFileSync(join(work, 'notes.txt'), 'utf8'), 'kept')
    files.close()
    workspace.close()
    await routing.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
