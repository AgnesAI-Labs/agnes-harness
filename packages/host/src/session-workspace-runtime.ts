import type {
  ApprovalSeam,
  CheckpointSeam,
  ChildWorkspaceRuntimePort,
  ChildWorkspaceLifecycle as CoreChildWorkspaceLifecycle,
  FsOps,
  FsPolicy,
  OpaqueSandboxConfine,
  SandboxSeam,
  SessionWorkspaceLifecycle,
  WorkspaceHookSandbox,
  WorkspaceInvocationLease,
  WorkspaceInvocationPort,
  WorkspaceInvocationSource,
} from '@agnes/core'
import { createWorkspaceInvocationPort } from '@agnes/core'
import type { HookInvocationSnapshot } from '@agnes/extension-api'
import type { FencedFs } from './adapters/fs.js'
import type {
  BoundSandboxReadiness,
  SandboxReadinessCapability,
  SandboxWorkspaceBackend,
} from './sandbox-readiness-manager.js'
import {
  assertWorkspaceBinding,
  inheritWorkspaceBinding,
  type WorkspaceBinding,
} from './workspace-authority.js'
import type { WorkspacePolicyPlan } from './workspace-policy.js'

export type WorkspaceRuntimeResource = Readonly<{ close(): Promise<void> | void }>

export type SessionWorkspaceRuntime = Readonly<{
  binding: WorkspaceBinding
  root: string
  fs: FsOps
  /** Host-only fenced operations available on production runtimes. */
  fencedFs?: FencedFs
  policy: FsPolicy
  sandbox: SandboxReadinessCapability
  sandboxBackend: SandboxWorkspaceBackend
  /** The table attaches the one session-bound invocation owner before publishing the runtime. */
  invocation?: WorkspaceInvocationPort
  /** Per-workspace fitted seam. Production factories always provide it before publication. */
  seam?: SandboxSeam
  hooks?: unknown
  services?: unknown
}>

export type WorkspaceRuntimeHandle = WorkspaceRuntimeResource &
  Readonly<{
    kind: 'local' | 'remote'
    root: string
  }>

export type WorkspaceRuntimeFence = WorkspaceRuntimeResource &
  Readonly<{
    root: string
    fs: FsOps
    bind(policy: FsPolicy): Promise<void> | void
    policyDigest(): string | null
  }>

export type SessionWorkspaceRuntimeFactoryInput = Readonly<{
  binding: WorkspaceBinding
  invocation?: WorkspaceInvocationPort
  signal?: AbortSignal
  openWorkspace(binding: WorkspaceBinding): Promise<WorkspaceRuntimeHandle>
  openFence(workspace: WorkspaceRuntimeHandle): Promise<WorkspaceRuntimeFence>
  compilePolicy(fence: WorkspaceRuntimeFence): Promise<WorkspacePolicyPlan>
  bindReadiness(
    input: Readonly<{
      workspace: WorkspaceRuntimeHandle
      fence: WorkspaceRuntimeFence
      plan: WorkspacePolicyPlan
    }>,
  ): BoundSandboxReadiness
  fitSandbox?(runtime: Omit<SessionWorkspaceRuntime, 'hooks' | 'services' | 'seam'>): Promise<SandboxSeam>
  openHooks?(runtime: Omit<SessionWorkspaceRuntime, 'hooks' | 'services'>): Promise<unknown>
  closeHooks?(hooks: unknown): Promise<void> | void
  openServices?(runtime: Omit<SessionWorkspaceRuntime, 'services'>): Promise<unknown>
  closeServices?(services: unknown): Promise<void> | void
}>

type RuntimeOwnership = Readonly<{ close(): Promise<void> }>
const runtimeOwnership = new WeakMap<object, RuntimeOwnership>()

const fault = (
  code: 'E_WORKSPACE_UNTRUSTED' | 'E_WORKSPACE_CLOSED' | 'E_WORKSPACE_REQUIRED' | 'E_SANDBOX_WORKSPACE',
  reason: string,
): Error & { code: string } => Object.assign(new Error(`${code}: ${reason}`), { code })

