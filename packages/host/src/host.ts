import { join } from 'node:path'
import {
  hasChildControl,
  type Kernel,
  recoverCreatingChildAttempts,
  type WorkspaceInvocationPort,
} from '@agnes/core'
import type { RuntimeConvergenceReport, RuntimeTarget } from '@agnes/plugin-runtime/host'
import type { Actor, ExtensionCallParams, ExtensionCallResult, ThinkingLevel } from '@agnes/protocol'
import { startApprovalExpiry } from './approval-expiry.js'
import type { PackageLoader } from './assemble/packages.js'
import { type AssembleDeps, type Assembled, assemble } from './assemble.js'
import { type AuditSink, createFileAudit } from './audit.js'
import { HostError } from './errors.js'
import type { ExtensionActivationBarrier } from './ext-host/activation-barrier.js'
import type { ExtensionStatus } from './ext-host/index.js'
import {
  markServicePreDispatchFailure,
  type ServiceEffectAdmission,
  type ServiceInspection,
} from './ext-host/service-invocation.js'
import { closeHost } from './lifecycle.js'
import { type ResolvedPreset, resolvePreset } from './presets/resolve.js'
import type { PresetDoc } from './presets/types.js'
import { withAssemblyIsolation } from './profile/isolation.js'
import type { ResolvedProfile } from './profile/types.js'
import type { SkillRuntimeInput } from './resources/skills.js'
import {
  type CreateSessionOptions,
  checkPresetHardRequirements,
  createSession as openSession,
  sessionKey,
} from './session.js'
import { validateModelSwitch, validatePresetSwitch } from './session-switch.js'
import { createTitleQueue, startSessionTitle } from './session-title.js'
import { type SessionWorkspaceRuntime, SessionWorkspaceRuntimeTable } from './session-workspace-runtime.js'
import {
  type AuthenticatedWorkspaceBindingEnvelope,
  assertWorkspaceBinding,
  CliWorkspaceAuthority,
  type WorkspaceBinding,
  WorkspaceBindingAuthority,
} from './workspace-authority.js'

// core does not export a type named `Session`; it exports SessionImpl and SessionLogImpl. Taking the
// return type instead of pinning a name means a rename over there is not a break over here.
export type HostSession = Awaited<ReturnType<Kernel['session']>>
export type HostOptions = Omit<AssembleDeps, 'audit' | 'loader'> & {
  audit?: AuditSink
  loader?: PackageLoader
  closeTimeoutMs?: number
  /** Test-only escape hatch: a scripted-provider test asserting an exact call sequence for some
   *  other concern (compaction, skill discovery, ...) has no scripted response to spare for the
   *  background title generation every session otherwise gets. Production callers never set this. */
  disableSessionTitle?: boolean
  /** Host-private per-binding runtime constructor. Required for authenticated multi-workspace opens. */
  openWorkspaceRuntime?(
    binding: WorkspaceBinding,
    preset?: PresetDoc,
    invocation?: import('@agnes/core').WorkspaceInvocationPort,
  ): Promise<SessionWorkspaceRuntime>
}

