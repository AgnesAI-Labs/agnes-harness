import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { FsPolicy, FsRule } from '@agnes/core'
import { validateFsPolicy } from '@agnes/core'
import { WORKSPACE_SECRET_DIRS } from '@agnes/protocol'
import type { RemoteWorkspacePool } from '@agnes/sandbox-remote'
import type { WorkspaceRuntimeFence, WorkspaceRuntimeHandle } from '../session-workspace-runtime.js'
import { assertWorkspaceBinding, type WorkspaceBinding } from '../workspace-authority.js'
import type { WorkspacePathSemantics } from '../workspace-policy.js'
import { createPolicyExec, type ExecAdapter, type ExecGateState } from './exec.js'
import { createFs, type FencedFs, type FsBinding } from './fs.js'
import type { FsIo } from './fs-io.js'
import { localFsIo } from './fs-io-local.js'
import { createRemoteFsIo } from './fs-io-remote.js'
import type { PlatformBackend } from './platform.js'
import { probeCaseSensitive } from './platform-posix.js'
import type { RemoteTransport } from './remote-transport.js'

type HandleState = Readonly<{
  io: FsIo
  semantics: WorkspacePathSemantics
}>

export type SessionWorkspaceAdapterFactory = Readonly<{
  openWorkspace(binding: WorkspaceBinding): Promise<WorkspaceRuntimeHandle>
  openFence(handle: WorkspaceRuntimeHandle): Promise<SessionWorkspaceFence>
}>

export type SessionWorkspaceFence = WorkspaceRuntimeFence &
  Readonly<{
    semantics: WorkspacePathSemantics
    fs: FencedFs
    exec: ExecAdapter['run']
    activateGate(state: ExecGateState): void
    binding(): Readonly<{ policyDigest: string | null }>
  }>

const fault = (reason: string): Error & { code: 'E_WORKSPACE_UNTRUSTED' } =>
  Object.assign(new Error(`E_WORKSPACE_UNTRUSTED: ${reason}`), {
    code: 'E_WORKSPACE_UNTRUSTED' as const,
  })

function digest(root: string, rules: readonly FsRule[]): string {
  return createHash('sha256')
    .update(JSON.stringify(['agnes.session-workspace-bootstrap', 1, root, rules]))
    .digest('hex')
}

function pathApi(semantics: WorkspacePathSemantics): typeof posix | typeof win32 {
  return semantics.flavor === 'win32' ? win32 : posix
}

function samePath(left: string, right: string, semantics: WorkspacePathSemantics): boolean {
  return semantics.caseSensitive
    ? left === right
    : left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
}

function floorRules(root: string, semantics: WorkspacePathSemantics): readonly FsRule[] {
  const api = pathApi(semantics)
  return Object.freeze([
    Object.freeze({
      effect: 'deny' as const,
      path: api.join(root, '.git'),
      source: 'host-integrity',
      hard: true,
    }),
    ...WORKSPACE_SECRET_DIRS.map((dir) =>
      Object.freeze({
        effect: 'deny' as const,
        path: api.join(root, dir),
        source: 'host-integrity',
        hard: true,
      }),
    ),
  ])
}

async function localSemantics(platform: PlatformBackend, root: string): Promise<WorkspacePathSemantics> {
  return Object.freeze({
    flavor: platform.os === 'win32' ? ('win32' as const) : ('posix' as const),
    caseSensitive: platform.os === 'win32' ? false : probeCaseSensitive(root),
  })
}

