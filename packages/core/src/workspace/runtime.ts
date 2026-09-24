import type { HookInvocationSnapshot } from '@agnes/extension-api'
import type { ApprovalRequest, ApprovalSeam, CheckpointSeam, SandboxSeam, Verdict } from '../effects/seams.js'
import type { FsOps } from '../effects/tool-context.js'
import type { SessionKey } from '../types.js'
import { CoreError } from '../types.js'

/** A canonical workspace root is identity data. Possessing it grants no filesystem authority. */
export type CanonicalWorkspaceId = string

/** The filesystem surface exposed by an invocation. Every method is guarded by one shared token. */
export type RevocableFsOps = Readonly<FsOps>

/** Root-bound sandbox capability. Callers cannot choose another cwd, backend, policy, or probe. */
export interface OpaqueSandboxConfine {
  confine(argv: readonly string[]): Promise<readonly string[]>
}

/**
 * Session-fitted hook process capability guarded by the same invocation token as its snapshot.
 * `track` is carried only on the Host-private symbol context. It joins non-sandbox hook work (the
 * raw handler and isolated HTTP/event capabilities) to this invocation without exposing the scope.
 */
export type WorkspaceHookSandbox = Readonly<
  Pick<SandboxSeam, 'exec' | 'enforcement'> & {
    track?<T>(start: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T>
  }
>

/** Approval operations bound to the invocation's workspace scope. */
export type ApprovalWorkspaceContext = ApprovalSeam

/** Checkpoint operations bound to the invocation's workspace scope. */
export type CheckpointWorkspaceContext = CheckpointSeam

/** The only workspace capabilities an invocation may retain. All callable members are revocable. */
export interface WorkspaceInvocationView {
  readonly root: CanonicalWorkspaceId
  fs(): RevocableFsOps
  ready(signal?: AbortSignal): Promise<OpaqueSandboxConfine>
  hookSnapshot(): Promise<HookInvocationSnapshot>
  hookSandbox(): WorkspaceHookSandbox
  approvalContext(): ApprovalWorkspaceContext
  checkpointContext(): CheckpointWorkspaceContext
}

/**
 * Starts one invocation. Implementations acquire synchronously, then run the callback on the next
 * microtask and release only after every registered descendant has settled.
 */
export interface WorkspaceInvocationPort {
  run<T>(invoke: (view: WorkspaceInvocationView) => Promise<T>): Promise<T>
}

/** Host-injected publication admission; Core stays independent of the publication implementation. */
export interface WorkspacePublicationDispatch {
  workspace<T>(
    resolve: () => Readonly<{
      port: WorkspaceInvocationPort
      handler: (view: WorkspaceInvocationView) => T | Promise<T>
    }>,
  ): Promise<Awaited<T>>
}

/** Raw Host-owned inputs. This object is consumed by the scope builder and never reaches callers. */
export type WorkspaceInvocationSource = Readonly<{
  root: CanonicalWorkspaceId
  fs: FsOps
  ready(signal?: AbortSignal): Promise<OpaqueSandboxConfine>
  hookSnapshot(): Promise<HookInvocationSnapshot>
  hookSandbox: WorkspaceHookSandbox
  approval: ApprovalSeam
  checkpoint: CheckpointSeam
}>

/** Host lease adapter used to give the Core scope builder sole release ownership. */
export type WorkspaceInvocationLease = Readonly<{
  source: WorkspaceInvocationSource
  release(): Promise<void> | void
}>

/** Internal capability wrappers use this token to join the invocation's descendant drain. */
export interface WorkspaceInvocationToken {
  readonly signal: AbortSignal
  assertOpen(): void
  track<T>(
    start: (signal: AbortSignal) => T | PromiseLike<T>,
    options?: Readonly<{ cancelOnAbort?: boolean }>,
  ): Promise<T>
}

const closed = (): CoreError => new CoreError('E_WORKSPACE_CLOSED', 'workspace invocation is closed')

class InvocationScope implements WorkspaceInvocationToken {
  private readonly controller = new AbortController()
  private readonly descendants = new Set<Promise<void>>()
  private readonly revokers = new Set<() => void>()
  private state: 'open' | 'closing' | 'revoked' = 'open'

  get signal(): AbortSignal {
    return this.controller.signal
  }

  assertOpen(): void {
    if (this.state !== 'open') throw closed()
  }

  track<T>(
    start: (signal: AbortSignal) => T | PromiseLike<T>,
    options: Readonly<{ cancelOnAbort?: boolean }> = {},
  ): Promise<T> {
    try {
      this.assertOpen()
    } catch (error) {
      return Promise.reject(error)
    }

    let settle!: () => void
    const descendant = new Promise<void>((resolve) => {
      settle = resolve
    })
    // Registration happens before start() can execute user or adapter code.
    this.descendants.add(descendant)

    let raw: Promise<T>
    try {
      raw = Promise.resolve(start(this.controller.signal))
    } catch (error) {
      raw = Promise.reject(error)
    }
    void raw.catch(() => undefined)
    const result = options.cancelOnAbort
      ? new Promise<T>((resolve, reject) => {
          const onAbort = () => reject(this.controller.signal.reason ?? closed())
          raw.then(
            (value) => {
              this.controller.signal.removeEventListener('abort', onAbort)
              resolve(value)
            },
            (error: unknown) => {
              this.controller.signal.removeEventListener('abort', onAbort)
              reject(error)
            },
          )
          this.controller.signal.addEventListener('abort', onAbort, { once: true })
        })
      : raw
    // Cancellation may let the caller stop waiting, but it does not prove the adapter stopped.
    // Keep the lease until the underlying operation itself settles.
    raw.then(settle, settle)
    void result.catch(() => undefined)
    void descendant.then(() => this.descendants.delete(descendant))
    return result
  }

  subscription(
    register: (listener: (value: string) => void) => () => void,
    listener: (value: string) => void,
  ) {
    this.assertOpen()
    let active = true
    const dispose = register((value) => {
      if (this.state === 'open' && active) listener(value)
    })
    const revoke = () => {
      if (!active) return
      active = false
      this.revokers.delete(revoke)
      dispose()
    }
    this.revokers.add(revoke)
    return revoke
  }

  async close(): Promise<void> {
    if (this.state !== 'open') return
    this.state = 'closing'
    this.controller.abort(closed())
    const errors: unknown[] = []
    for (const revoke of [...this.revokers]) {
      try {
        revoke()
      } catch (error) {
        errors.push(error)
      }
    }
    await Promise.all([...this.descendants])
    this.state = 'revoked'
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'workspace invocation revoke failed')
  }
}

