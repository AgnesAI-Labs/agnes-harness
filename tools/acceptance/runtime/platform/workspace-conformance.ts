import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import {
  createReferenceFiles,
  type ReferenceFiles,
} from '../../../../examples/runtime-reference/src/providers/files.ts'
import {
  createReferenceWorkspace,
  openReferenceDesk,
  type ReferenceDesk,
  type ReferenceWorkspace,
} from '../../../../examples/runtime-reference/src/providers/workspace.ts'
import {
  type FilesConformanceBinding,
  type FilesPort,
  type FilesScenarioEvidence,
  registerFilesContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/files.ts'
import {
  registerWorkspaceContract,
  type WorkspaceConformanceBinding,
  type WorkspacePort,
  type WorkspaceScenarioEvidence,
} from '../../../../packages/extension-api/testkit/runtime/contracts/workspace.ts'
import type { BuildIdentity } from '../../../../packages/extension-api/testkit/runtime/evidence.ts'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
import {
  createFilesService,
  type FilesService,
} from '../../../../packages/host/src/runtime/providers/files.ts'
import {
  createWorkspaceService,
  type WorkspaceService,
} from '../../../../packages/host/src/runtime/providers/workspace.ts'
import {
  openWorkspaceStore,
  type WorkspaceStore,
} from '../../../../packages/host/src/runtime/workspace-leases.ts'
import { WORKSPACE_SECRET_DIRS } from '../../../../packages/protocol/src/constants.ts'
import type * as Wire from '../../../../packages/protocol/src/runtime/index.ts'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.ts'

import { workspaceDirectory } from '../fixtures/workspace-directory.ts'

type Kind = 'default' | 'reference'
type WorkspaceApi = WorkspaceService | ReferenceWorkspace
type FilesApi = FilesService | ReferenceFiles

const SCOPE: Wire.ScopeRef = {
  kind: 'workspace',
  installationId: 'install-1',
  runtimeId: 'runtime-1',
  workspaceId: 'ws-1',
}

function policy(): Wire.FsPolicySnapshot {
  const [aghSecrets, agnesSecrets] = WORKSPACE_SECRET_DIRS
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
        path: aghSecrets,
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'],
      },
      {
        root: 'workspace' as const,
        path: agnesSecrets,
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

let ticket = 0
function call(invocationId?: string, signal?: AbortSignal): CallContext {
  ticket += 1
  return {
    principalRef: 'actor',
    scope: SCOPE,
    bindingId: 'binding-1',
    invocationId: invocationId ?? `conformance-${ticket}`,
    deadline: '2030-01-01T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'auth-1',
    signal: signal ?? new AbortController().signal,
  }
}

function detail(outcome: Outcome<unknown>): string {
  return outcome.ok ? 'ok' : outcome.error.detailCode
}

type Session = {
  readonly kind: Kind
  readonly directory: string
  readonly work: string
  workspace: WorkspaceApi
  files: FilesApi
  reopen(): Promise<void>
  close(): Promise<void>
}

async function openSession(kind: Kind): Promise<Session> {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-conformance-'))
  const work = join(directory, 'work')
  const home = join(directory, 'home')
  const data = join(directory, 'place-data')
  const storeDir = join(directory, 'store')
  mkdirSync(work)
  mkdirSync(home)
  mkdirSync(data)
  const routing = await workspaceDirectory(directory)
  let store: WorkspaceStore | undefined
  let desk: ReferenceDesk | undefined
  const places = {
    home: { absolute: home, workspaceId: 'home-ws', mountId: 'mount-home' },
    data: { absolute: data, workspaceId: 'data-ws', mountId: 'mount-data' },
  }
  const session = {
    kind,
    directory,
    work,
    workspace: undefined as unknown as WorkspaceApi,
    files: undefined as unknown as FilesApi,
    async reopen() {
      await routing.reopen()
      if (session.files) session.files.close()
      if (session.workspace) session.workspace.close()
      if (kind === 'default') {
        store?.close()
        store = openWorkspaceStore({ directory: storeDir })
        session.workspace = createWorkspaceService({
          store,
          authorityId: 'authority-1',
          tenantId: 'tenant-1',
          directoryRead: routing.reader,
        })
        session.files = createFilesService({
          store,
          authorityId: 'authority-1',
          policy: policy(),
          places,
        })
      } else {
        desk?.close()
        desk = openReferenceDesk(storeDir)
        session.workspace = createReferenceWorkspace({
          desk,
          authorityId: 'authority-1',
          tenantId: 'tenant-1',
          directoryRead: routing.reader,
        })
        session.files = createReferenceFiles({
          desk,
          authorityId: 'authority-1',
          policy: policy(),
          places: { home, data },
        })
      }
    },
    async close() {
      await routing.close()
      session.files.close()
      session.workspace.close()
      store?.close()
      desk?.close()
      rmSync(directory, { recursive: true, force: true })
    },
  } satisfies Omit<Session, 'workspace' | 'files'> & { workspace: WorkspaceApi; files: FilesApi }
  await session.reopen()
  return session
}

function evidence(providerDigest: string, recipe: string, note: string): WorkspaceScenarioEvidence {
  return {
    passed: true,
    providerDigest,
    configDigest: canonicalJsonDigest({ recipe }),
    releaseSetDigest: canonicalJsonDigest({ recipe, note }),
    detail: note,
  }
}

function repoRoot(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url))
}