/** Creates independent per-session workspace handles and policy cells over local or remote IO. */
export function createSessionWorkspaceAdapterFactory(
  input: Readonly<{
    platform: PlatformBackend
    exec: ExecAdapter
    transport?: RemoteTransport
    remotePool?: RemoteWorkspacePool
    /** Skill directories local reads may reach; a remote workspace never gets them. */
    skillReadRoots?: () => readonly string[]
  }>,
): SessionWorkspaceAdapterFactory {
  if ((input.transport === undefined) !== (input.remotePool === undefined))
    throw fault('remote transport and owner pool must be configured together')
  const handles = new WeakMap<object, HandleState>()

  return Object.freeze({
    async openWorkspace(binding): Promise<WorkspaceRuntimeHandle> {
      assertWorkspaceBinding(binding)
      if (input.remotePool && input.transport) {
        const lease = await input.remotePool.acquire(binding.sessionKey)
        const handle: WorkspaceRuntimeHandle = Object.freeze({
          kind: 'remote',
          root: lease.root,
          close: () => lease.close(),
        })
        handles.set(handle, {
          io: createRemoteFsIo(input.transport),
          semantics: Object.freeze({ flavor: 'posix', caseSensitive: false }),
        })
        return handle
      }

      let currentRoot: string
      try {
        currentRoot = await fsp.realpath(binding.canonicalRoot)
      } catch {
        throw fault('local workspace root is unavailable')
      }
      const semantics = await localSemantics(input.platform, currentRoot)
      if (!samePath(currentRoot, binding.canonicalRoot, semantics))
        throw fault('local workspace root identity changed')
      let closed = false
      const handle: WorkspaceRuntimeHandle = Object.freeze({
        kind: 'local',
        root: currentRoot,
        close: async () => {
          closed = true
        },
      })
      handles.set(handle, {
        io: Object.freeze({
          lstat: (...args) => {
            if (closed)
              throw Object.assign(new Error('E_WORKSPACE_CLOSED: workspace handle closed'), {
                code: 'E_WORKSPACE_CLOSED',
              })
            return localFsIo.lstat(...args)
          },
          readlink: (...args) => {
            if (closed)
              throw Object.assign(new Error('E_WORKSPACE_CLOSED: workspace handle closed'), {
                code: 'E_WORKSPACE_CLOSED',
              })
            return localFsIo.readlink(...args)
          },
          readFile: (...args) => {
            if (closed)
              throw Object.assign(new Error('E_WORKSPACE_CLOSED: workspace handle closed'), {
                code: 'E_WORKSPACE_CLOSED',
              })
            return localFsIo.readFile(...args)
          },
          writeFile: (...args) => {
            if (closed)
              throw Object.assign(new Error('E_WORKSPACE_CLOSED: workspace handle closed'), {
                code: 'E_WORKSPACE_CLOSED',
              })
            return localFsIo.writeFile(...args)
          },
          mkdir: (...args) => {
            if (closed)
              throw Object.assign(new Error('E_WORKSPACE_CLOSED: workspace handle closed'), {
                code: 'E_WORKSPACE_CLOSED',
              })
            return localFsIo.mkdir(...args)
          },
          readdir: (...args) => {
            if (closed)
              throw Object.assign(new Error('E_WORKSPACE_CLOSED: workspace handle closed'), {
                code: 'E_WORKSPACE_CLOSED',
              })
            return localFsIo.readdir(...args)
          },
          rm: (...args) => {
            if (closed)
              throw Object.assign(new Error('E_WORKSPACE_CLOSED: workspace handle closed'), {
                code: 'E_WORKSPACE_CLOSED',
              })
            return localFsIo.rm(...args)
          },
        }),
        semantics,
      })
      return handle
    },

    async openFence(handle): Promise<SessionWorkspaceFence> {
      const state = handles.get(handle)
      if (!state) throw fault('workspace handle was not created by this adapter factory')
      const floor = floorRules(handle.root, state.semantics)
      const bootstrap: FsPolicy = Object.freeze({
        workspaceRoot: handle.root,
        rules: Object.freeze([
          Object.freeze({ effect: 'allow', path: handle.root, source: 'workspace', hard: false }),
          ...floor,
        ]),
        networkAllow: Object.freeze([]),
        digest: digest(handle.root, floor),
      })
      let closed = false
      let bound: FsPolicy | undefined
      let gate: ExecGateState = { backend: 'none', onUnavailable: 'deny' }
      const holder: FsBinding = { policy: bootstrap, caseSensitive: state.semantics.caseSensitive }
      const fs = createFs(
        () => {
          if (closed)
            throw Object.assign(new Error('E_WORKSPACE_CLOSED: workspace fence closed'), {
              code: 'E_WORKSPACE_CLOSED',
            })
          return holder
        },
        state.io,
        handle.kind === 'local' ? input.skillReadRoots : undefined,
      )
      const exec = createPolicyExec(input.exec, {
        boundDigest: () => bound?.digest ?? null,
        state: () => gate,
        authorizeCwd: (cwd) => fs.resolveInside(cwd),
      })
      return Object.freeze({
        root: handle.root,
        fs,
        semantics: state.semantics,
        bind(policy) {
          if (closed)
            throw Object.assign(new Error('E_WORKSPACE_CLOSED: workspace fence closed'), {
              code: 'E_WORKSPACE_CLOSED',
            })
          if (bound) throw fault('workspace fence policy is already bound')
          validateFsPolicy(policy)
          if (!samePath(policy.workspaceRoot, handle.root, state.semantics))
            throw fault('workspace policy names another root')
          const hasFloor = floor.every((required) =>
            policy.rules.some(
              (rule) =>
                rule.effect === 'deny' && rule.hard && samePath(rule.path, required.path, state.semantics),
            ),
          )
          if (!hasFloor) throw fault('workspace policy omits the host integrity floor')
          bound = policy
          holder.policy = policy
        },
        exec,
        activateGate(next) {
          if (closed) throw fault('workspace fence closed')
          gate = Object.freeze({ ...next })
        },
        binding: () => Object.freeze({ policyDigest: bound?.digest ?? null }),
        policyDigest: () => bound?.digest ?? null,
        close: async () => {
          closed = true
        },
      } as SessionWorkspaceFence)
    },
  })
}