async function closeReverse(closers: Array<() => Promise<void> | void>): Promise<void> {
  const errors: unknown[] = []
  for (const close of closers.reverse()) {
    try {
      await close()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'workspace runtime cleanup failed')
}

/** Builds all per-session resources before the table can publish the runtime. */
export async function createSessionWorkspaceRuntime(
  input: SessionWorkspaceRuntimeFactoryInput,
): Promise<SessionWorkspaceRuntime> {
  assertWorkspaceBinding(input.binding)
  input.signal?.throwIfAborted()
  const closers: Array<() => Promise<void> | void> = []
  try {
    const workspace = await input.openWorkspace(input.binding)
    closers.push(() => workspace.close())
    input.signal?.throwIfAborted()
    if (workspace.kind === 'local' && workspace.root !== input.binding.canonicalRoot)
      throw fault('E_WORKSPACE_UNTRUSTED', 'local workspace handle differs from its authority')

    const fence = await input.openFence(workspace)
    closers.push(() => fence.close())
    if (fence.root !== workspace.root)
      throw fault('E_WORKSPACE_UNTRUSTED', 'workspace fence names a different root')
    const plan = await input.compilePolicy(fence)
    if (plan.policy.workspaceRoot !== fence.root)
      throw fault('E_WORKSPACE_UNTRUSTED', 'workspace policy names a different root')
    await fence.bind(plan.policy)
    if (fence.policyDigest() !== plan.policy.digest)
      throw fault('E_WORKSPACE_UNTRUSTED', 'workspace fence did not bind the compiled policy')

    const readiness = input.bindReadiness({ workspace, fence, plan })
    closers.push(() => readiness.revoke())
    const sandboxBackend = await readiness.capability.ready(input.signal)
    const base = Object.freeze({
      binding: input.binding,
      root: fence.root,
      fs: fence.fs,
      ...('resolveInside' in fence.fs && 'canonicalize' in fence.fs
        ? { fencedFs: fence.fs as FencedFs }
        : {}),
      policy: plan.policy,
      sandbox: readiness.capability,
      sandboxBackend,
      ...(input.invocation ? { invocation: input.invocation } : {}),
    })
    const seam = input.fitSandbox ? await input.fitSandbox(base) : undefined
    const withSeam = Object.freeze({ ...base, ...(seam === undefined ? {} : { seam }) })
    const hooks = input.openHooks ? await input.openHooks(withSeam) : undefined
    if (input.openHooks) closers.push(() => input.closeHooks?.(hooks))
    const withHooks = Object.freeze({ ...withSeam, ...(hooks === undefined ? {} : { hooks }) })
    const services = input.openServices ? await input.openServices(withHooks) : undefined
    if (input.openServices) closers.push(() => input.closeServices?.(services))
    const runtime: SessionWorkspaceRuntime = Object.freeze({
      ...withHooks,
      ...(services === undefined ? {} : { services }),
    })
    let closed = false
    runtimeOwnership.set(runtime, {
      close: async () => {
        if (closed) return
        closed = true
        await closeReverse(closers)
      },
    })
    return runtime
  } catch (error) {
    try {
      await closeReverse(closers)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'workspace runtime open and rollback failed')
    }
    throw error
  }
}

type RuntimeOwner = {
  runtime: SessionWorkspaceRuntime
  refs: number
  close?: Promise<void>
}

type RuntimeEntry = {
  runtime: SessionWorkspaceRuntime
  owner: RuntimeOwner
  leases: number
  state: 'reserved' | 'ready' | 'closing' | 'closed'
  idle?: Promise<void>
  resolveIdle?: () => void
}

type RuntimeInvocationLease = Readonly<{
  runtime: SessionWorkspaceRuntime
  release(): void
}>

