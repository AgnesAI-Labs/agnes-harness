import type { ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { WORKSPACE_SECRET_DIRS } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { createReferenceFiles } from '../../../../examples/runtime-reference/src/providers/files.js'
import {
  createReferenceWorkspace,
  openReferenceDesk,
} from '../../../../examples/runtime-reference/src/providers/workspace.js'
import { createFilesService } from '../../src/runtime/providers/files.js'
import { createWorkspaceService } from '../../src/runtime/providers/workspace.js'

export const BODY = 'durable-body'
export const TAMPERED = 'tampered-body'
export const WRITE_ID = 'write-killed'
export const ACQUIRE_ID = 'acquire-killed'
export const FILE_NAME = 'notes.txt'
const LEASE_MS = 600_000

export type ServiceProfile = {
  authorityId: string
  tenantId: string
  principalRef: string
  workspaceId: string
  installationId: string
  runtimeId: string
  policyId: string
  compilerVersion: string
}

export const serviceProfile: ServiceProfile = {
  authorityId: 'authority-1',
  tenantId: 'tenant-1',
  principalRef: 'actor',
  workspaceId: 'ws-1',
  installationId: 'install-1',
  runtimeId: 'runtime-1',
  policyId: 'policy-1',
  compilerVersion: 'floor-1',
}

export type Kind = 'default' | 'reference'

/** child.kill('SIGKILL') is TerminateProcess on Windows. libuv stores that exit as SIGKILL. */
export function forceKill(child: ChildProcess): boolean {
  return child.kill('SIGKILL')
}

/** True only after forceKill, when the child closes with code null and signal SIGKILL. */
export function killedByForce(
  child: ChildProcess,
  code: number | null,
  signal: NodeJS.Signals | null,
): boolean {
  return child.killed && signal === 'SIGKILL' && code === null
}

export type RenamedReport = {
  stage: 'renamed'
  mountRef: Wire.MountRef
  bytesRef: Wire.BlobRef
  invocationId: string
  path: string
}

export type Opened = {
  readonly work: string
  readonly workspace: {
    bind(workspaceId: string, root: string): Promise<Outcome<{ revision: number; canonicalRoot: string }>>
    acquire(request: unknown, context: CallContext): Promise<Outcome<Wire.WorkspaceAcquireResult>>
    close(): void
  }
  readonly files: {
    stageBytes(bytes: Uint8Array, mediaType?: string): Promise<Outcome<Wire.BlobRef>>
    write(request: unknown, context: CallContext): Promise<Outcome<Wire.FilesWriteResult>>
    close(): void
  }
  close(): void
}

export function saveProfile(directory: string): void {
  writeFileSync(join(directory, 'profile.json'), `${JSON.stringify(serviceProfile)}\n`)
}

export function loadProfile(directory: string): ServiceProfile {
  return JSON.parse(readFileSync(join(directory, 'profile.json'), 'utf8')) as ServiceProfile
}

export function callFor(profile: ServiceProfile, invocationId: string): CallContext {
  return {
    principalRef: profile.principalRef,
    scope: {
      kind: 'workspace',
      installationId: profile.installationId,
      runtimeId: profile.runtimeId,
      workspaceId: profile.workspaceId,
    },
    bindingId: 'binding-1',
    invocationId,
    deadline: '2030-01-01T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'auth-1',
    signal: new AbortController().signal,
  }
}

function policyFor(profile: ServiceProfile): Wire.FsPolicySnapshot {
  const [aghSecrets, agnesSecrets] = WORKSPACE_SECRET_DIRS
  const scope = {
    kind: 'workspace' as const,
    installationId: profile.installationId,
    runtimeId: profile.runtimeId,
    workspaceId: profile.workspaceId,
  }
  const access = ['read', 'write', 'stat', 'list'] as ('list' | 'read' | 'stat' | 'write')[]
  const body = {
    compilerVersion: profile.compilerVersion,
    policyId: profile.policyId,
    scope,
    roots: [
      {
        kind: 'workspace' as const,
        mount: { workspaceId: profile.workspaceId, mountId: 'mount-workspace' },
      },
      { kind: 'home' as const, mount: { workspaceId: 'home-ws', mountId: 'mount-home' } },
      { kind: 'data' as const, mount: { workspaceId: 'data-ws', mountId: 'mount-data' } },
    ],
    rules: [
      { root: 'workspace' as const, path: '', effect: 'allow' as const, access },
      { root: 'workspace' as const, path: '.git', effect: 'hard-deny' as const, access },
      { root: 'workspace' as const, path: aghSecrets, effect: 'hard-deny' as const, access },
      { root: 'workspace' as const, path: agnesSecrets, effect: 'hard-deny' as const, access },
      { root: 'home' as const, path: '.ssh', effect: 'hard-deny' as const, access },
      { root: 'data' as const, path: 'secrets', effect: 'hard-deny' as const, access },
    ],
  }
  return { ...body, digest: canonicalJsonDigest(body) }
}

export function openFiles(kind: Kind, directory: string, afterRename?: () => void): Opened {
  const profile = loadProfile(directory)
  const work = join(directory, 'work')
  const home = join(directory, 'home')
  const data = join(directory, 'place')
  const policy = policyFor(profile)
  if (kind === 'default') {
    const workspace = createWorkspaceService({
      directory: join(directory, 'store'),
      authorityId: profile.authorityId,
      tenantId: profile.tenantId,
      leaseMs: LEASE_MS,
    })
    const files = createFilesService({
      store: workspace.store,
      authorityId: profile.authorityId,
      policy,
      places: {
        home: { absolute: home, workspaceId: 'home-ws', mountId: 'mount-home' },
        data: { absolute: data, workspaceId: 'data-ws', mountId: 'mount-data' },
      },
      ...(afterRename ? { afterDurableWrite: afterRename } : {}),
    })
    return {
      work,
      workspace,
      files,
      close() {
        files.close()
        workspace.close()
      },
    }
  }
  const desk = openReferenceDesk(join(directory, 'store'))
  const workspace = createReferenceWorkspace({
    desk,
    authorityId: profile.authorityId,
    tenantId: profile.tenantId,
    leaseMs: LEASE_MS,
  })
  const files = createReferenceFiles({
    desk,
    authorityId: profile.authorityId,
    policy,
    places: { home, data },
    ...(afterRename ? { afterRename } : {}),
  })
  return {
    work,
    workspace,
    files,
    close() {
      files.close()
      workspace.close()
      desk.close()
    },
  }
}
