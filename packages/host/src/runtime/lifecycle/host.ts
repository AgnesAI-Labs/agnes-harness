import { CoreError } from '@agnes/core'
import { isProfileDecisionJournal, rpcError } from '@agnes/protocol'
import { restoreRolePolicy, roleWorkspacePreset } from '../sessions/role-policy.js'
import '../provided-contracts.js'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Kernel, WorkspaceInvocationPort } from '@agnes/core'
import { HostError } from '@agnes/host-common/errors'
import { presetNameAllowed, selectionAllowed } from '@agnes/host-common/presets/admission'
import { legacyPermission } from '@agnes/host-common/presets/permission'
import { type ResolvedPreset, resolvePreset } from '@agnes/host-common/presets/resolve'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import { canonicalJson, sha256hex } from '@agnes/host-common/profile/canonical'
import { assertCompositionCompatible, loopPatch } from '@agnes/host-common/profile/composition'
import { withAssemblyIsolation } from '@agnes/host-common/profile/isolation'
import { modelProfileDeployment } from '@agnes/host-common/profile/model-compatibility'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import {
  type AuthenticatedWorkspaceBindingEnvelope,
  assertWorkspaceBinding,
  CliWorkspaceAuthority,
  type WorkspaceBinding,
  WorkspaceBindingAuthority,
} from '@agnes/host-common/workspace-authority'
import type { PackageLoader } from '@agnes/host-extensions/assemble/packages'
import type { ExtensionActivationBarrier } from '@agnes/host-extensions/ext-host/activation-barrier'
import type { ExtensionStatus } from '@agnes/host-extensions/ext-host/index'
import {
  markServicePreDispatchFailure,
  type ServiceEffectAdmission,
  type ServiceInspection,
} from '@agnes/host-extensions/ext-host/service-invocation'
import type { SkillRuntimeInput } from '@agnes/host-extensions/resources/skills'
import { type AuditSink, createFileAudit } from '@agnes/host-infrastructure/audit'
import {
  type SessionWorkspaceRuntime,
  SessionWorkspaceRuntimeTable,
} from '@agnes/host-infrastructure/session-workspace-runtime'
import type { LiveCompositionSession } from '@agnes/host-providers/profile/composition-state'
import { currentCorrelation } from '@agnes/observability'
import type { RuntimeTarget } from '@agnes/plugin-runtime/host'
import type { Actor, ExtensionCallParams, ExtensionCallResult, ThinkingLevel } from '@agnes/protocol'
import { readRuntimeSkillCandidates, type SkillCandidate } from '@agnes/resource-control-runtime'
import { startApprovalExpiry } from '../approval/expiry.js'
import { type AssembleDeps, type Assembled, assemble } from '../assemble/assemble.js'
import { createRuntimeGenerationHost, type PluginGenerationStatus } from '../generation/host.js'
import { createCompositionHost } from '../profile/composition-runtime.js'
import { trackHostComposition } from '../profile/composition-tracking.js'
import { resolveSessionCapabilities } from '../profile/session-capabilities.js'
import {
  type CreateSessionOptions,
  checkPresetHardRequirements,
  createSession as openSession,
  sessionKey,
  sessionPresetForOpen,
  sessionSelection,
} from '../sessions/session.js'
import {
  assertSandboxUnchanged,
  validateModelSwitch,
  validatePresetSwitch,
} from '../sessions/session-switch.js'
import { createTitleQueue, startSessionTitle } from '../sessions/session-title.js'
import { readStoredSessionView } from '../sessions/session-view.js'
import { adminSecurityStatus } from './admin-security-status.js'
import type { HostConvergenceReport, HostPublicationReport } from './host-facade.js'
import { registerHostIdle } from './host-idle.js'
import { closeHost } from './lifecycle.js'
import { reopenSelection } from './reopen-selection.js'