function createBuild(): BuildIdentity {
  const root = repoRoot()
  const lockDigest = createHash('sha256')
    .update(readFileSync(join(root, 'pnpm-lock.yaml')))
    .digest('hex')
  const sdk = JSON.parse(readFileSync(join(root, 'packages/extension-api/package.json'), 'utf8')) as {
    name: string
    version: string
  }
  const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const specVersion = 'runtime-services-1'
  return {
    codeSha,
    buildDigest: canonicalJsonDigest({ codeSha, specVersion }),
    lockDigest,
    specVersion,
    sdkVersion: sdk.version,
    sdkDigest: canonicalJsonDigest({ name: sdk.name, version: sdk.version }),
    platform: `${process.platform}-${process.arch}`, // guards-allow-platform: evidence only, no branch
  }
}

function recipes(kind: Kind): { workspace: string; files: string } {
  return kind === 'default'
    ? { workspace: 'sqlite-lease', files: 'local-content' }
    : { workspace: 'jsonl-lease', files: 'tree-cabinet' }
}

async function workspacePort(kind: Kind): Promise<WorkspacePort> {
  const recipe = recipes(kind).workspace
  return {
    recipe,
    async select() {
      const session = await openSession(kind)
      try {
        assert.equal((await session.workspace.bind('ws-1', session.work)).ok, true)
        const acquired = await session.workspace.acquire(
          { workspaceId: 'ws-1', mode: 'read', expectedRevision: null },
          call(),
        )
        assert.equal(acquired.ok, true)
        if (!acquired.ok) throw new Error('read lease was refused')
        const released = await session.workspace.release({ leaseRef: acquired.value.leaseRef }, call())
        assert.equal(released.ok && released.value.released, true)
        return evidence(session.workspace.providerDigest, recipe, 'selected')
      } finally {
        await session.close()
      }
    },
    async normal() {
      const session = await openSession(kind)
      try {
        assert.equal((await session.workspace.bind('ws-1', session.work)).ok, true)
        const acquired = await session.workspace.acquire(
          { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
          call(),
        )
        assert.equal(acquired.ok, true)
        if (!acquired.ok) throw new Error('write lease was refused')
        assert.equal(
          (await session.workspace.release({ leaseRef: acquired.value.leaseRef }, call())).ok,
          true,
        )
        const again = await session.workspace.acquire(
          { workspaceId: 'ws-1', mode: 'write', expectedRevision: 1 },
          call(),
        )
        assert.equal(again.ok, true)
        return evidence(session.workspace.providerDigest, recipe, 'reacquired')
      } finally {
        await session.close()
      }
    },
    async deny() {
      const session = await openSession(kind)
      try {
        assert.equal((await session.workspace.bind('ws-1', session.work)).ok, true)
        const foreign = call()
        assert.equal(
          detail(
            await session.workspace.acquire(
              { workspaceId: 'ws-1', mode: 'read', expectedRevision: null },
              {
                ...foreign,
                scope: {
                  kind: 'workspace',
                  installationId: 'install-1',
                  runtimeId: 'runtime-1',
                  workspaceId: 'ws-2',
                },
              },
            ),
          ),
          'permission_denied',
        )
        return evidence(session.workspace.providerDigest, recipe, 'permission_denied')
      } finally {
        await session.close()
      }
    },
    async cancel() {
      const session = await openSession(kind)
      try {
        assert.equal((await session.workspace.bind('ws-1', session.work)).ok, true)
        const aborted = new AbortController()
        aborted.abort()
        assert.equal(
          detail(
            await session.workspace.acquire(
              { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
              call(undefined, aborted.signal),
            ),
          ),
          'cancelled',
        )
        const acquired = await session.workspace.acquire(
          { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
          call(),
        )
        assert.equal(acquired.ok, true)
        return evidence(session.workspace.providerDigest, recipe, 'cancelled')
      } finally {
        await session.close()
      }
    },
    async recover() {
      const session = await openSession(kind)
      try {
        assert.equal((await session.workspace.bind('ws-1', session.work)).ok, true)
        const acquired = await session.workspace.acquire(
          { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
          call(),
        )
        assert.equal(acquired.ok, true)
        if (!acquired.ok) throw new Error('write lease was refused')
        await session.reopen()
        const blocked = await session.workspace.acquire(
          { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
          call(),
        )
        assert.equal(detail(blocked), 'revision_conflict')
        const released = await session.workspace.release({ leaseRef: acquired.value.leaseRef }, call())
        assert.equal(released.ok && released.value.released, true)
        return evidence(session.workspace.providerDigest, recipe, 'recovered')
      } finally {
        await session.close()
      }
    },
    async dispose() {
      const session = await openSession(kind)
      try {
        assert.equal((await session.workspace.bind('ws-1', session.work)).ok, true)
        session.workspace.close()
        assert.equal(
          detail(
            await session.workspace.acquire(
              { workspaceId: 'ws-1', mode: 'read', expectedRevision: null },
              call(),
            ),
          ),
          'blocked',
        )
        assert.equal(existsSync(session.work), true)
        return evidence(session.workspace.providerDigest, recipe, 'disposed')
      } finally {
        await session.close()
      }
    },
  }
}

async function filesPort(kind: Kind): Promise<FilesPort> {
  const recipe = recipes(kind).files
  return {
    recipe,
    async select() {
      const session = await openSession(kind)
      try {
        assert.equal((await session.workspace.bind('ws-1', session.work)).ok, true)
        const acquired = await session.workspace.acquire(
          { workspaceId: 'ws-1', mode: 'read', expectedRevision: null },
          call(),
        )
        assert.equal(acquired.ok, true)
        if (!acquired.ok) throw new Error('read lease was refused')
        const listed = await session.files.list(
          { mountRef: acquired.value.mountRef, path: '', cursor: null, limit: 10 },
          call(),
        )
        assert.equal(listed.ok && listed.value.complete, true)
        return evidence(session.files.providerDigest, recipe, 'selected')
      } finally {
        await session.close()
      }
    },
    async normal() {
      const session = await openSession(kind)
      try {
        assert.equal((await session.workspace.bind('ws-1', session.work)).ok, true)
        const acquired = await session.workspace.acquire(
          { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
          call(),
        )
        assert.equal(acquired.ok, true)
        if (!acquired.ok) throw new Error('write lease was refused')
        const staged = await session.files.stageBytes(Buffer.from('hello'))
        assert.equal(staged.ok, true)
        if (!staged.ok) throw new Error('bytes were not retained')
        const wrote = await session.files.write(
          {
            mountRef: acquired.value.mountRef,
            path: 'notes.txt',
            bytesRef: staged.value,
            expectedVersion: { kind: 'absent' },
          },
          call(),
        )
        assert.equal(wrote.ok && wrote.value.version, 1)
        const read = await session.files.read(
          { mountRef: acquired.value.mountRef, path: 'notes.txt', range: null, expectedVersion: 1 },
          call(),
        )
        assert.equal(read.ok, true)
        if (!read.ok) throw new Error('read was refused')
        const loaded = await session.files.loadBytes(read.value.bytesRef)
        assert.equal(loaded.ok && Buffer.from(loaded.value).toString(), 'hello')
        return evidence(session.files.providerDigest, recipe, 'round-trip')
      } finally {
        await session.close()
      }
    },
    async deny() {
      const session = await openSession(kind)
      try {
        assert.equal((await session.workspace.bind('ws-1', session.work)).ok, true)
        const acquired = await session.workspace.acquire(
          { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
          call(),
        )
        assert.equal(acquired.ok, true)
        if (!acquired.ok) throw new Error('write lease was refused')
        const staged = await session.files.stageBytes(Buffer.from('nope'))
        assert.equal(staged.ok, true)
        if (!staged.ok) throw new Error('bytes were not retained')
        assert.equal(
          detail(
            await session.files.write(
              {
                mountRef: acquired.value.mountRef,
                path: '../outside',
                bytesRef: staged.value,
                expectedVersion: { kind: 'absent' },
              },
              call(),
            ),
          ),
          'invalid_request',
        )
        return evidence(session.files.providerDigest, recipe, 'invalid_request')
      } finally {
        await session.close()
      }
    },
    async cancel() {
      const session = await openSession(kind)
      try {
        assert.equal((await session.workspace.bind('ws-1', session.work)).ok, true)
        const acquired = await session.workspace.acquire(
          { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
          call(),
        )
        assert.equal(acquired.ok, true)
        if (!acquired.ok) throw new Error('write lease was refused')
        const staged = await session.files.stageBytes(Buffer.from('nope'))
        assert.equal(staged.ok, true)
        if (!staged.ok) throw new Error('bytes were not retained')
        const aborted = new AbortController()
        aborted.abort()
        assert.equal(
          detail(
            await session.files.write(
              {
                mountRef: acquired.value.mountRef,
                path: 'notes.txt',
                bytesRef: staged.value,
                expectedVersion: { kind: 'absent' },
              },
              call(undefined, aborted.signal),
            ),
          ),
          'cancelled',
        )
        assert.equal(existsSync(join(session.work, 'notes.txt')), false)
        return evidence(session.files.providerDigest, recipe, 'cancelled')
      } finally {
        await session.close()
      }
    },
    async recover() {
      const session = await openSession(kind)
      try {
        assert.equal((await session.workspace.bind('ws-1', session.work)).ok, true)
        const acquired = await session.workspace.acquire(
          { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
          call(),
        )
        assert.equal(acquired.ok, true)
        if (!acquired.ok) throw new Error('write lease was refused')
        const staged = await session.files.stageBytes(Buffer.from('kept'))
        assert.equal(staged.ok, true)
        if (!staged.ok) throw new Error('bytes were not retained')
        const wrote = await session.files.write(
          {
            mountRef: acquired.value.mountRef,
            path: 'notes.txt',
            bytesRef: staged.value,
            expectedVersion: { kind: 'absent' },
          },
          call(),
        )
        assert.equal(wrote.ok, true)
        const mount = acquired.value.mountRef
        const bytesRef = staged.value
        await session.reopen()
        const read = await session.files.read(
          { mountRef: mount, path: 'notes.txt', range: null, expectedVersion: 1 },
          call(),
        )
        assert.equal(read.ok, true)
        if (!read.ok) throw new Error('reopened read was refused')
        const loaded = await session.files.loadBytes(read.value.bytesRef)
        assert.equal(loaded.ok && Buffer.from(loaded.value).toString(), 'kept')
        void bytesRef
        return evidence(session.files.providerDigest, recipe, 'recovered')
      } finally {
        await session.close()
      }
    },
    async dispose() {
      const session = await openSession(kind)
      try {
        assert.equal((await session.workspace.bind('ws-1', session.work)).ok, true)
        const acquired = await session.workspace.acquire(
          { workspaceId: 'ws-1', mode: 'read', expectedRevision: null },
          call(),
        )
        assert.equal(acquired.ok, true)
        if (!acquired.ok) throw new Error('read lease was refused')
        session.files.close()
        assert.equal(
          detail(
            await session.files.read(
              { mountRef: acquired.value.mountRef, path: 'notes.txt', range: null, expectedVersion: null },
              call(),
            ),
          ),
          'blocked',
        )
        assert.equal(existsSync(session.work), true)
        return evidence(session.files.providerDigest, recipe, 'disposed')
      } finally {
        await session.close()
      }
    },
  }
}

function unusedWorkspace(
  recipe: string,
): Pick<WorkspacePort, 'select' | 'normal' | 'cancel' | 'recover' | 'dispose'> {
  const fail = async (): Promise<WorkspaceScenarioEvidence> => {
    throw new Error(`${recipe} scenario was not requested`)
  }
  return { select: fail, normal: fail, cancel: fail, recover: fail, dispose: fail }
}

function unusedFiles(
  recipe: string,
): Pick<FilesPort, 'select' | 'normal' | 'cancel' | 'recover' | 'dispose'> {
  const fail = async (): Promise<FilesScenarioEvidence> => {
    throw new Error(`${recipe} scenario was not requested`)
  }
  return { select: fail, normal: fail, cancel: fail, recover: fail, dispose: fail }
}

function authorityWorkspace(kind: Kind): WorkspacePort {
  const recipe = recipes(kind).workspace
  return {
    recipe,
    qualification: 'not-advertised',
    scenarios: ['deny'],
    ...unusedWorkspace(recipe),
    async deny() {
      const session = await openSession(kind)
      try {
        const outcome = await session.workspace.authorityFence({}, call())
        assert.equal(outcome.ok, false)
        if (outcome.ok) throw new Error('authority transfer was accepted')
        assert.equal(outcome.error.detailCode, 'unsupported')
        return evidence(session.workspace.providerDigest, recipe, 'authority transfer is not supported')
      } finally {
        await session.close()
      }
    },
  }
}

function authorityFiles(kind: Kind): FilesPort {
  const recipe = recipes(kind).files
  return {
    recipe,
    qualification: 'not-advertised',
    scenarios: ['deny'],
    ...unusedFiles(recipe),
    async deny() {
      const session = await openSession(kind)
      try {
        const outcome = await session.files.authorityFence({}, call())
        assert.equal(outcome.ok, false)
        if (outcome.ok) throw new Error('authority transfer was accepted')
        assert.equal(outcome.error.detailCode, 'unsupported')
        return evidence(session.files.providerDigest, recipe, 'authority transfer is not supported')
      } finally {
        await session.close()
      }
    },
  }
}

function kindOf(providerId: string): Kind | null {
  if (
    providerId === 'default' ||
    providerId === 'agh.default/workspace' ||
    providerId === 'agh.default/files'
  )
    return 'default'
  if (
    providerId === 'reference' ||
    providerId === 'agh.reference/workspace' ||
    providerId === 'agh.reference/files'
  )
    return 'reference'
  return null
}

const OWNED = ['agh.workspace', 'agh.files'] as const

export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  assert.notEqual(request.command, '')
  const wanted =
    request.contracts === 'all' ? [...OWNED] : OWNED.filter((name) => request.contracts.includes(name))
  if (wanted.length === 0) return { contracts: [], providers: [] }
  const matched = [...new Set(request.providers.filter((providerId) => kindOf(providerId) !== null))]
  if (matched.length === 0) return { contracts: wanted, providers: [] }
  const build = createBuild()
  for (const providerId of matched) {
    const kind = kindOf(providerId)
    if (kind === null) continue
    if (wanted.includes('agh.workspace')) {
      const workspace: WorkspaceConformanceBinding = {
        command: request.command,
        build,
        providerId,
        sources: [await workspacePort(kind), authorityWorkspace(kind)],
      }
      registerWorkspaceContract(harness, workspace)
    }
    if (wanted.includes('agh.files')) {
      const files: FilesConformanceBinding = {
        command: request.command,
        build,
        providerId,
        sources: [await filesPort(kind), authorityFiles(kind)],
      }
      registerFilesContract(harness, files)
    }
  }
  return { contracts: wanted, providers: matched }
}