export type ChildWorkspaceLifecycle = CoreChildWorkspaceLifecycle &
  Readonly<{
    runtime: SessionWorkspaceRuntime
    invocation: WorkspaceInvocationPort
    commit(): boolean
    close(): Promise<void>
  }>

const invocationLeases = new WeakSet<object>()

const unavailableApproval: ApprovalSeam = Object.freeze({
  ask: () => Promise.reject(fault('E_WORKSPACE_REQUIRED', 'workspace approval context is unavailable')),
  resume: () => Promise.reject(fault('E_WORKSPACE_REQUIRED', 'workspace approval context is unavailable')),
})

const unavailableCheckpoint: CheckpointSeam = Object.freeze({
  snapshot: () =>
    Promise.reject(fault('E_WORKSPACE_REQUIRED', 'workspace checkpoint context is unavailable')),
  rewind: () => Promise.reject(fault('E_WORKSPACE_REQUIRED', 'workspace checkpoint context is unavailable')),
  list: () => Promise.reject(fault('E_WORKSPACE_REQUIRED', 'workspace checkpoint context is unavailable')),
})

const unavailableHookSandbox: WorkspaceHookSandbox = Object.freeze({
  exec: () => Promise.reject(fault('E_WORKSPACE_REQUIRED', 'workspace hook sandbox is unavailable')),
  enforcement: () => {
    throw fault('E_WORKSPACE_REQUIRED', 'workspace hook sandbox is unavailable')
  },
})

function sameBinding(left: WorkspaceBinding, right: WorkspaceBinding): boolean {
  return (
    left.sessionKey === right.sessionKey &&
    left.workspaceId === right.workspaceId &&
    left.authorityRevision === right.authorityRevision &&
    left.canonicalRoot === right.canonicalRoot
  )
}

/** Owns publication, invocation leases, child aliases and the one reverse-order runtime cleanup. */
export class SessionWorkspaceRuntimeTable implements ChildWorkspaceRuntimePort {
  private readonly entries = new Map<string, RuntimeEntry>()
  private readonly opening = new Map<
    string,
    Readonly<{ binding: WorkspaceBinding; promise: Promise<SessionWorkspaceRuntime> }>
  >()
  /** A keyed close that won while create() was still in flight. */
  private readonly closingOpenings = new Map<string, Promise<void>>()
  /** Stable completed close result, retained until an explicit reopen of the key. */
  private readonly closedResults = new Map<string, Promise<void>>()
  private readonly closing = new Map<
    string,
    Readonly<{ promise: Promise<void>; root: string; policyDigest: string }>
  >()
  private readonly reservations = new Map<string, ChildWorkspaceLifecycle>()
  private readonly children = new Set<ChildWorkspaceLifecycle>()
  private readonly invocationPorts = new Map<string, WorkspaceInvocationPort>()
  private tableClosing = false