// core does not export a type named `Session`; it exports SessionImpl and SessionLogImpl. Taking the
// return type instead of pinning a name means a rename over there is not a break over here.
export type HostSession = Awaited<ReturnType<Kernel['session']>> & {
  /** Host-private policy snapshot for local author-code execution; never plugin arguments. */
  readonly commandSandboxPolicy?: () => {
    policy: import('@agnes/core').FsPolicy
    network: 'allow' | 'deny'
    local: boolean
  }
  readonly hasActiveProcesses?: () => boolean
  readonly intelligentUi?: Pick<
    import('@agnes/intelligent-ui-contract').IntelligentUiInstance,
    'action' | 'read' | 'refresh'
  >
  readonly pluginGenerationId?: string
  readonly referenceResolvers?: import('@agnes/extension-api').ReferenceResolverPort
  readonly referenceSessions?: import('@agnes/extension-api').ReferenceContext['sessions']
  readonly referenceLimits?: import('@agnes/extension-api').ReferenceLimits
}
export type HostOptions = Omit<AssembleDeps, 'audit' | 'loader'> & {
  audit?: AuditSink
  loader?: PackageLoader
  closeTimeoutMs?: number
  /** Test-only escape hatch: a scripted-provider test asserting an exact call sequence for some
   *  other concern (compaction, skill discovery, ...) has no scripted response to spare for the
   *  background title generation every session otherwise gets. Production callers never set this. */
  disableSessionTitle?: boolean
  /** Host-private per-binding runtime constructor. Required for authenticated multi-workspace opens. */
  openWorkspaceRuntime?: Assembled['openWorkspaceRuntime']
}