function linkedSignal(
  scope: AbortSignal,
  caller?: AbortSignal,
): Readonly<{
  signal: AbortSignal
  close(): void
}> {
  if (!caller) return Object.freeze({ signal: scope, close: () => undefined })
  const controller = new AbortController()
  const abortFrom = (signal: AbortSignal) => controller.abort(signal.reason)
  const fromScope = () => abortFrom(scope)
  const fromCaller = () => abortFrom(caller)
  if (scope.aborted) fromScope()
  else scope.addEventListener('abort', fromScope, { once: true })
  if (caller.aborted) fromCaller()
  else caller.addEventListener('abort', fromCaller, { once: true })
  return Object.freeze({
    signal: controller.signal,
    close: () => {
      scope.removeEventListener('abort', fromScope)
      caller.removeEventListener('abort', fromCaller)
    },
  })
}

function immutableJson<T>(value: T, ancestors = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  if (ancestors.has(value)) throw new CoreError('E_ENVELOPE', 'cyclic workspace hook snapshot')
  ancestors.add(value)
  if (Array.isArray(value)) {
    for (const item of value) immutableJson(item, ancestors)
    ancestors.delete(value)
    return Object.freeze(value) as T
  }
  for (const item of Object.values(value)) immutableJson(item, ancestors)
  ancestors.delete(value)
  return Object.freeze(value)
}