  open(
    binding: WorkspaceBinding,
    create: (invocation: WorkspaceInvocationPort) => Promise<SessionWorkspaceRuntime>,
  ): Promise<SessionWorkspaceRuntime> {
    assertWorkspaceBinding(binding)
    if (this.tableClosing) return Promise.reject(fault('E_WORKSPACE_CLOSED', 'workspace table is closing'))
    const closingOpening = this.closingOpenings.get(binding.sessionKey)
    if (closingOpening) return closingOpening.then(() => this.open(binding, create))
    const closing = this.closing.get(binding.sessionKey)
    if (closing) return closing.promise.then(() => this.open(binding, create))
    const existing = this.entries.get(binding.sessionKey)
    if (existing) {
      if (!sameBinding(existing.runtime.binding, binding))
        return Promise.reject(fault('E_WORKSPACE_UNTRUSTED', 'session already has another workspace'))
      return Promise.resolve(existing.runtime)
    }
    const pending = this.opening.get(binding.sessionKey)
    if (pending) {
      if (!sameBinding(pending.binding, binding))
        return Promise.reject(fault('E_WORKSPACE_UNTRUSTED', 'session is opening another workspace'))
      return pending.promise
    }
    this.closedResults.delete(binding.sessionKey)
    const promise = create(this.invocation(binding.sessionKey))
      .then(async (runtime) => {
        assertWorkspaceBinding(runtime.binding)
        if (!sameBinding(runtime.binding, binding)) {
          await this.closeUnpublished(runtime)
          throw fault('E_WORKSPACE_UNTRUSTED', 'runtime does not match its workspace authority')
        }
        if (this.tableClosing) {
          await this.closeUnpublished(runtime)
          throw fault('E_WORKSPACE_CLOSED', 'workspace table closed while opening')
        }
        if (this.closingOpenings.has(binding.sessionKey)) {
          await this.closeUnpublished(runtime)
          throw fault('E_WORKSPACE_CLOSED', 'workspace session closed while opening')
        }
        const published = this.publishRuntime(runtime, binding.sessionKey)
        const owner: RuntimeOwner = { runtime: published, refs: 1 }
        this.entries.set(binding.sessionKey, { runtime: published, owner, leases: 0, state: 'ready' })
        return published
      })
      .finally(() => {
        if (this.opening.get(binding.sessionKey)?.promise === promise) this.opening.delete(binding.sessionKey)
      })
    this.opening.set(binding.sessionKey, { binding, promise })
    return promise
  }

  peek(sessionKey: string):
    | Readonly<{
        root: string
        policyDigest: string
        state: 'ready' | 'closing'
      }>
    | undefined {
    const entry = this.entries.get(sessionKey)
    if (entry?.state === 'ready')
      return Object.freeze({
        root: entry.runtime.root,
        policyDigest: entry.runtime.policy.digest,
        state: 'ready',
      })
    const closing = this.closing.get(sessionKey)
    if (closing)
      return Object.freeze({
        root: closing.root,
        policyDigest: closing.policyDigest,
        state: 'closing',
      })
    return undefined
  }

  invocation(sessionKey: string): WorkspaceInvocationPort {
    const existing = this.invocationPorts.get(sessionKey)
    if (existing) return existing
    let port!: WorkspaceInvocationPort
    port = createWorkspaceInvocationPort(() => {
      if (this.invocationPorts.get(sessionKey) !== port)
        throw fault('E_WORKSPACE_CLOSED', 'workspace invocation port is revoked')
      const lease = this.acquire(sessionKey)
      const coreLease: WorkspaceInvocationLease = Object.freeze({
        source: this.invocationSource(lease.runtime),
        release: lease.release,
      })
      return coreLease
    })
    this.invocationPorts.set(sessionKey, port)
    return port
  }

  private acquire(sessionKey: string): RuntimeInvocationLease {
    if (this.tableClosing) throw fault('E_WORKSPACE_CLOSED', 'workspace table is closing')
    const entry = this.entries.get(sessionKey)
    if (entry?.state !== 'ready') throw fault('E_WORKSPACE_REQUIRED', 'session has no workspace runtime')
    return this.acquireEntry(entry)
  }

  private acquireEntry(entry: RuntimeEntry): RuntimeInvocationLease {
    entry.leases++
    let released = false
    const lease: RuntimeInvocationLease = Object.freeze({
      runtime: entry.runtime,
      release: () => {
        if (released) return
        released = true
        entry.leases--
        if (entry.leases < 0) throw fault('E_WORKSPACE_CLOSED', 'workspace lease underflow')
        if (entry.leases === 0) entry.resolveIdle?.()
      },
    })
    invocationLeases.add(lease)
    return lease
  }