export interface Host {
  /** Privileged coordination port. It is not reachable from ExtensionAPI or any wire request. */
  readonly activationBarrier: ExtensionActivationBarrier
  /** Authenticated management port. It is not registered as a model tool or extension service. */
  readonly approvalGrants: Assembled['approvalGrants']
  callService(
    params: ExtensionCallParams,
    credential: unknown,
    signal?: AbortSignal,
    admission?: ServiceEffectAdmission,
  ): Promise<ExtensionCallResult>
  inspectService(
    params: ExtensionCallParams,
    credential: unknown,
    signal?: AbortSignal,
  ): Promise<ServiceInspection>
  applyModelProfile(next: ResolvedProfile): Promise<void>
  readonly profile: ResolvedProfile
  readonly kernel: Kernel
  /** ERRATA B19: cli reads it for `agnes models` and for --probe. */
  readonly provider: Assembled['provider']
  readonly providerFingerprint: string | null
  readonly runtimes: Assembled['runtimes']
  /** Read-only product status; mutation/session capabilities remain private to Host assembly. */
  readonly lockedPackageMutations: Pick<Assembled['lockedPackageMutations'], 'status'>
  /** Authenticated management port for platform-scoped Computer Use status and session YOLO mode. */
  readonly computerUse: Assembled['computerUse']
  readonly presets: Record<string, PresetDoc>
  /** Resolve an inbound credential through the deployment's fitted principals seam. Consumers use
   *  this for approval/participant actors instead of constructing ledger identities themselves. */
  resolveActor(credential: unknown, surface: 'session' | 'approval'): Promise<Actor>
  /** Authenticated worker-control decoder. Public RPC must never call this with caller data. */
  acceptWorkspaceBinding(
    envelope: AuthenticatedWorkspaceBindingEnvelope,
    expectedSessionKey: string,
  ): WorkspaceBinding
  createSession(opts: CreateSessionOptions): Promise<HostSession>
  /** Host-managed preset switch. Worker/RPC callers must not mutate Core sessions directly. */
  setSessionPreset(sessionKey: string, name: string): Promise<number>
  extensions(): ExtensionStatus[]
  /**
   * Cleanly unload and reload one already-loaded bundled ecosystem extension (`agnes/skills`) with a
   * fresh resource snapshot, without restarting the worker process - see
   * `Assembled['reloadEcosystemExtension']` for the full contract this delegates to. A thin
   * `revoke()`+`load()` wrapper.
   */
  reloadEcosystemExtension(
    id: string,
    freshInit: Readonly<{ skillResources?: SkillRuntimeInput }>,
  ): Promise<ExtensionStatus>
  /** Apply a fresh Skills resource view through its single builtin Cordis row. */
  refreshSkillRow(fresh: SkillRuntimeInput | undefined): Promise<void>
  /** Latest worker-produced ordinary report, qualified by its exact desired tree hash. */
  ordinaryConvergence(): RuntimeConvergenceReport
  /** Publish one complete canonical target through the assembly's sole RuntimeState pointer. */
  applyRuntimeTarget(target: RuntimeTarget): Promise<RuntimeConvergenceReport>
  /** Drive the ext: rows on the tree. Stage 2 hands the same `apply` the daemon's composite rows. */
  readonly extensionRows: Assembled['extensionRows']
  close(): Promise<void>
  /**
   * The gate a caller (daemon's `session.setPreset` RPC handler) must go through before ever calling
   * `session.setPreset()` on a live core session — `Assembled` never leaves this module, so this is
   * the only way to reach `validatePresetSwitch` from outside it. Throws `HostError` on an invalid
   * name; the caller passes `resolved.view` on to `session.setPreset()`.
   */
  validatePresetSwitch(name: string): ResolvedPreset
  /** Same gate, for `session.setModel`. Throws `HostError` on a selection outside this deployment's
   *  assembled route table; the caller passes `sel` unchanged on to `session.setModel()`. */
  validateModelSwitch(sel: { slot: string; route: string; model: string; thinking?: ThinkingLevel }): void
}