export interface Host {
  systemPromptPreview(
    config: import('@agnes/protocol').SystemPromptConfig,
  ): import('@agnes/protocol').SystemPromptSnapshot
  /** Description-only admin port; reads measured facts without probing or execution. */
  securityStatus?(): import('@agnes/protocol').RuntimeSecurityStatus
  resolveAgent?(ref: string): Promise<import('@agnes/protocol').AgentPlan>
  sessionBundleCatalog?(): Promise<ResolvedProfile['bundleCatalog']>
  /** Backend-only identity of the published execution configuration; never raw row config. */
  executionIdentity?(sessionKey?: string): string
  compositionSessions?(): readonly LiveCompositionSession[]
  sessionCapabilities?(sessionKey: string): import('@agnes/protocol').SessionCapabilitySet
  /** Backend snapshot through the real workspace Skill view, including for a not-yet-open role. */
  captureSessionCapabilities?: Assembled['captureSessionCapabilities']
  pluginGenerationStatus?(): PluginGenerationStatus
  /** Read-only status with cooperative integrity verification of historical snapshots. */
  pluginGenerationStatusAsync?(): Promise<PluginGenerationStatus>
  sessionGeneration?(sessionKey: string): string | undefined
  /** The outcome of the most recent publish, including a refusal and whether the previous state held. */
  lastChange?(): import('../generation/change-result.js').ChangeResult | undefined
  /** The container serving a generation, with the seam implementations it bound. */
  containerHandle?(generationId: string): import('../generation/change-result.js').ContainerHandle | undefined
  /** What a session is bound to: generation, loop and its pinned seam implementations. */
  sessionBinding?(sessionKey: string): import('../generation/change-result.js').SessionBinding | undefined
  /**
   * A bounded page of one session's raw ledger rows, read without opening the session, its
   * generation or its pinned implementations. A session that cannot continue on this build (a
   * different version, a missing provider) can still be read; nothing is written or locked.
   */
  readSessionRows(
    sessionKey: string,
    query: { fromSeq?: number; toSeq?: number; limit: number },
  ): Promise<import('@agnes/core').Event[]>
  /** The recorded conversation of one session, projected from its rows; see readSessionRows. */
  readSessionView(
    sessionKey: string,
    options?: { maxNodes?: number; signal?: AbortSignal },
  ): Promise<import('@agnes/protocol').SessionViewResult>
  /** Effective runtime of one open session; produced by the generation and composition owners. */
  sessionRuntime?(sessionKey: string): import('@agnes/protocol').SessionRuntimeDescriptor
  releaseSessionGeneration?(sessionKey: string): Promise<void>
  /** Privileged coordinator only: the caller must exclude concurrent admission for this idle session. */
  migrateSessionGeneration?(
    sessionKey: string,
    context?: {
      recoveryRequired?: () => boolean
      /** Pinned seam kinds the administrator agrees to replace; any other pinned change is refused. */
      repin?: readonly string[]
      /** Who asked, for the audit record. */
      operator?: string
    },
  ): Promise<{
    previousGenerationId: string
    generationId: string
    changed: boolean
    /** The pinned kinds that were replaced, when any were. */
    repinned?: readonly string[]
  }>
  compositionPublicationStatus?(): HostPublicationReport | undefined
  reloadPlugin?(id: string, directory?: string): Promise<{ generationId: string; changed: boolean }>
  collectPluginGenerations?(): Promise<void>
  /** Host-private immutable target projection for generation assembly. */
  runtimeTargetSnapshot?(): RuntimeTarget
  /** Current deployment only. Does not change the versions pinned by existing sessions. */
  runtimeSkillCandidates?(): readonly SkillCandidate[]
  /** Privileged coordination port. It is not reachable from ExtensionAPI or any wire request. */
  readonly activationBarrier: ExtensionActivationBarrier
  /** Authenticated management port. It is not registered as a model tool or extension service. */
  readonly approvalGrants: Assembled['approvalGrants']
  readonly profileServices?: Assembled['profileServices']
  resolveService(
    sessionId: string,
    names: readonly string[],
  ): Promise<
    | {
        extension: string
        packageId: string
        workspaceRoot: string
      }
    | undefined
  >
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
  authorizeServiceControl(
    params: ExtensionCallParams,
    operationId: string,
    credential: unknown,
    signal?: AbortSignal,
  ): ReturnType<Assembled['authorizeServiceControl']>
  applyModelProfile(next: ResolvedProfile): Promise<void | HostPublicationReport>
  readonly profile: ResolvedProfile
  readonly kernel: Kernel
  /** ERRATA B19: cli reads it for `agnes models` and for --probe. */
  readonly provider: Assembled['provider']
  readonly providerFingerprint: string | null
  /** Read-only descriptions from the currently assembled adapter registry. */
  modelAdapterCatalog: Assembled['modelAdapterCatalog']
  memory: Assembled['memory']
  readonly providers: Assembled['providers']
  /** The implementation each seam kind was bound to in this container. */
  seamBindings: Assembled['seamBindings']
  readonly runtimes: Assembled['runtimes']
  /** Read-only product status; mutation/session capabilities remain private to Host assembly. */
  readonly lockedPackageMutations: Pick<Assembled['lockedPackageMutations'], 'status'>
  /** Authenticated management port for platform-scoped Computer Use status and session YOLO mode. */
  readonly computerUse: Assembled['computerUse']
  readonly presets: Record<string, PresetDoc>
  /** Resolve an inbound credential through the deployment's fitted principals seam. Consumers use
   *  this for approval/participant actors instead of constructing ledger identities themselves. */
  resolveActor(credential: unknown, surface: 'session' | 'approval' | 'service'): Promise<Actor>
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
   * Cleanly unload and reload extension rows declaring live resource consumption with a
   * fresh resource snapshot, without restarting the worker process - see
   * `Assembled['reloadEcosystemExtension']` for the full contract. The declaration selects
   * the affected consumers.
   */
  reloadEcosystemExtension(
    id: string,
    freshInit: Readonly<{ skillResources?: SkillRuntimeInput }>,
  ): Promise<ExtensionStatus>
  /** Apply a fresh Skills resource view through all declaring extension rows. */
  refreshSkillRow(fresh: SkillRuntimeInput | undefined): Promise<void | HostPublicationReport>
  /** Latest worker-produced ordinary report, qualified by its exact desired tree hash. */
  ordinaryConvergence(): HostConvergenceReport
  /** Publish one complete canonical target through the assembly's sole RuntimeState pointer. */
  applyRuntimeTarget(target: RuntimeTarget): Promise<HostConvergenceReport>
  /** Drive the ext: rows on the tree. Stage 2 hands the same `apply` the daemon's composite rows. */
  readonly extensionRows: Omit<Assembled['extensionRows'], 'apply'> & {
    apply(rows: Parameters<Assembled['extensionRows']['apply']>[0]): Promise<HostConvergenceReport>
  }
  close(): Promise<void>
  /**
   * The gate a caller (daemon's `session.setPreset` RPC handler) must go through before ever calling
   * `session.setPreset()` on a live core session — `Assembled` never leaves this module, so this is
   * the only way to reach `validatePresetSwitch` from outside it. Throws `HostError` on an invalid
   * name; the caller passes `resolved.view` on to `session.setPreset()`.
   */
  validatePresetSwitch(name: string, sessionKey?: string): ResolvedPreset
  /** Same gate, for `session.setModel`. Throws `HostError` on a selection outside this deployment's
   *  assembled route table; the caller passes `sel` unchanged on to `session.setModel()`. */
  validateModelSwitch(
    sel: {
      slot: string
      route: string
      model: string
      thinking?: ThinkingLevel | null
      contextWindow?: number | null
    },
    sessionKey?: string,
  ): void
}