  private invocationSource(runtime: SessionWorkspaceRuntime): WorkspaceInvocationSource {
    const services = runtime.services as
      | Readonly<{ approval?: ApprovalSeam; checkpoint?: CheckpointSeam }>
      | undefined
    const hooks = runtime.hooks as
      | Readonly<{ snapshot?: () => HookInvocationSnapshot | Promise<HookInvocationSnapshot> }>
      | undefined
    return Object.freeze({
      root: runtime.root,
      fs: runtime.fs,
      ready: async (signal?: AbortSignal): Promise<OpaqueSandboxConfine> => {
        const backend = await runtime.sandbox.ready(signal)
        return Object.freeze({
          confine: async (argv: readonly string[]) =>
            Object.freeze([...(await backend.confine({ argv, cwd: runtime.root }))]),
        })
      },
      hookSnapshot: (): Promise<HookInvocationSnapshot> => {
        if (typeof hooks?.snapshot !== 'function')
          return Promise.reject(fault('E_WORKSPACE_REQUIRED', 'workspace hooks are unavailable'))
        return Promise.resolve(hooks.snapshot())
      },
      hookSandbox: runtime.seam ?? unavailableHookSandbox,
      approval: services?.approval ?? unavailableApproval,
      checkpoint: services?.checkpoint ?? unavailableCheckpoint,
    })
  }

  private publishRuntime(runtime: SessionWorkspaceRuntime, sessionKey: string): SessionWorkspaceRuntime {
    const ownership = runtimeOwnership.get(runtime)
    if (!ownership) throw fault('E_WORKSPACE_UNTRUSTED', 'workspace runtime is not Host-owned')
    const published: SessionWorkspaceRuntime = Object.freeze({
      ...runtime,
      identity: runtime.binding,
      invocation: this.invocation(sessionKey),
    })
    runtimeOwnership.set(published, ownership)
    return published
  }

  async reserve(parentKey: string, childKey: string): Promise<ChildWorkspaceLifecycle> {
    if (this.tableClosing) throw fault('E_WORKSPACE_CLOSED', 'workspace table is closing')
    const parent = this.entries.get(parentKey)
    if (parent?.state !== 'ready') throw fault('E_WORKSPACE_REQUIRED', 'parent workspace is unavailable')
    if (
      this.entries.has(childKey) ||
      this.opening.has(childKey) ||
      this.closing.has(childKey) ||
      this.reservations.has(childKey)
    )
      throw fault('E_WORKSPACE_UNTRUSTED', 'child workspace key already exists')
    // Validate and construct every fallible child value before consuming an owner reference. An
    // invalid key must not strand a ref that no lifecycle token exists to release.
    const childBinding = inheritWorkspaceBinding(parent.runtime.binding, childKey)
    let entry!: RuntimeEntry
    const invocation = createWorkspaceInvocationPort(() => {
      if (this.tableClosing || (entry.state !== 'reserved' && entry.state !== 'ready'))
        throw fault('E_WORKSPACE_CLOSED', 'child workspace reservation is closed')
      const lease = this.acquireEntry(entry)
      return Object.freeze({
        source: this.invocationSource(entry.runtime),
        release: lease.release,
      })
    })
    const runtime = Object.freeze({
      ...parent.runtime,
      binding: childBinding,
      identity: childBinding,
      invocation,
    })
    entry = { runtime, owner: parent.owner, leases: 0, state: 'reserved' }
    // The reservation port is the child's canonical port before and after commit. Registering it
    // here also revokes any unbound placeholder previously obtained for this key, so a child never
    // has two live invocation identities pointing at the same runtime entry.
    this.invocationPorts.set(childKey, invocation)
    parent.owner.refs++
    let state: 'pending' | 'committed' | 'closed' = 'pending'
    let closePromise: Promise<void> | undefined
    const lifecycle: ChildWorkspaceLifecycle = Object.freeze({
      runtime,
      invocation,
      commit: () => {
        if (
          state !== 'pending' ||
          this.tableClosing ||
          this.entries.get(parentKey) !== parent ||
          parent.state !== 'ready' ||
          this.reservations.get(childKey) !== lifecycle ||
          this.entries.get(childKey) !== entry ||
          this.closing.has(childKey)
        )
          return false
        state = 'committed'
        entry.state = 'ready'
        this.reservations.delete(childKey)
        return true
      },
      close: () => {
        closePromise ??= (async () => {
          if (state === 'closed') return
          state = 'closed'
          this.children.delete(lifecycle)
          if (this.reservations.get(childKey) === lifecycle) this.reservations.delete(childKey)
          await this.close(childKey)
        })()
        return closePromise
      },
    })
    this.children.add(lifecycle)
    this.reservations.set(childKey, lifecycle)
    this.entries.set(childKey, entry)
    return lifecycle
  }