export async function createHost(profile: ResolvedProfile, opts: HostOptions): Promise<Host> {
  profile = withAssemblyIsolation(profile, opts.extensionIsolation)
  const loader = opts.loader
  if (!loader)
    throw new HostError('E_DEP_MISSING', 'createHost needs a package loader', { detail: { field: 'loader' } })
  // Built only once the loader is known good: createFileAudit's constructor eagerly mkdir's, so
  // building it before this check left a real audit/ directory on disk behind a createHost() call
  // that was always going to refuse - a rejected assembly is supposed to have no side effects.
  const audit = opts.audit ?? createFileAudit(join(opts.dataDir, 'audit', 'host.jsonl'))
  audit.write({ kind: 'profile.resolved', detail: { hash: profile.hash, chain: profile.chain } })
  const workspaceRuntimes = new SessionWorkspaceRuntimeTable()
  const a = await assemble(profile, {
    ...opts,
    loader,
    audit,
    workspaceInvocationFor: (sessionKey) => workspaceRuntimes.invocation(sessionKey),
    workspacePolicyDigestFor: (sessionKey) => {
      const runtime = workspaceRuntimes.peek(sessionKey)
      return runtime?.state === 'ready' ? runtime.policyDigest : undefined
    },
  })
  const computerUse = a.computerUse
  const sessions = new Set<HostSession>()
  const workspaceBindings = new WorkspaceBindingAuthority()
  const cliWorkspaceAuthority = a.adapters.transport
    ? undefined
    : new CliWorkspaceAuthority(await a.adapters.fs.canonicalize(opts.workspaceRoot))
  const scheduleTitle = createTitleQueue()
  const pendingSessionOpens = new Set<Promise<void>>()
  let modelApplication = Promise.resolve()
  let closed = false
  let closePromise: Promise<void> | undefined
  return {
    activationBarrier: a.activationBarrier,
    approvalGrants: a.approvalGrants,
    callService: (params, credential, signal, effectAdmission) => {
      if (closed) throw markServicePreDispatchFailure(new HostError('E_HOST_CLOSED', 'host is closed'))
      let entered = false
      let pending: Promise<ExtensionCallResult>
      try {
        pending = a.publicationDispatch.workspace(() => {
          const prepared = a.prepareService(params)
          return {
            port: workspaceRuntimes.invocation(prepared.params.sessionId),
            handler: (view) => {
              entered = true
              const activation = a.activationBarrier.admit('service')
              return activation.run(() =>
                a.callPreparedService(prepared, credential, view, signal, effectAdmission),
              )
            },
          }
        })
      } catch (error) {
        if (error && typeof error === 'object') markServicePreDispatchFailure(error)
        throw error
      }
      return pending.catch((error: unknown) => {
        if (!entered && error && typeof error === 'object') markServicePreDispatchFailure(error)
        throw error
      })
    },
    inspectService: (params, credential, signal) => {
      if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
      return a.publicationDispatch.workspace(() => {
        const prepared = a.prepareService(params)
        return {
          port: workspaceRuntimes.invocation(prepared.params.sessionId),
          handler: (view) => {
            const activation = a.activationBarrier.admit('service')
            return activation.run(() => a.inspectPreparedService(prepared, credential, view, signal))
          },
        }
      })
    },
    get profile() {
      return profile
    },
    applyModelProfile(next) {
      const operation = modelApplication.then(async () => {
        if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
        next = withAssemblyIsolation(next, opts.extensionIsolation)
        const fixed = (value: ResolvedProfile) => {
          const {
            provider: _provider,
            hash: _hash,
            chain: _chain,
            packages: _packages,
            adapters,
            ...rest
          } = value
          const { secrets: _secrets, ...fixedAdapters } = adapters
          return JSON.stringify({ ...rest, adapters: fixedAdapters })
        }
        if (fixed(next) !== fixed(profile))
          throw new HostError('E_SEAM_IMMUTABLE', 'non-model configuration requires restart')
        await a.applyModelProfile(next)
        profile = next
      })
      modelApplication = operation.catch(() => undefined)
      return operation
    },
    kernel: a.kernel,
    get provider() {
      return a.provider
    },
    get providerFingerprint() {
      return a.providerFingerprint
    },
    runtimes: a.runtimes,
    lockedPackageMutations: Object.freeze({ status: () => a.lockedPackageMutations.status() }),
    computerUse: computerUse
      ? Object.freeze({
          status: () => computerUse.status(),
          doctor: (params) => computerUse.doctor(params),
          permissionsStatus: () => computerUse.permissionsStatus(),
          permissionsGrant: () => computerUse.permissionsGrant(),
          setSessionYolo: (session: Readonly<{ key: string; lane: string }>, enabled: boolean) =>
            computerUse.setSessionYolo(session, enabled),
          operationStart: (kind) => computerUse.operationStart(kind),
          operationStatus: (operationId) => computerUse.operationStatus(operationId),
          operationCancel: (operationId) => computerUse.operationCancel(operationId),
        })
      : undefined,
    presets: a.presets,
    resolveActor: (credential, surface) => a.seams.principals.resolve(credential, surface),
    acceptWorkspaceBinding: (envelope, expectedSessionKey) =>
      workspaceBindings.accept(envelope, expectedSessionKey),
    async createSession(o) {
      // A lifecycle condition gets a lifecycle code. The old one raised E_SEAM_IMMUTABLE - the code
      // for "a seam implementation may not be swapped" - and the test only grepped /closed/, so the
      // mismatch was invisible from both sides.
      if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed', { detail: { reason: 'closed' } })
      let finishOpening!: () => void
      const opening = new Promise<void>((resolve) => {
        finishOpening = resolve
      })
      pendingSessionOpens.add(opening)
      try {
        // A caller-supplied fitted seam may customize behavior, but it cannot replace workspace
        // authority. Every root session still gets a Host-minted binding and invocation owner.
        if (!o.binding && !o.parent) {
          if (!o.cwd || !cliWorkspaceAuthority)
            throw new HostError('E_WORKSPACE_REQUIRED', 'session needs authenticated workspace authority', {
              detail: { reason: 'workspace-binding-required' },
            })
          const presetName = o.preset ?? profile.presets.default
          if (!profile.presets.allowed.includes(presetName))
            throw new HostError('E_PRESET_UNSUPPORTED', `preset ${presetName} is not in presets.allowed`, {
              detail: { source: presetName, capability: 'preset' },
            })
          checkPresetHardRequirements(
            profile,
            a,
            resolvePreset(presetName, a.presets, a.sessionPresetLimits()),
            presetName,
            undefined,
          )
          let canonicalRoot: string
          try {
            canonicalRoot = await a.adapters.fs.canonicalize(o.cwd)
          } catch {
            throw new HostError('E_WORKSPACE_UNTRUSTED', 'cwd is not the configured local workspace', {
              detail: { reason: 'cwd-outside-workspace' },
            })
          }
          if (canonicalRoot !== cliWorkspaceAuthority.canonicalRoot)
            throw new HostError('E_WORKSPACE_UNTRUSTED', 'cwd is not the configured local workspace', {
              detail: { reason: 'cwd-outside-workspace' },
            })
          const actor = await a.seams.principals.resolve(o.credential ?? { kind: 'local' }, 'session')
          const key = o.key ?? sessionKey(profile, actor, canonicalRoot)
          o = { ...o, key, cwd: canonicalRoot, binding: cliWorkspaceAuthority.bind(key) }
        }
        let workspace:
          | Readonly<{
              runtime: SessionWorkspaceRuntime
              lifecycle: ReturnType<SessionWorkspaceRuntimeTable['lifecycle']>
              children: SessionWorkspaceRuntimeTable
              invocation: WorkspaceInvocationPort
            }>
          | undefined
        let pendingChildWorkspace: Awaited<ReturnType<SessionWorkspaceRuntimeTable['reserve']>> | undefined
        if (o.binding && o.parent) {
          const binding = o.binding as WorkspaceBinding
          assertWorkspaceBinding(binding)
          const childKey = o.key
          if (!childKey)
            throw new HostError('E_WORKSPACE_REQUIRED', 'fork child needs a stable session key', {
              detail: { reason: 'child-session-key-required' },
            })
          pendingChildWorkspace = await workspaceRuntimes.reserve(o.parent.key, childKey)
          const inherited = pendingChildWorkspace.runtime.binding
          if (
            binding.sessionKey !== inherited.sessionKey ||
            binding.workspaceId !== inherited.workspaceId ||
            binding.authorityRevision !== inherited.authorityRevision ||
            binding.canonicalRoot !== inherited.canonicalRoot
          ) {
            await pendingChildWorkspace.close()
            pendingChildWorkspace = undefined
            throw new HostError(
              'E_WORKSPACE_UNTRUSTED',
              'fork binding does not inherit its parent workspace',
              {
                detail: { reason: 'fork-binding-mismatch' },
              },
            )
          }
          workspace = Object.freeze({
            runtime: pendingChildWorkspace.runtime,
            lifecycle: pendingChildWorkspace,
            children: workspaceRuntimes,
            invocation: pendingChildWorkspace.invocation,
          })
        } else if (o.binding) {
          const openWorkspaceRuntime = opts.openWorkspaceRuntime ?? a.openWorkspaceRuntime
          const binding = o.binding as WorkspaceBinding
          const inheritedPreset = o.parent ? a.kernel.get(o.parent.key)?.preset.name : undefined
          const runtimePreset = resolvePreset(
            inheritedPreset ?? o.preset ?? profile.presets.default,
            a.presets,
            a.sessionPresetLimits(),
          ).doc
          const runtime = await workspaceRuntimes.open(binding, (invocation) =>
            openWorkspaceRuntime(binding, runtimePreset, invocation),
          )
          workspace = Object.freeze({
            runtime,
            lifecycle: workspaceRuntimes.lifecycle(o.binding.sessionKey),
            children: workspaceRuntimes,
            invocation: workspaceRuntimes.invocation(o.binding.sessionKey),
          })
        } else if (o.parent) {
          const childKey = o.key
          if (!childKey)
            throw new HostError('E_WORKSPACE_REQUIRED', 'fork child needs a stable session key', {
              detail: { reason: 'child-session-key-required' },
            })
          pendingChildWorkspace = await workspaceRuntimes.reserve(o.parent.key, childKey)
          workspace = Object.freeze({
            runtime: pendingChildWorkspace.runtime,
            lifecycle: pendingChildWorkspace,
            children: workspaceRuntimes,
            invocation: pendingChildWorkspace.invocation,
          })
        }
        let s: HostSession
        try {
          s = await openSession(profile, a, o, audit, workspace)
          try {
            await computerUse?.setSessionYolo({ key: s.key, lane: s.lane }, s.yolo)
          } catch (error) {
            await s.close().catch((cleanupError) => {
              throw new AggregateError(
                [error, cleanupError],
                'Computer Use permission synchronization and session cleanup failed',
              )
            })
            throw error
          }
          if (pendingChildWorkspace && !pendingChildWorkspace.commit()) {
            await s.close().catch(() => undefined)
            throw new HostError('E_WORKSPACE_CLOSED', 'fork workspace closed before publication', {
              detail: { reason: 'child-workspace-commit-lost' },
            })
          }
        } catch (error) {
          // Kernel keeps a live session in its table on a duplicate-open mismatch. That session owns
          // the existing workspace entry, so only an open that left no live session is rolled back.
          if (o.binding && !a.kernel.get(o.binding.sessionKey))
            await workspaceRuntimes.close(o.binding.sessionKey).catch(() => undefined)
          await pendingChildWorkspace?.close().catch(() => undefined)
          throw error
        }
        const run = s.run.bind(s)
        ;(s as HostSession & { run: HostSession['run'] }).run = (options) => {
          const invocation = a.activationBarrier.admit('turn')
          return invocation.run(() => run(options)) as ReturnType<HostSession['run']>
        }
        // Register before the initial expiry pass so a startup storage error is still covered by the
        // Host's cleanup path. The session is removed again after its lease has been released below.
        sessions.add(s)
        // Keep expiry with the Host session rather than with a daemon endpoint. Local, worker and
        // direct Host callers all receive the same lifecycle, and closing any of them stops the wake
        // loop before core releases its writer lease.
        let expiry: Awaited<ReturnType<typeof startApprovalExpiry>>
        try {
          expiry = await startApprovalExpiry(s, {
            onError: (error) =>
              opts.log.error('approval expiry failed', {
                sessionKey: s.key,
                message: error instanceof Error ? error.message : String(error),
              }),
          })
        } catch (error) {
          try {
            await s.close()
            sessions.delete(s)
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'session expiry startup and cleanup failed')
          }
          throw error
        }
        const close = s.close.bind(s)
        let title: Awaited<ReturnType<typeof startSessionTitle>> | undefined
        if (!opts.disableSessionTitle) {
          try {
            title = await startSessionTitle(s, {
              schedule: scheduleTitle,
              onError: () => opts.log.warn('session title background task failed', { sessionKey: s.key }),
            })
          } catch {
            // Title metadata is optional; failure must not refuse a usable session.
            opts.log.warn('session title initialization failed', { sessionKey: s.key })
          }
        }
        ;(s as HostSession & { close: () => Promise<void> }).close = async () => {
          try {
            await title?.close()
            await expiry.close()
          } finally {
            try {
              await a.unbindRuntimeSession(s.key)
              await close()
            } finally {
              sessions.delete(s)
            }
          }
        }
        try {
          await a.bindRuntimeSession(s.key, s.preset.name)
        } catch (error) {
          await s.close()
          throw error
        }
        if (closed) {
          await s.close()
          throw new HostError('E_HOST_CLOSED', 'host closed while session was opening', {
            detail: { reason: 'closed-during-open' },
          })
        }
        return s
      } finally {
        pendingSessionOpens.delete(opening)
        finishOpening()
      }
    },
    async setSessionPreset(sessionKey, name) {
      if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
      const session = a.kernel.get(sessionKey)
      if (!session)
        throw new HostError('E_DEP_MISSING', `session ${sessionKey} is not open`, {
          detail: { sessionKey, reason: 'session-not-open' },
        })
      const resolved = validatePresetSwitch(profile, a, name)
      return session.setPreset(resolved.view)
    },
    extensions: () => a.extensionStatus(),
    reloadEcosystemExtension: (id, freshInit) => {
      if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
      return a.reloadEcosystemExtension(id, freshInit)
    },
    refreshSkillRow: (fresh) => {
      if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
      return a.refreshSkillRow(fresh)
    },
    ordinaryConvergence: () => a.ordinaryConvergence(),
    applyRuntimeTarget: (target) => {
      if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
      return a.applyRuntimeTarget(target)
    },
    // Same fail-closed boundary as `applyRuntimeTarget` above: `apply` publishes a tree and
    // `prepare` mutates the assembly's builtin-claim catalogue, so neither may run on a closed Host.
    extensionRows: {
      current: () => a.extensionRows.current(),
      prepare: (input) => {
        if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
        return a.extensionRows.prepare(input)
      },
      apply: async (rows) => {
        if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
        return a.extensionRows.apply(rows)
      },
    },
    validatePresetSwitch: (name) => validatePresetSwitch(profile, a, name),
    validateModelSwitch: (sel) => validateModelSwitch(profile, a, sel),
    close() {
      if (closePromise) return closePromise
      closed = true
      const timeoutMs = opts.closeTimeoutMs ?? profile.limits['shutdown.grace_ms'] ?? 10_000
      closePromise = closeHost(a, sessions, {
        timeoutMs,
        audit,
        pendingOpenings: [...pendingSessionOpens, modelApplication],
        beforeRollback: async () => {
          workspaceRuntimes.beginClose()
          await workspaceRuntimes.finishCloseAll()
          if (hasChildControl(a.adapters.storage)) {
            const now = opts.clock?.() ?? Date.now()
            await recoverCreatingChildAttempts(a.adapters.storage, { staleBefore: now, now })
          }
        },
      })
      return closePromise
    },
  }
}