export async function createHost(profile: ResolvedProfile, opts: HostOptions): Promise<Host> {
  if (
    profile.composition ||
    profile.bundlePresets ||
    Object.keys(profile.bundleCatalog ?? {}).length > 0 ||
    opts.runtimePluginSources
  )
    return createCompositionHost(profile, opts, createHostInstance)
  const host = await createRuntimeGenerationHost(profile, opts, createHostInstance)
  if (
    Object.values(host.presets).some(
      (preset) => preset.composition || (Array.isArray(preset.bundles) && preset.bundles.length),
    )
  ) {
    await host.close()
    return createCompositionHost(profile, opts, createHostInstance)
  }
  try {
    return await trackHostComposition(host, profile, opts.profileDir)
  } catch (error) {
    await host.close()
    throw error
  }
}

async function createHostInstance(profile: ResolvedProfile, opts: HostOptions): Promise<Host> {
  profile = withAssemblyIsolation(profile, opts.extensionIsolation)
  const loader = opts.loader
  if (!loader)
    throw new HostError('E_DEP_MISSING', 'createHost needs a package loader', { detail: { field: 'loader' } })
  // Built only once the loader is known good: createFileAudit's constructor eagerly mkdir's, so
  // building it before this check left a real audit/ directory on disk behind a createHost() call
  // that was always going to refuse - a rejected assembly is supposed to have no side effects.
  const auditSink = opts.audit ?? createFileAudit(join(opts.dataDir, 'audit', 'host.jsonl'))
  const audit: AuditSink = {
    ...auditSink,
    write(event) {
      const correlation = currentCorrelation()
      auditSink.write(correlation ? { ...event, detail: { ...event.detail, ...correlation } } : event)
    },
  }
  audit.write({ kind: 'profile.resolved', detail: { hash: profile.hash, chain: profile.chain } })
  const workspaceRuntimes = new SessionWorkspaceRuntimeTable((key) => a.kernel.get(key)?.yolo === true)
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
  const host: Host = {
    activationBarrier: a.activationBarrier,
    approvalGrants: a.approvalGrants,
    profileServices: a.profileServices,
    resolveService: async (sessionId, names) => {
      if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
      const session = a.kernel.get(sessionId)
      if (!session || session.closingOrClosed) throw rpcError('CAPABILITY_DENIED')
      const binding = a.serviceBinding(names)
      return binding && { ...binding, workspaceRoot: session.workspaceRoot }
    },
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
    authorizeServiceControl: (params, operationId, credential, signal) => {
      if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
      return a.publicationDispatch.workspace(() => ({
        port: workspaceRuntimes.invocation(params.sessionId),
        handler: (view) => a.authorizeServiceControl(params, operationId, credential, view, signal),
      }))
    },
    get profile() {
      return profile
    },
    applyModelProfile(next) {
      const operation = modelApplication.then(async () => {
        if (closed) throw new HostError('E_HOST_CLOSED', 'host is closed')
        next = withAssemblyIsolation(next, opts.extensionIsolation)
        if (modelProfileDeployment(next) !== modelProfileDeployment(profile))
          throw new HostError('E_SEAM_IMMUTABLE', 'non-model configuration requires restart')
        await a.applyModelProfile(next)
        profile = next
      })
      modelApplication = operation.catch(() => undefined)
      return operation
    },
    kernel: a.kernel,
    readSessionRows: (sessionKey, { fromSeq, toSeq, limit }) =>
      a.kernel.o.storage.scan(sessionKey, {
        ...(fromSeq === undefined ? {} : { fromSeq }),
        ...(toSeq === undefined ? {} : { toSeq }),
        limit,
        order: 'asc',
      }),
    readSessionView: (sessionKey, options) => readStoredSessionView(a.kernel.o.storage, sessionKey, options),
    get provider() {
      return a.provider
    },
    get providerFingerprint() {
      return a.providerFingerprint
    },
    modelAdapterCatalog: () => a.modelAdapterCatalog(),
    memory: (workspaceRoot, sessionKey) => a.memory(workspaceRoot, sessionKey),
    providers: Object.freeze({ catalog: () => a.providers.catalog() }),
    seamBindings: () => a.seamBindings(),
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
    securityStatus: () =>
      adminSecurityStatus(
        profile,
        a.adapters.platform,
        a.presets,
        a.kernel.sessions.values(),
        workspaceRuntimes,
      ),
    systemPromptPreview(config) {
      if (!a.systemPromptProvider)
        throw new HostError('E_PRESET_UNSUPPORTED', 'system prompt provider is unavailable')
      const preset = resolvePreset(profile.presets.default, a.presets, a.sessionPresetLimits()).view
      const effective = { ...preset.model.systemPrompt, ...config }
      const provider = a.systemPromptProvider(effective.provider)
      const defaults = provider
        .defaults()
        .filter((section) =>
          preset.model.promptSections
            ? preset.model.promptSections.includes(section.id)
            : section.id !== 'channel-style' &&
              (preset.disclosure !== 'code' || section.id !== 'coding-doctrine'),
        )
      const sections = [...provider.compose(effective, defaults)]
      return {
        config: effective,
        effect: 'new-sessions',
        sections,
        hash: createHash('sha256')
          .update(sections.map((section) => section.text).join('\n\n'))
          .digest('hex'),
        preview: 'default-sections',
      }
    },
    presets: a.presets,
    sessionCapabilities: (key) => a.sessionCapabilities(key),
    captureSessionCapabilities: a.captureSessionCapabilities,
    resolveActor: (credential, surface) => a.seams.principals.resolve(credential, surface),
    acceptWorkspaceBinding: (envelope, expectedSessionKey) =>
      workspaceBindings.accept(envelope, expectedSessionKey),
    async createSession(o) {
      if (o.key && isProfileDecisionJournal(o.key))
        throw new CoreError('E_ENVELOPE', 'Reserved decision journal scope')
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
        o = await restoreRolePolicy(a.adapters.storage, o)
        if (!o.parent && o.preset === undefined) {
          const existingKey = o.key ?? o.binding?.sessionKey
          const existing = existingKey
            ? await a.adapters.storage.scan(existingKey, { type: 'session/start', order: 'desc', limit: 1 })
            : []
          if (!existing.length) {
            const preset = await a.sessionPresetDefault?.()
            // A recipe taken from the administrator's defaults is not a pre-split request for that
            // recipe by name, so the administrator's permission default applies with it.
            if (preset !== undefined)
              o = { ...o, preset, ...(o.permission === undefined ? { permission: 'default' } : {}) }
          }
        }
        if (!o.parent && o.defaultPermission === undefined) {
          const defaultPermission = await a.sessionPermissionDefault?.()
          if (defaultPermission !== undefined) o = { ...o, defaultPermission }
        }
        if (profile.composition) {
          const name = o.preset ?? profile.presets.default
          const adminLoop = await a.sessionLoopDefault?.()
          const selection = a.compositionForPreset(
            name,
            o.loop ? loopPatch(o.loop) : adminLoop ? loopPatch(adminLoop) : undefined,
          )
          assertCompositionCompatible(a.compositionForPreset(), selection)
          o = { ...o, loop: resolveSessionCapabilities({ composition: selection }).loop.value }
        }
        // A caller-supplied fitted seam may customize behavior, but it cannot replace workspace
        // authority. Every root session still gets a Host-minted binding and invocation owner.
        if (!o.binding && !o.parent) {
          if (!o.cwd || !cliWorkspaceAuthority)
            throw new HostError('E_WORKSPACE_REQUIRED', 'session needs authenticated workspace authority', {
              detail: { reason: 'workspace-binding-required' },
            })
          const selection = sessionSelection(profile, {
            ...(o.preset !== undefined ? { preset: o.preset } : {}),
            ...(o.permission !== undefined ? { permission: o.permission } : {}),
            ...(o.defaultPermission !== undefined ? { defaultPermission: o.defaultPermission } : {}),
          })
          const presetName = selection.name
          if (
            !selectionAllowed(
              profile,
              presetName,
              selection.permission ?? selection.fallback ?? legacyPermission(presetName),
            )
          )
            throw new HostError('E_PRESET_UNSUPPORTED', `preset ${presetName} is not in presets.allowed`, {
              detail: { source: presetName, capability: 'preset' },
            })
          checkPresetHardRequirements(
            profile,
            a,
            await sessionPresetForOpen(profile, a, presetName, o.key, selection),
            presetName,
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
          const inheritedView = o.parent ? a.kernel.get(o.parent.key)?.preset : undefined
          const inheritedPreset = inheritedView?.name
          if (!o.parent) {
            const [selection] = await a.adapters.storage.scan(binding.sessionKey, {
              type: ['session/start', 'x/core/preset-switch'],
              order: 'desc',
              limit: 1,
            })
            if (selection) {
              const data = selection.data as { preset?: unknown; to?: unknown } | null
              const persisted = selection.type === 'session/start' ? data?.preset : data?.to
              if (typeof persisted !== 'string')
                throw new HostError('E_PRESET_UNSUPPORTED', 'persisted sandbox preset is malformed')
              if (!presetNameAllowed(profile, persisted))
                throw new HostError('E_PRESET_UNSUPPORTED', 'persisted sandbox preset is no longer allowed')
              // The level is recorded once, at session/start; a later switch cannot change it.
              const [start] = await a.adapters.storage.scan(binding.sessionKey, {
                type: 'session/start',
                limit: 1,
              })
              const recorded = (start?.data as { permission?: unknown } | null | undefined)?.permission
              o = reopenSelection(o, persisted, recorded)
            }
          }
          const runtimeSelection = sessionSelection(profile, {
            ...(inheritedView ? { parent: inheritedView } : {}),
            ...(o.preset !== undefined ? { preset: o.preset } : {}),
            ...(o.permission !== undefined ? { permission: o.permission } : {}),
            ...(o.defaultPermission !== undefined ? { defaultPermission: o.defaultPermission } : {}),
          })
          let runtimePreset = resolvePreset(runtimeSelection.name, a.presets, {
            ...a.sessionPresetLimits(),
            ...(runtimeSelection.permission ? { permission: runtimeSelection.permission } : {}),
            ...(runtimeSelection.fallback ? { carry: runtimeSelection.fallback } : {}),
          }).doc
          runtimePreset = roleWorkspacePreset(runtimePreset, o.roleDelegation)
          const runtime = await workspaceRuntimes.open(binding, (invocation) =>
            openWorkspaceRuntime(binding, runtimePreset, invocation, o.roleDelegation?.filesystem),
          )
          workspace = Object.freeze({
            runtime,
            lifecycle: workspaceRuntimes.lifecycle(binding.sessionKey),
            children: workspaceRuntimes,
            invocation: workspaceRuntimes.invocation(binding.sessionKey),
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
        const offObservation = a.observeSession(s.key)
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
              offObservation()
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
      const resolved = validatePresetSwitch(profile, a, name, session.preset.permission)
      assertSandboxUnchanged(a, session.preset, resolved, name)
      if (profile.composition)
        assertCompositionCompatible(a.compositionForPreset(), a.compositionForPreset(name))
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
    runtimeTargetSnapshot: () => a.runtimeTargetSnapshot(),
    executionIdentity: () => {
      const target = a.runtimeTargetSnapshot()
      return sha256hex(canonicalJson({ tree: target.tree.hash, resource: target.resource.target }))
    },
    runtimeSkillCandidates: () => {
      if (closed || !opts.skillContribution) throw new Error('runtime Skill registry is unavailable')
      return readRuntimeSkillCandidates(opts.skillContribution, a.pluginTree.root, (id) =>
        a.pluginTree.tree.fiber(id),
      )
    },
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
    validatePresetSwitch: (name, sessionKey) => {
      if (profile.composition)
        assertCompositionCompatible(a.compositionForPreset(), a.compositionForPreset(name))
      // With a session named, the caller applies the result to it in process, so the session's own
      // permission carries over and the sandbox comparison runs here rather than only in the worker.
      const session = sessionKey ? a.kernel.get(sessionKey) : undefined
      const resolved = validatePresetSwitch(profile, a, name, session?.preset.permission)
      if (session) assertSandboxUnchanged(a, session.preset, resolved, name)
      return resolved
    },
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
        },
      })
      return closePromise
    },
  }
  return registerHostIdle(host, () => {
    const state = a.activationBarrier.snapshot()
    return (
      state.state === 'accepting' &&
      pendingSessionOpens.size === 0 &&
      sessions.size === 0 &&
      a.kernel.sessions.size === 0 &&
      workspaceRuntimes.isIdle &&
      Object.values(state.active).every((count) => count === 0) &&
      Object.values(state.queued).every((count) => count === 0)
    )
  })
}