  lifecycle(sessionKey: string): SessionWorkspaceLifecycle {
    let closePromise: Promise<void> | undefined
    return Object.freeze({
      close: () => {
        closePromise ??= this.close(sessionKey)
        return closePromise
      },
    })
  }

  close(sessionKey: string): Promise<void> {
    const completed = this.closedResults.get(sessionKey)
    if (completed) return completed
    const active = this.closing.get(sessionKey)
    if (active) return active.promise
    const activeOpening = this.closingOpenings.get(sessionKey)
    if (activeOpening) return activeOpening
    const entry = this.entries.get(sessionKey)
    if (!entry) {
      const opening = this.opening.get(sessionKey)
      if (!opening) {
        const closed = Promise.resolve()
        this.closedResults.set(sessionKey, closed)
        this.invocationPorts.delete(sessionKey)
        return closed
      }
      let closingOpening!: Promise<void>
      closingOpening = opening.promise
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          if (this.closingOpenings.get(sessionKey) === closingOpening) this.closingOpenings.delete(sessionKey)
        })
      this.closingOpenings.set(sessionKey, closingOpening)
      this.closedResults.set(sessionKey, closingOpening)
      this.invocationPorts.delete(sessionKey)
      return closingOpening
    }
    this.entries.delete(sessionKey)
    this.invocationPorts.delete(sessionKey)
    entry.state = 'closing'
    const closing = (async () => {
      if (entry.leases > 0) {
        entry.idle ??= new Promise<void>((resolve) => {
          entry.resolveIdle = resolve
        })
        await entry.idle
      }
      entry.state = 'closed'
      await this.releaseOwner(entry.owner)
    })().finally(() => {
      if (this.closing.get(sessionKey)?.promise === closing) this.closing.delete(sessionKey)
    })
    this.closing.set(sessionKey, {
      promise: closing,
      root: entry.runtime.root,
      policyDigest: entry.runtime.policy.digest,
    })
    this.closedResults.set(sessionKey, closing)
    return closing
  }

  beginClose(): void {
    this.tableClosing = true
  }

  async finishCloseAll(): Promise<void> {
    this.tableClosing = true
    const pendingChildren = [...this.children].map((child) => child.close())
    const opened = await Promise.allSettled([...this.opening.values()].map(({ promise }) => promise))
    const failures = await Promise.allSettled([
      ...pendingChildren,
      ...[...this.entries.keys()].map((key) => this.close(key)),
      ...[...this.closing.values()].map(({ promise }) => promise),
    ])
    const rejected = [...opened, ...failures].filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (rejected.length)
      throw new AggregateError(
        rejected.map(({ reason }) => reason),
        'workspace runtime table close failed',
      )
  }

  closeAll(): Promise<void> {
    this.beginClose()
    return this.finishCloseAll()
  }

  private async releaseOwner(owner: RuntimeOwner): Promise<void> {
    owner.refs--
    if (owner.refs < 0) throw fault('E_WORKSPACE_CLOSED', 'workspace owner reference underflow')
    if (owner.refs !== 0) return
    owner.close ??= this.closeUnpublished(owner.runtime)
    await owner.close
  }

  private closeUnpublished(runtime: SessionWorkspaceRuntime): Promise<void> {
    const ownership = runtimeOwnership.get(runtime)
    if (!ownership)
      return Promise.reject(fault('E_WORKSPACE_UNTRUSTED', 'workspace runtime is not Host-owned'))
    return ownership.close()
  }
}