function invocationView(source: WorkspaceInvocationSource, scope: InvocationScope): WorkspaceInvocationView {
  const guard = source.approval.guard
  const listGrants = source.approval.listGrants
  const putGrant = source.approval.putGrant
  const revokeGrant = source.approval.revokeGrant
  const onGrantRevoked = source.approval.onGrantRevoked
  const fs: RevocableFsOps = Object.freeze({
    read: (path, opts) => scope.track(() => source.fs.read(path, opts)),
    write: (path, data) => scope.track(() => source.fs.write(path, data)),
    list: (path) => scope.track(() => source.fs.list(path)),
    stat: (path) => scope.track(() => source.fs.stat(path)),
  })
  const approval: ApprovalWorkspaceContext = Object.freeze({
    ask: (request: ApprovalRequest) =>
      scope.track(() => source.approval.ask(request), { cancelOnAbort: true }),
    resume: (ticket: string, verdict: Verdict) =>
      scope.track(() => source.approval.resume(ticket, verdict), { cancelOnAbort: true }),
    ...(guard
      ? {
          guard: (request: Parameters<typeof guard>[0]) =>
            scope.track(() => guard.call(source.approval, request), { cancelOnAbort: true }),
        }
      : {}),
    ...(listGrants
      ? {
          listGrants: (query: Parameters<typeof listGrants>[0]) =>
            scope.track(() => listGrants.call(source.approval, query), { cancelOnAbort: true }),
        }
      : {}),
    ...(putGrant
      ? {
          putGrant: (grant: Parameters<typeof putGrant>[0]) =>
            scope.track(() => putGrant.call(source.approval, grant), { cancelOnAbort: true }),
        }
      : {}),
    ...(revokeGrant
      ? {
          revokeGrant: (grantId: string, revokedAt: string) =>
            scope.track(() => revokeGrant.call(source.approval, grantId, revokedAt), {
              cancelOnAbort: true,
            }),
        }
      : {}),
    ...(onGrantRevoked
      ? {
          onGrantRevoked: (listener: (grantId: string) => void) =>
            scope.subscription(onGrantRevoked.bind(source.approval), listener),
        }
      : {}),
  })
  const checkpoint: CheckpointWorkspaceContext = Object.freeze({
    snapshot: (paths: string[], stepId: string) =>
      scope.track(() => source.checkpoint.snapshot(paths, stepId)),
    rewind: (id: string) => scope.track(() => source.checkpoint.rewind(id)),
    list: () => scope.track(() => source.checkpoint.list()),
  })
  const hookSandbox: WorkspaceHookSandbox = Object.freeze({
    track: <T>(start: (signal: AbortSignal) => T | PromiseLike<T>) => scope.track(start),
    enforcement: () => {
      scope.assertOpen()
      return immutableJson(structuredClone(source.hookSandbox.enforcement()))
    },
    exec: (command, options) =>
      scope.track(async (scopeSignal) => {
        const linked = linkedSignal(scopeSignal, options.signal)
        try {
          return await source.hookSandbox.exec(command, { ...options, signal: linked.signal })
        } finally {
          linked.close()
        }
      }),
  })

  return Object.freeze({
    root: source.root,
    fs: () => {
      scope.assertOpen()
      return fs
    },
    ready: (signal?: AbortSignal) =>
      scope.track(async (scopeSignal) => {
        const linked = linkedSignal(scopeSignal, signal)
        try {
          const backend = await source.ready(linked.signal)
          return Object.freeze({
            confine: (argv: readonly string[]) =>
              scope.track(async () => Object.freeze([...(await backend.confine(argv))])),
          })
        } finally {
          linked.close()
        }
      }),
    hookSnapshot: () =>
      scope.track(async () => {
        const snapshot = structuredClone(await source.hookSnapshot())
        return immutableJson(snapshot)
      }),
    hookSandbox: () => {
      scope.assertOpen()
      return hookSandbox
    },
    approvalContext: () => {
      scope.assertOpen()
      return approval
    },
    checkpointContext: () => {
      scope.assertOpen()
      return checkpoint
    },
  })
}

async function cleanupInvocation(scope: InvocationScope, lease: WorkspaceInvocationLease): Promise<void> {
  const errors: unknown[] = []
  try {
    await scope.close()
  } catch (error) {
    errors.push(error)
  }
  try {
    await lease.release()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'workspace invocation cleanup failed')
}

/** Build the standard synchronous-acquire, next-microtask invocation owner. */
export function createWorkspaceInvocationPort(
  acquire: () => WorkspaceInvocationLease,
): WorkspaceInvocationPort {
  return Object.freeze({
    run<T>(invoke: (view: WorkspaceInvocationView) => Promise<T>): Promise<T> {
      // Deliberately outside a Promise constructor/async function: PublicationGate callers know the
      // authoritative lease is registered when run() returns.
      const lease = acquire()
      const scope = new InvocationScope()
      let view: WorkspaceInvocationView
      try {
        view = invocationView(lease.source, scope)
      } catch (error) {
        return cleanupInvocation(scope, lease).then(
          () => Promise.reject(error),
          (cleanupError: unknown) =>
            Promise.reject(
              new AggregateError(
                [error, cleanupError],
                'workspace invocation construction and cleanup failed',
              ),
            ),
        )
      }
      const invoked = Promise.resolve().then(() => invoke(view))
      return invoked.then(
        async (value) => {
          await cleanupInvocation(scope, lease)
          return value
        },
        async (error: unknown) => {
          try {
            await cleanupInvocation(scope, lease)
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'workspace invocation and cleanup failed')
          }
          throw error
        },
      )
    },
  })
}

/** Non-capability identity a Session may expose without leaking the Host runtime. */
export type WorkspaceSessionIdentity = Readonly<{
  sessionKey: string
  workspaceId: string
  authorityRevision: number
  canonicalRoot: string
}>

/** Host-owned runtime payload consumed during Kernel session construction only. */
export type SessionWorkspaceRuntime = Readonly<{
  fs: FsOps
  invocation?: WorkspaceInvocationPort
  identity?: WorkspaceSessionIdentity
}>

/** The only close authority SessionImpl retains for its workspace runtime. */
export interface SessionWorkspaceLifecycle {
  close(): Promise<void>
}

/** A pending child alias. Its state is pending -> committed -> closed or pending -> closed. */
export interface ChildWorkspaceLifecycle extends SessionWorkspaceLifecycle {
  readonly runtime: SessionWorkspaceRuntime
  commit(): boolean
}

/** Host-owned reservation boundary used by the default child factory. */
export interface ChildWorkspaceRuntimePort {
  reserve(parentKey: SessionKey, childKey: SessionKey): Promise<ChildWorkspaceLifecycle>
}
