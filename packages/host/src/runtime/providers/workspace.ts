import { realpath, stat } from 'node:fs/promises'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import {
  acquireLease,
  bindWorkspace,
  checked,
  type LeaseView,
  openWorkspaceStore,
  parsed,
  releaseLease,
  runtimeError,
  StoreFault,
  type WorkspaceStore,
} from '../workspace-leases.js'

export const WORKSPACE_CONTRACT = 'agh.workspace'
export const DEFAULT_WORKSPACE_PROVIDER_ID = 'agh.default/workspace'

export type AuthorityDirectoryRead = {
  read(request: Wire.AuthorityDirectoryReadRequest): Promise<Outcome<Wire.AuthorityDirectoryReadResult>>
}

export type WorkspaceServiceOptions = {
  directory?: string
  store?: WorkspaceStore
  authorityId: Wire.Id
  tenantId: Wire.Id
  providerId?: Wire.Id
  generation?: number
  leaseMs?: number
  /** Deployment-selected reader; route publication remains a maintenance responsibility. */
  directoryRead?: AuthorityDirectoryRead
}

export type WorkspaceService = {
  readonly binding: Wire.BindingRef
  readonly providerDigest: string
  readonly store: WorkspaceStore
  readonly generation: number
  bind(
    workspaceId: Wire.Id,
    root: string,
  ): Promise<Outcome<{ revision: Wire.Revision; canonicalRoot: string }>>
  acquire(request: unknown, context: CallContext): Promise<Outcome<Wire.WorkspaceAcquireResult>>
  release(request: unknown, context: CallContext): Promise<Outcome<Wire.WorkspaceReleaseResult>>
  authorityFence(request: unknown, context: CallContext): Promise<Outcome<never>>
  close(): void
}

const unsupported = (context: CallContext): Outcome<never> => {
  if (context.signal.aborted) return { ok: false, error: runtimeError('cancelled', 'call was cancelled') }
  return { ok: false, error: runtimeError('unsupported', 'authority transfer is not supported') }
}

function stamp(ms: number): Wire.Timestamp {
  return new Date(ms).toISOString()
}

function scopedWorkspace(scope: Wire.ScopeRef): string | undefined {
  if (scope.kind === 'installation' || scope.kind === 'runtime') return undefined
  return scope.workspaceId
}

function mountOf(authorityId: Wire.Id, lease: LeaseView): Wire.WorkspaceAcquireResult {
  const leaseRef = checked('LeaseRef', {
    authorityId,
    leaseId: lease.leaseId,
    epoch: lease.epoch,
    expiresAt: stamp(lease.expiresAt),
  })
  return checked('WorkspaceAcquireResult', {
    mountRef: {
      workspaceId: lease.workspaceId,
      mountId: lease.mountId,
      revision: lease.revision,
      lease: leaseRef,
    },
    revision: lease.revision,
    leaseRef,
  })
}

async function guard<T>(context: CallContext, body: () => Promise<T> | T): Promise<Outcome<T>> {
  if (context.signal.aborted) return { ok: false, error: runtimeError('cancelled', 'call was cancelled') }
  try {
    return { ok: true, value: await body() }
  } catch (error) {
    if (error instanceof StoreFault) return { ok: false, error: runtimeError(error.detail, error.message) }
    throw error
  }
}

export function createWorkspaceService(options: WorkspaceServiceOptions): WorkspaceService {
  if (options.store === undefined && (options.directory === undefined || options.directory === ''))
    throw new Error('workspace service needs a directory or a store')
  const store = options.store ?? openWorkspaceStore({ directory: options.directory as string })
  const ownsStore = options.store === undefined
  const providerId = options.providerId ?? DEFAULT_WORKSPACE_PROVIDER_ID
  const generation = options.generation ?? 1
  const leaseMs = options.leaseMs ?? 60_000
  let closed = false
  const binding = checked('BindingRef', {
    bindingId: `${providerId}/binding`,
    contract: WORKSPACE_CONTRACT,
    logicalName: 'workspace',
    providerId,
  })
  const providerDigest = canonicalJsonDigest({
    contract: WORKSPACE_CONTRACT,
    providerId,
    recipe: 'sqlite-lease',
  })
  const live = () => {
    if (closed) throw new StoreFault('blocked', 'service is closed')
  }
  return {
    binding,
    providerDigest,
    store,
    generation,
    async bind(workspaceId, root) {
      try {
        live()
        let info: Awaited<ReturnType<typeof stat>>
        try {
          info = await stat(root)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            throw new StoreFault('not_found', 'workspace root is not a directory')
          throw error
        }
        if (!info.isDirectory()) throw new StoreFault('invalid_request', 'workspace root is not a directory')
        const canonicalRoot = await realpath(root)
        return {
          ok: true,
          value: bindWorkspace(store, {
            workspaceId,
            canonicalRoot,
            tenantId: options.tenantId,
            resourceKey: canonicalRoot,
          }),
        }
      } catch (error) {
        if (error instanceof StoreFault)
          return { ok: false, error: runtimeError(error.detail, error.message) }
        throw error
      }
    },
    async acquire(request, context) {
      return guard(context, async () => {
        live()
        const body = parsed('WorkspaceAcquireRequest', request)
        const scopeWorkspace = scopedWorkspace(context.scope)
        if (scopeWorkspace !== body.workspaceId)
          throw new StoreFault('permission_denied', 'workspace is outside the caller scope')
        if (options.directoryRead) {
          try {
            const looked = await options.directoryRead.read({
              kind: 'authority',
              logicalAuthorityId: body.workspaceId,
            })
            if (
              !looked.ok ||
              !validateRuntime('AuthorityDirectoryReadResult', looked.value).ok ||
              looked.value.kind !== 'authority' ||
              looked.value.route.logicalAuthorityId !== body.workspaceId ||
              looked.value.route.tenantId !== options.tenantId ||
              looked.value.route.locationRef !== body.workspaceId
            )
              throw new StoreFault('permission_denied', 'authority location does not match the workspace')
          } catch {
            throw new StoreFault('permission_denied', 'authority directory is unavailable or incompatible')
          }
        }
        const lease = acquireLease(store, {
          workspaceId: body.workspaceId,
          tenantId: options.tenantId,
          mode: body.mode,
          ownerId: context.principalRef,
          generation,
          invocationId: context.invocationId,
          expectedRevision: body.expectedRevision,
          leaseMs,
        })
        return mountOf(options.authorityId, lease)
      })
    },
    async release(request, context) {
      return guard(context, () => {
        live()
        const body = parsed('WorkspaceReleaseRequest', request)
        const released = releaseLease(store, {
          leaseId: body.leaseRef.leaseId,
          epoch: body.leaseRef.epoch,
          ownerId: context.principalRef,
          generation,
        })
        return checked('WorkspaceReleaseResult', { released })
      })
    },
    authorityFence(_request, context) {
      if (closed) return Promise.resolve({ ok: false, error: runtimeError('blocked', 'service is closed') })
      return Promise.resolve(unsupported(context))
    },
    close() {
      closed = true
      if (ownsStore) store.close()
    },
  }
}

export function refusalOf(error: unknown): Wire.RuntimeError {
  if (error instanceof StoreFault) return runtimeError(error.detail, error.message)
  return runtimeError('internal_error', 'workspace service failed')
}
