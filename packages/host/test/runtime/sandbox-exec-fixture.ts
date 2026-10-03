import {
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { WORKSPACE_SECRET_DIRS } from '@agnes/protocol'
import { createReferenceExec } from '../../../../examples/runtime-reference/src/providers/exec.js'
import { createReferenceSandbox } from '../../../../examples/runtime-reference/src/providers/sandbox.js'
import type * as W from '../../../protocol/src/runtime/index.js'
import { canonicalJsonDigest } from '../../../protocol/src/runtime/index.js'
import { createExecService, type ExecService } from '../../src/runtime/providers/exec.js'
import { createSandboxService, type SandboxService } from '../../src/runtime/providers/sandbox.js'
import { createWorkspaceService } from '../../src/runtime/providers/workspace.js'
import { requireLease } from '../../src/runtime/workspace-leases.js'
import { boundary, content, type Kind, must, scope, scratch } from './network-secrets-fixture.js'

export const limits: W.ResourceLimits = {
  cpuMs: 8000,
  wallMs: 10000,
  memoryBytes: 512 * 1024 * 1024,
  outputBytes: 65536,
  processes: 16,
  openFiles: 256,
}
export async function fixture(kind: Kind = 'default', directory = scratch()) {
  const auth = boundary()
  const roots = {
    workspace: join(directory, 'workspace'),
    home: join(directory, 'home'),
    data: join(directory, 'profile-data'),
  }
  for (const path of Object.values(roots)) mkdirSync(path, { recursive: true })
  for (const path of ['.git', ...WORKSPACE_SECRET_DIRS])
    mkdirSync(join(roots.workspace, path), { recursive: true })
  mkdirSync(join(roots.home, '.ssh'), { recursive: true })
  mkdirSync(join(roots.data, 'secrets'), { recursive: true })
  for (const key of ['workspace', 'home', 'data'] as const) roots[key] = realpathSync(roots[key])
  copyFileSync(new URL('./exec-workload.mjs', import.meta.url), join(roots.workspace, 'workload.mjs'))
  const workspace = createWorkspaceService({
    directory: join(directory, 'mounts'),
    authorityId: 'mount-authority',
    tenantId: 'tenant',
    leaseMs: 60000,
  })
  must(await workspace.bind('workspace', roots.workspace))
  const acquired = must(
    await workspace.acquire({ workspaceId: 'workspace', mode: 'write', expectedRevision: null }, auth.call()),
  )
  const mount = acquired.mountRef
  let live = true
  const policyBody = {
    scope,
    policyId: 'fixture-policy',
    compilerVersion: 'fixture-1',
    roots: [
      { kind: 'workspace' as const, mount: { workspaceId: mount.workspaceId, mountId: mount.mountId } },
      { kind: 'home' as const, mount: { workspaceId: 'home', mountId: 'home' } },
      { kind: 'data' as const, mount: { workspaceId: 'data', mountId: 'data' } },
    ],
    rules: [
      {
        root: 'workspace' as const,
        path: '',
        effect: 'allow' as const,
        access: ['read', 'write', 'stat', 'list'] as Array<'read' | 'write' | 'stat' | 'list'>,
      },
      ...(
        [
          ['workspace', '.git'],
          ...WORKSPACE_SECRET_DIRS.map((path) => ['workspace', path] as const),
          ['home', '.ssh'],
          ['data', 'secrets'],
        ] as const
      ).map(([root, path]) => ({
        root,
        path,
        effect: 'hard-deny' as const,
        access: ['read', 'write', 'stat', 'list'] as Array<'read' | 'write' | 'stat' | 'list'>,
      })),
    ],
  }
  const policy: W.FsPolicySnapshot = {
    ...policyBody,
    rules: policyBody.rules.map((rule) => ({ ...rule, access: [...rule.access] })),
    digest: canonicalJsonDigest(policyBody),
  }
  const sandboxOptions = {
    directory: join(directory, 'sandboxes'),
    authorityId: 'sandbox-authority',
    tenantId: 'tenant',
    roots,
    policy,
    readPaths: ['/usr', '/System', '/bin', '/dev/null', dirname(realpathSync(process.execPath))],
    networkPolicyRef: 'closed-network',
    identity: auth.identity,
    authorize: () => true,
    async mount(ref: W.MountRef) {
      if (!live || canonicalJsonDigest(ref) !== canonicalJsonDigest(mount)) throw new Error('Invalid mount')
      requireLease(workspace.store, { mount: ref, ownerId: 'actor', writing: true })
      return roots.workspace
    },
  }
  const sandbox: SandboxService =
    kind === 'default' ? createSandboxService(sandboxOptions) : createReferenceSandbox(sandboxOptions)
  const blobs = content(join(directory, 'content'))
  const execOptions = {
    directory: join(directory, 'executions'),
    authorityId: 'exec-authority',
    tenantId: 'tenant',
    scope,
    sandbox,
    identity: auth.identity,
    authorize: () => true,
    environment: { PATH: '/usr/bin:/bin', LANG: 'C' },
    literalNames: ['FIXTURE_VALUE'],
    content: {
      read: blobs.read,
      async retain(
        bytes: Uint8Array,
        context: import('../../../extension-api/src/runtime/index.js').CallContext,
      ) {
        const ref = await blobs.retain(bytes, context)
        const retention: W.RetentionRef = {
          kind: 'blob',
          authorityId: 'fixture-content',
          resourceId: ref.blobId,
          version: '1',
          digest: ref.digest,
          pinId: ref.pinId,
        }
        const blobFd = openSync(join(directory, 'content', ref.blobId), 'r')
        fsyncSync(blobFd)
        closeSync(blobFd)
        const pin = join(directory, 'content', retention.pinId)
        writeFileSync(pin, JSON.stringify(retention), { mode: 0o600 })
        const fd = openSync(pin, 'r')
        fsyncSync(fd)
        closeSync(fd)
        const parentFd = openSync(join(directory, 'content'), 'r')
        fsyncSync(parentFd)
        closeSync(parentFd)
        return { ref, retention }
      },
    },
  }
  const exec: ExecService =
    kind === 'default' ? createExecService(execOptions) : createReferenceExec(execOptions)
  const createInput: W.SandboxCreateRequest = {
    mode: 'isolated-process',
    workspaceRef: mount,
    filesystemPolicy: policy,
    networkPolicyRef: 'closed-network',
    resourceLimits: limits,
  }
  return {
    kind,
    directory,
    auth,
    roots,
    mount,
    policy,
    sandbox,
    exec,
    sandboxOptions,
    execOptions,
    createInput,
    async ready() {
      return must(await sandbox.create(createInput, auth.call()))
    },
    request(
      created: W.SandboxCreateResult,
      argv: string[],
      patch: Partial<W.ExecRequest> = {},
    ): W.ExecRequest {
      return {
        sandboxRef: created.sandboxRef,
        argv,
        cwd: { mount, path: '' },
        env: [],
        stdinRef: null,
        limits,
        ...patch,
      }
    },
    async release() {
      live = false
      must(await workspace.release({ leaseRef: mount.lease }, auth.call()))
    },
    async close() {
      await exec.close()
      await sandbox.close()
      workspace.close()
    },
    bytes(ref: W.BytesRef | null) {
      return ref ? readFileSync(join(directory, 'content', ref.blobId)) : Buffer.alloc(0)
    },
  }
}
