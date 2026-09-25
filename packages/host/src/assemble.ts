import { lstatSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type CurrentSessionRuntime,
  type Enforcement,
  type HookPort,
  hasChildControl,
  Kernel,
  noopHooks,
  type Operation,
  type PresetView,
  platformFacts,
  recoverCreatingChildAttempts,
  type SandboxExecBackend,
  type SeamImplementations,
  type SeamName,
} from '@agnes/core'
import { API_VERSION, type ExtensionManifest, type LeaseView } from '@agnes/extension-api'
import type { RuntimePluginSnapshot } from '@agnes/package-manager'
import {
  createMutableSeamImplementations,
  type EntryRow,
  type RuntimeConvergenceReport,
  type RuntimeTarget,
} from '@agnes/plugin-runtime/host'
import type { ComputerUseDoctorParams, RouteTable } from '@agnes/protocol'
import { privateArtifactDeleteAvailable } from '@agnes/system-node'
import type { AdapterBundle } from './adapters/index.js'
import {
  createNetFetch,
  lazyPackageTables,
  openAdapters,
  sandboxHostServices,
  toSeamAdapters,
} from './adapters/index.js'
import { createPlatform } from './adapters/platform.js'
import { powerShellCommand } from './adapters/powershell-command.js'
import { createPublicFetch } from './adapters/public-fetch/index.js'
import { composeSecrets, createSecretsEnv, createSecretsFile } from './adapters/secrets.js'
import type { SessionWorkspaceFence } from './adapters/session-workspace.js'
import { type ApprovalGrantManagement, createApprovalGrantControlPlane } from './approval-grants.js'
import { assembleCompaction } from './assemble/compaction.js'
import { bindModelContracts } from './assemble/contracts.js'
import {
  buildExtensionRow,
  composeExtensionRowTarget,
  type DynamicExtension,
  EXT_ROW_EXTENSION_IDS,
  EXT_ROW_MOUNT_REVISION,
  type ExtRowLoader,
  extensionRowGrantFor,
  MIGRATED_EXTENSION_IDS,
} from './assemble/ext-rows.js'
import { bindExtensionInvocations } from './assemble/extension-ports.js'
import { isolationInventory } from './assemble/isolation-inventory.js'
import { modelRuntime } from './assemble/model-runtime.js'
import { buildOrdinaryRows } from './assemble/ordinary-rows.js'
import type {
  LoadedRuntimePackage,
  OperationDeps,
  PackageModule,
  RuntimeFactory,
  SeamInitContext,
  SeamProfileView,
  SkillRuntimeDiscovery,
} from './assemble/packages.js'
import { loadRuntimePackage } from './assemble/packages.js'
import { buildPresetRows } from './assemble/preset-rows.js'
import { buildProvider, readCreditsPerUsd, unresolvedProviderAssembly } from './assemble/provider.js'
import { materializeRoutes, pinPresetRoutes, sweepAwsDestination, verifyRoutes } from './assemble/routes.js'
import { buildSeamRows, REQUIRED_SEAM_ROW_IDS } from './assemble/seam-rows.js'
import { initStaticSeams } from './assemble/seams.js'
import type { HostBuiltinRowClaim, HostPluginTreeBase } from './assemble/seams-cordis.js'
import { SKILL_ROW_ID, skillRowRevision, withSkillRow } from './assemble/skill-row.js'
import { trustedHookCommands } from './assemble/trusted-hooks.js'
import type { AssembleDeps } from './assembly-deps.js'
import fixedComputerUseDriverLock from './computer-use/computer-use-driver-lock.json' with { type: 'json' }
import {
  evaluateFixedComputerUsePlatformAdmission,
  inspectComputerUseDriverLock,
} from './computer-use/driver-lock.js'
import {
  type ComputerUseDriverOperationKind,
  type ComputerUseDriverOperationSnapshot,
  createComputerUseDriverOperationRuntime,
} from './computer-use/driver-operation-runtime.js'
import { createComputerUseHostDispatchPort } from './computer-use/host-dispatch.js'
import { type ComputerUseAvailability, createLazyComputerUseRuntime } from './computer-use/lazy-runtime.js'
import { createLinuxComputerUseBackendProvider } from './computer-use/linux-driver-backend.js'
import {
  doctorLockedLinuxComputerUseDriver,
  installOrUpdateLockedLinuxComputerUseDriver,
} from './computer-use/linux-driver-install.js'
import {
  createHostLockedPackageMutationRuntime,
  type HostLockedPackageMutationRuntime,
} from './computer-use/locked-package-mutation-runtime.js'
import {
  createMacOSComputerUseBackendProvider,
  grantMacOSComputerUsePermissions,
  probeMacOSComputerUsePermissions,
} from './computer-use/macos-driver-backend.js'
import {
  doctorLockedMacOSComputerUseDriver,
  installOrUpdateLockedMacOSComputerUseDriver,
} from './computer-use/macos-driver-install.js'
import {
  type ComputerUseBackendProvider,
  createWindowsComputerUseBackendProvider,
} from './computer-use/windows-driver-backend.js'
import {
  doctorLockedWindowsComputerUseDriver,
  installOrUpdateLockedWindowsComputerUseDriver,
} from './computer-use/windows-driver-install.js'
import {
  type ComputerUseArtifactGcRuntime,
  createComputerUseArtifactGcRuntime,
} from './computer-use-artifact-gc.js'
import { HostError, type HostErrorCode } from './errors.js'
import { createExtensionActivationBarrier } from './ext-host/activation-barrier.js'
import { type BuiltinRowHandle, createBuiltinRowHost } from './ext-host/builtin-row-host.js'
import {
  createExtensionFactorySelector,
  validateExtensionIsolation,
} from './ext-host/extension-isolation-selector.js'
import { ExtensionOwners } from './ext-host/extension-owners.js'
import { createExtensionOrder, mergeExtensionStatus } from './ext-host/extension-status-book.js'
import { createManagedExtHost, type ExtensionSpec, type ExtensionStatus } from './ext-host/index.js'
import { readAuthorManifest, readBundledExtensionDirs } from './ext-host/manifest.js'
import { preflightEmbeddedExtension, preflightExtension } from './ext-host/preflight.js'
import { createRowExtensionHost } from './ext-host/row-extension-host.js'
import { createRowServiceHost } from './ext-host/row-services.js'
import { serviceContext } from './ext-host/service-context.js'
import { serviceInvoker } from './ext-host/service-invocation.js'
import { ServiceRegistry } from './ext-host/services.js'
import { ExtensionSessions } from './ext-host/session-bindings.js'
import { Rollback } from './lifecycle.js'
import { resolvePreset } from './presets/resolve.js'
import type { PresetDoc } from './presets/types.js'
import { createPrivateArtifactStore } from './private-artifact-store.js'
import { withAssemblyIsolation } from './profile/isolation.js'
import type { ResolvedProfile } from './profile/types.js'
import {
  bindApprovalTicket,
  businessLimit,
  commandHookInvocationSnapshot,
  createHotPolicyFacade,
} from './profile-policy.js'
import { PublicationDispatch } from './publication-dispatch.js'
import { PublicationGate } from './publication-gate.js'
import { HostQuietState } from './quiet-state.js'
import { createProductionImageInputTokenFallback } from './request-media-runtime.js'
import { bindSkillRuntimeToWorkspace, createSkillPromptPreloader } from './resources/skill-preload.js'
import { safeSkillReadRoots } from './resources/skill-read-roots.js'
import type { SkillRuntimeInput } from './resources/skills.js'
import {
  type GenerationRegistries,
  generationRegistries,
  prepareGenerationOwnerReplacement,
  publishedSessionRuntime,
} from './runtime-generation-view.js'
import {
  type IsolatedSessionOverlay,
  isolateSessionOverlay,
  syncHotPolicyFromTarget,
} from './runtime-hot-policy.js'
import { RuntimeMutationGate } from './runtime-mutation-gate.js'
import { RuntimePluginCatalogue } from './runtime-plugin-catalogue.js'
import { sessionOverlayDesired } from './runtime-session-overlay.js'
import { buildCompleteRuntimeTarget } from './runtime-target-builder.js'
import { RuntimeTargetPublisher } from './runtime-target-publisher.js'
import {
  createHostRuntimeTargetResourceFactory,
  type HostRuntimeTargetResources,
} from './runtime-target-resource-bootstrap.js'
import { SandboxReadinessManager } from './sandbox-readiness-manager.js'
import {
  applyTelemetryConsent,
  createSessionHookPort,
  readProfileTelemetryConsent,
  readTelemetryConsent,
} from './session-hooks.js'
import {
  createSessionWorkspaceRuntime,
  type SessionWorkspaceRuntime,
  type WorkspaceRuntimeFence,
} from './session-workspace-runtime.js'
import { createTrajectoryLifecycle } from './trajectory-lifecycle.js'
import type { WorkspaceBinding } from './workspace-authority.js'
import { WorkspaceHookLoader } from './workspace-hook-loader.js'
import type { WorkspaceInvocationResolver } from './workspace-invocation-resolver.js'
import { compileWorkspacePolicy, normalizeSandboxStaticConfig } from './workspace-policy.js'
import { openWorkspaceSeamContexts, type WorkspaceSeamContexts } from './workspace-seam-contexts.js'

/**
 * A raw module import, distinct from `PackageLoader`: `createManagedExtHost` evaluates an
 * extension's own entry file and reads its `default` export itself, whereas `deps.loader`
 * (`PackageLoader.importPackage`) normally runs that entry through `readNamedExports`'
 * seams/operations/runtimes/presets validation. Static preflight defers required/isolated-only
 * nonbuiltin roots so their entry cannot run before isolation selection.
 *
 * The default, when `deps.extensionLoader` is not supplied, is plain native `import()` - the exact
 * same `nativeImport` the legacy tools-only ext host this step replaces already defaulted to (see
 * `ext-host/host.ts`). That default is load-bearing, not a placeholder: `@agnes/base`'s real
 * bundled extensions are plain `.ts`/`.js` files with no packaging step of their own, and every
 * existing test that loads them for real (`test/ext-host/base-tools.test.ts`,
 * `test/assemble/enabled-packages.test.ts`, the L1 replay corpus) already relies on a zero-config
 * loader that just works without jiti or a cache directory. A caller with source-form (unbuilt
 * TypeScript) extensions to load outside a transpiling test runner opts into a jiti-backed loader
 * via `deps.extensionLoader` instead - `createManagedExtHost` accepts either shape unchanged.
 */
const nativeExtensionImport = {
  import: async (file: string): Promise<Record<string, unknown>> =>
    (await import(pathToFileURL(file).href)) as Record<string, unknown>,
}

/** The steps assemble() can be told to crash after, in order. The testkit's crash matrix walks it. */
const STEP_ORDER = ['packages', 'adapters', 'presets', 'seams', 'provider', 'operations', 'kernel'] as const
export type AssemblyStep = (typeof STEP_ORDER)[number]
export const ASSEMBLY_STEPS: readonly AssemblyStep[] = STEP_ORDER

/** What `Assembled.extHost` and `Host.extensions()` actually are, named once for both call sites. */
export type ManagedExtHost = ReturnType<typeof createManagedExtHost>

export type HostComputerUseRuntimeStatus = Readonly<{
  platform: 'win32' | 'darwin' | 'linux'
  version: string
  publisher: string
  activeSessions: number
  startAttempted: boolean
}>

export type HostComputerUseStatusSource = Readonly<{
  status(): HostComputerUseRuntimeStatus | Readonly<{ availability: ComputerUseAvailability }>
  doctor(params?: ComputerUseDoctorParams): Promise<void>
  permissionsStatus(): Promise<Readonly<{ accessibility: boolean; screenRecording: boolean }> | null>
  permissionsGrant(): Promise<Readonly<{ accessibility: boolean; screenRecording: boolean }> | null>
  setSessionYolo(session: Readonly<{ key: string; lane: string }>, enabled: boolean): Promise<void>
  operationStart(kind: ComputerUseDriverOperationKind): ComputerUseDriverOperationSnapshot
  operationStatus(operationId?: string): ComputerUseDriverOperationSnapshot | undefined
  operationCancel(operationId: string): ComputerUseDriverOperationSnapshot | undefined
}>

export type OrdinaryReconciliationLifecycle = Readonly<{
  /** Refuses new target applications and settles only after every admitted one finishes. */
  close(): Promise<void>
}>

/** Where this host lives on disk. Every one is required: none of them has a safe default. */
export type { AssembleDeps, HostPaths } from './assembly-deps.js'
export type Assembled = {
  activationBarrier: ReturnType<typeof createExtensionActivationBarrier>
  approvalGrants: ApprovalGrantManagement
  callService: ReturnType<typeof serviceInvoker>['call']
  inspectService: ReturnType<typeof serviceInvoker>['inspect']
  prepareService: ReturnType<typeof serviceInvoker>['prepare']
  callPreparedService: ReturnType<typeof serviceInvoker>['callPrepared']
  inspectPreparedService: ReturnType<typeof serviceInvoker>['inspectPrepared']
  kernel: Kernel
  seams: SeamImplementations
  provider: Awaited<ReturnType<typeof buildProvider>>['provider']
  providerFingerprint: string | null
  applyModelProfile(next: ResolvedProfile): Promise<void>
  routes: RouteTable | undefined
  /** Reviewed bundled API-key routes fitted at assembly, eligible for runtime model switching. */
  preconfiguredRoutes: readonly string[]
  presets: Record<string, PresetDoc>
  runtimes: Partial<Record<'python' | 'typescript', RuntimeFactory>>
  adapters: AdapterBundle
  lockedPackageMutations: HostLockedPackageMutationRuntime
  /** Present only after platform-scoped driver install, signature verification and health checks pass. */
  computerUse: HostComputerUseStatusSource | undefined
  /** Native, reachability-checked screenshot collector; absent on unsupported platforms. */
  computerUseArtifactGc: ComputerUseArtifactGcRuntime | undefined
  /** Live C1 ordinary Cordis tree containing preset rows and the eight dynamic runtime seams. */
  pluginTree: HostPluginTreeBase
  extHost: ManagedExtHost
  /** The managed host's extensions and the plugin rows', in the order each was first seen. */
  extensionStatus(): ExtensionStatus[]
  rollback: Rollback
  defaultPreset: { view: PresetView; hash: string }
  /** Production per-binding constructor used when HostOptions does not supply a test override. */
  openWorkspaceRuntime(
    binding: WorkspaceBinding,
    preset?: PresetDoc,
    invocation?: import('@agnes/core').WorkspaceInvocationPort,
  ): Promise<SessionWorkspaceRuntime>
  /**
   * Task 3 (resource-live-reload): cleanly unload and reload one already-loaded bundled ecosystem
   * extension (`agnes/skills`) with a fresh resource snapshot, without
   * restarting the worker process. A thin `revoke()`+`load()` wrapper - it does not touch
   * PackageManager's own IH0-IH10 hot-update path.
   */
  reloadEcosystemExtension(
    id: string,
    freshInit: Readonly<{ skillResources?: SkillRuntimeInput }>,
  ): Promise<ExtensionStatus>
  /** Drive the ext: rows on the tree: the live rows, a row builder, and the second apply. */
  readonly extensionRows: Readonly<{
    current(): readonly Readonly<EntryRow>[]
    prepare(
      input: Readonly<{
        extensionId: string
        entryRevision?: string
        config?: unknown
        disabled?: boolean
        /** Supply the extension itself, for a row that exists only at runtime (stage 2b, D107′). */
        dynamic?: DynamicExtension
        skillResources?: SkillRuntimeInput | undefined
      }>,
    ): Readonly<EntryRow>
    apply(rows: readonly Readonly<EntryRow>[]): Promise<RuntimeConvergenceReport>
  }>
  /** Replace only the builtin Skills row against a newly bootstrapped resource view. */
  refreshSkillRow(fresh: SkillRuntimeInput | undefined): Promise<void>
  ordinaryReconciliation: OrdinaryReconciliationLifecycle
  ordinaryConvergence(): RuntimeConvergenceReport
  publicationDispatch: PublicationDispatch
  /** The sole Host publication of a complete RuntimeTarget. It shares this assembly's PublicationGate. */
  applyRuntimeTarget(target: RuntimeTarget): Promise<RuntimeConvergenceReport>
  bindRuntimeSession(sessionKey: string, preset: string): Promise<void>
  unbindRuntimeSession(sessionKey: string): Promise<void>
  sessionPresetLimits(): { limits?: Record<string, number>; park?: unknown }
}

// Refuses a second package contributing a name an earlier one already gave. Every other collision
// in this file is a refusal; these two were an Object.assign, and E_PACKAGE_DUPLICATE already exists.
const dup = (id: string, k: string, n: string): never => {
  throw new HostError('E_PACKAGE_DUPLICATE', `${id}: ${k} ${n} is a duplicate`, { detail: { k, source: n } })
}

/** Rebuild the pure preset catalogue from the exact package modules selected for this Host generation. */
function collectPresets(
  modules: ReadonlyMap<string, PackageModule>,
  profileConsent: ReturnType<typeof readProfileTelemetryConsent>,
): Record<string, PresetDoc> {
  const presets: Record<string, PresetDoc> = {}
  for (const module of modules.values())
    for (const [name, document] of Object.entries(module.presets ?? {}))
      presets[name] =
        name in presets ? dup(module.id, 'preset', name) : applyTelemetryConsent(document, profileConsent)
  return presets
}

/** Preserve the startup preset contract on every runtime snapshot reconciliation. */
function validatePresetCatalog(
  profile: ResolvedProfile,
  presets: Record<string, PresetDoc>,
): ReturnType<typeof resolvePreset> {
  for (const name of profile.presets.allowed)
    if (!presets[name]) {
      throw new HostError('E_PRESET_UNSUPPORTED', `no package provides preset ${name}`, {
        detail: { capability: 'preset', source: name },
      })
    }
  return resolvePreset(profile.presets.default, presets, { limits: profile.limits })
}

export async function assemble(profile: ResolvedProfile, deps: AssembleDeps): Promise<Assembled> {
  const workspaceInvocationFor: WorkspaceInvocationResolver =
    deps.workspaceInvocationFor ??
    (() => {
      throw Object.assign(new Error('E_WORKSPACE_REQUIRED: session has no workspace invocation'), {
        code: 'E_WORKSPACE_REQUIRED',
      })
    })
  deps.signal?.throwIfAborted()
  profile = withAssemblyIsolation(profile, deps.extensionIsolation)
  const { dataDir, workspaceRoot } = deps
  const rollback = new Rollback()
  const clock = deps.clock ?? (() => Date.now())
  const env = deps.env ?? process.env
  validateExtensionIsolation(profile.extensionIsolation)
  const ac = new AbortController()
  const activationBarrier = deps.activationBarrier ?? createExtensionActivationBarrier()
  deps.signal?.addEventListener('abort', () => ac.abort(), { once: true })
  // One call ends a step and names the next, so the sequence reads off the body and the crash point
  // is unambiguously "after this step's work, before the next step's".
  const done = (next: string): void => {
    if (deps.crashAt === step) throw new Error(`crash:${step}`)
    step = next
  }
  const say = (kind: string, detail: Record<string, unknown>): void => deps.audit.write({ kind, detail })
  const refuse = (code: HostErrorCode, msg: string, detail: Record<string, unknown>): never => {
    throw new HostError(code, msg, { detail })
  }
  const fail = async (s: string, e: unknown): Promise<never> => {
    const failed = await rollback.unwind()
    const msg = e instanceof Error ? e.message : String(e)
    const err = e instanceof HostError ? e : new HostError('E_SEAM_INIT', msg, { detail: { step: s } })
    say('startup.failed', { step: s, code: err.code, message: err.message, rollbackFailed: failed })
    throw err
  }
  let step: string = 'packages'
  try {
    mkdirSync(dataDir, { recursive: true })
    // 2 packages
    const enabled = profile.packages.filter((p) => p.enabled)
    const runtimeModuleCache = new Map<string, Promise<LoadedRuntimePackage | undefined>>()
    const loadRuntimeModule = (
      source: Readonly<RuntimePluginSnapshot>,
    ): Promise<LoadedRuntimePackage | undefined> => {
      const key = `${source.snapshot.packageId}\0${source.snapshot.snapshotId}`
      const existing = runtimeModuleCache.get(key)
      if (existing) return existing
      if (!deps.extensionLoader) return Promise.resolve(undefined)
      const loading = loadRuntimePackage(source, deps.extensionLoader).catch((error) => {
        runtimeModuleCache.delete(key)
        throw error
      })
      runtimeModuleCache.set(key, loading)
      return loading
    }
    const loadRuntimeSelection = async (
      sources: readonly Readonly<RuntimePluginSnapshot>[],
    ): Promise<Map<string, LoadedRuntimePackage>> => {
      const selected = new Map<string, LoadedRuntimePackage>()
      if (!sources.length) return selected
      if (!deps.extensionLoader) {
        throw new HostError('E_EXT_LOAD', 'runtime plugin snapshots need a module loader', {
          detail: { reason: 'runtime-plugin-loader' },
        })
      }
      const packageIds = new Set<string>()
      for (const source of sources) {
        if (packageIds.has(source.snapshot.packageId)) {
          throw new HostError('E_EXT_LOAD', 'multiple runtime snapshots selected for one package', {
            detail: { package: source.snapshot.packageId, reason: 'duplicate-runtime-snapshot' },
          })
        }
        packageIds.add(source.snapshot.packageId)
        const loaded = await loadRuntimeModule(source)
        if (loaded) selected.set(source.snapshot.packageId, loaded)
      }
      return selected
    }
    const activeRuntimeSources = Object.freeze([...(deps.runtimePluginSnapshots ?? [])])
    const runtimePackages = await loadRuntimeSelection(activeRuntimeSources)
    const runtimePackageIds = new Set(activeRuntimeSources.map(({ snapshot }) => snapshot.packageId))
    const managedExtensionPackages = new Set(deps.managedExtensionPackageIds ?? [])
    // Resolve every authorized location before importing any module. The supplied map can include
    // cached or disabled packages; neither their exports nor their bundled extensions may run.
    const dirs = new Map<string, string>()
    for (const { id, trust } of enabled) {
      if (trust !== 'builtin' && !runtimePackageIds.has(id))
        throw new HostError('E_EXT_LOAD', 'trusted package has no immutable runtime snapshot', {
          detail: { package: id, reason: 'snapshot-unavailable' },
        })
      const dir = deps.packageDirs === undefined ? dataDir : deps.packageDirs.get(id)
      if (!dir)
        throw new HostError('E_DEP_MISSING', `enabled package ${id} has no package directory`, {
          detail: { package: id },
        })
      dirs.set(id, dir)
    }
    const inventory = isolationInventory(profile, deps, dirs)
    const modules = new Map<string, PackageModule>()
    for (const [id, dir] of dirs)
      modules.set(
        id,
        runtimePackages.get(id)?.module ??
          (runtimePackageIds.has(id) || managedExtensionPackages.has(id)
            ? { id, extensionEntry: dir }
            : await deps.loader.importPackage(id, dir)),
      )
    for (const [name, pkg] of Object.entries(profile.seams))
      if (name !== 'platform' && !modules.has(pkg))
        refuse('E_DEP_MISSING', `seam ${name} names ${pkg}, not enabled`, { seam: name, package: pkg })
    done('adapters')

    // 3 adapters - the fs fence opens on the bootstrap policy (workspace allow plus the
    // host-integrity hard denies), which is what trusted seam factories run against. The sandbox
    // seam's full policy replaces it after step 5, in one binding, before anything else is built.
    const backend = deps.platform ? { platform: deps.platform } : {}
    // Filled once the Skill generation exists; the fence asks through it on every read.
    let skillReadRoots: () => readonly string[] = () => []
    const adapters = await openAdapters(profile, {
      dataDir,
      skillReadRoots: () => skillReadRoots(),
      modules,
      signal: ac.signal,
      workspaceRoot,
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.windowsNodeExecutable !== undefined
        ? { windowsNodeExecutable: deps.windowsNodeExecutable }
        : {}),
      ...backend,
    })
    rollback.push('adapters', () => adapters.close())
    if (hasChildControl(adapters.storage)) {
      const now = clock()
      await recoverCreatingChildAttempts(adapters.storage, { staleBefore: now, now })
    }
    const lockedPackageMutations = await createHostLockedPackageMutationRuntime(
      adapters.storage,
      deps.lockedPackageMutations,
    )
    rollback.push('computer-use-locked-package-mutations', () => lockedPackageMutations.close())
    const secrets = (ref: string): string => adapters.secrets.resolve(ref)
    const nativePlatform = createPlatform().os
    done('presets')

    // 4 presets - resolved before the seams, because SeamInitContext.profile.preset carries the
    // merged document and the provider needs the route table read off the view.
    // Last-writer-wins was the one collision in this assembly that was not a refusal, and "later"
    // was nothing better than profile.packages order: two packages providing a preset or a runtime
    // of the same name silently produced whichever the profile happened to list second.
    const profileConsent = readProfileTelemetryConsent(deps.profileDir)
    const presets = collectPresets(modules, profileConsent)
    const defaultPreset = validatePresetCatalog(profile, presets)
    done('seams')

    // 5 seams
    const seamProfile: SeamProfileView = {
      name: profile.name,
      resolvedProfileHash: profile.hash,
      dataDir,
      workspaceRoot,
      homeDir: deps.homeDir ?? homedir(),
      limits: profile.limits,
      preset: defaultPreset.doc,
    }
    const baseContext = (owner: string): SeamInitContext => ({
      secrets,
      adapters: toSeamAdapters(adapters, { owner, ...(deps.prompter ? { prompter: deps.prompter } : {}) }),
      profile: seamProfile,
      log: deps.log,
      signal: ac.signal,
      seamTimeoutMs: deps.seamTimeoutMs ?? 30_000,
    })
    // Keep ordinary artifact writes and Host startup unchanged until Computer Use is enabled. Once
    // screenshots have existed, retain the coordinated writer and collector while disabled so old
    // private artifacts can still expire without racing a same-digest write in the shared CAS.
    let computerUseArtifactMetadataPresent = false
    try {
      lstatSync(join(dataDir, 'artifacts', 'computer-use-meta'))
      computerUseArtifactMetadataPresent = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const computerUseArtifactRetentionRequired =
      profile.computerUse.enabled || computerUseArtifactMetadataPresent
    const contextFor = (owner: string, seamName: SeamName): { context: SeamInitContext; cleanup(): void } => {
      const context = {
        ...baseContext(owner),
        ...(computerUseArtifactRetentionRequired &&
        owner === '@agnes/base' &&
        seamName === 'artifacts' &&
        adapters.platform.os === nativePlatform &&
        (adapters.platform.os === 'win32' ||
          adapters.platform.os === 'darwin' ||
          adapters.platform.os === 'linux') &&
        privateArtifactDeleteAvailable()
          ? { privateArtifactStore: createPrivateArtifactStore(dataDir, adapters.platform.os) }
          : {}),
      }
      // Only the sandbox factory is handed the path-policy canonicalizer and a probe exec, and the
      // probe dies with the factory. Every other seam gets the plain context - and the
      // policy-bound exec inside it.
      if (seamName !== 'sandbox') return { context, cleanup: () => undefined }
      const { services, revoke } = sandboxHostServices(adapters)
      return { context: { ...context, sandboxHost: services }, cleanup: revoke }
    }
    const staticSeams = await initStaticSeams(profile, modules, contextFor, {
      timeoutMs: deps.seamTimeoutMs ?? 30_000,
      platform: adapters.platform,
      rollback,
    })
    const sandboxPackage = modules.get(profile.seams.sandbox)
    const workspaceProbe = sandboxPackage?.sandboxWorkspaceProbe
    const rawProbe = adapters.createProbeExec()
    rollback.push('workspace-sandbox-probe', () => rawProbe.revoke())
    const workspacePlans = new Map<string, Awaited<ReturnType<typeof compileWorkspacePolicy>>>()
    const readinessManager = new SandboxReadinessManager(async (key) => {
      const plan = workspacePlans.get(JSON.stringify([key.canonicalRoot, key.staticConfigHash]))
      if (!plan)
        throw new HostError('E_SANDBOX_WORKSPACE', 'workspace readiness has no compiled policy', {
          detail: { reason: 'workspace-policy-missing' },
        })
      if (adapters.transport)
        return Object.freeze({
          name: 'remote' as const,
          execBackend: 'remote' as const,
          enforcement: Object.freeze({ level: 'none' as const, scope: Object.freeze([]) }),
          confine: async () => {
            throw new HostError('E_SANDBOX_WORKSPACE', 'remote workspaces cannot confine a local process', {
              detail: { reason: 'remote-local-confine' },
            })
          },
        })
      if (!workspaceProbe)
        throw new HostError('E_SANDBOX_WORKSPACE', 'sandbox workspace probe is unavailable', {
          detail: { reason: 'workspace-probe-missing' },
        })
      const raw = await workspaceProbe({
        level: plan.staticConfig.level,
        required: plan.staticConfig.required,
        onUnavailable: plan.staticConfig.onUnavailable,
        shell: adapters.platform.shell(),
        options: plan.backendOptions,
        probeExec: rawProbe.run,
        log: deps.log,
        signal: key.signal,
      })
      if (!raw.execBackend || !raw.enforcement)
        throw new HostError('E_SANDBOX_WORKSPACE', 'sandbox probe omitted its posture', {
          detail: { reason: 'workspace-posture-missing' },
        })
      return raw
    })
    rollback.push('workspace-sandbox-readiness', () => readinessManager.revoke())
    const hotPolicy = createHotPolicyFacade()
    const openWorkspaceRuntime = async (
      binding: WorkspaceBinding,
      preset: PresetDoc = defaultPreset.doc,
      invocation?: import('@agnes/core').WorkspaceInvocationPort,
    ): Promise<SessionWorkspaceRuntime> => {
      const sandboxConfig = normalizeSandboxStaticConfig(preset)
      let fence: SessionWorkspaceFence | undefined
      let posture: Readonly<{ execBackend: SandboxExecBackend; enforcement: Enforcement }> | undefined
      return createSessionWorkspaceRuntime({
        binding,
        ...(invocation ? { invocation } : {}),
        openWorkspace: adapters.openWorkspace,
        openFence: async (workspace) => {
          fence = await adapters.openFence(workspace)
          return fence
        },
        compilePolicy: async (openedFence: WorkspaceRuntimeFence) => {
          const sessionFence = openedFence as SessionWorkspaceFence
          const plan = await compileWorkspacePolicy({
            canonicalRoot: sessionFence.root,
            dataDir,
            homeDir: deps.homeDir ?? homedir(),
            semantics: sessionFence.semantics,
            staticConfig: sandboxConfig,
            canonicalize: (path, options) => sessionFence.fs.canonicalize(path, options),
          })
          const rootIdentity = plan.semantics.caseSensitive
            ? plan.policy.workspaceRoot
            : plan.policy.workspaceRoot.toLocaleLowerCase('en-US')
          workspacePlans.set(JSON.stringify([rootIdentity, plan.staticConfigHash]), plan)
          return plan
        },
        bindReadiness: ({ workspace, plan }) =>
          readinessManager.bind(
            {
              backendId: profile.seams.sandbox,
              canonicalRoot: workspace.root,
              staticConfigHash: plan.staticConfigHash,
              caseSensitive: plan.semantics.caseSensitive,
            },
            (raw) => {
              const execBackend = raw.execBackend
              const enforcement = raw.enforcement
              if (!execBackend || !enforcement)
                throw new HostError('E_SANDBOX_WORKSPACE', 'cached sandbox posture is unavailable', {
                  detail: { reason: 'workspace-posture-missing' },
                })
              posture = Object.freeze({
                execBackend,
                enforcement: {
                  level: enforcement.level,
                  scope: [...enforcement.scope],
                },
              })
              if (raw.name)
                adapters.reportSandboxBackend({
                  name: raw.name,
                  enforcement: posture.enforcement,
                })
              fence?.activateGate({
                backend: raw.execBackend,
                onUnavailable: raw.execBackend === 'remote' ? 'deny' : plan.staticConfig.onUnavailable,
              })
            },
          ),
        fitSandbox: async (runtime) => {
          if (!fence || !posture)
            throw new HostError('E_SANDBOX_WORKSPACE', 'sandbox posture was not activated', {
              detail: { reason: 'workspace-posture-inactive' },
            })
          const powerShell = adapters.powerShell
          const shellCommand = powerShell
            ? (command: string): string[] => powerShellCommand(powerShell, command)
            : undefined
          return staticSeams.sandbox.forWorkspace({
            root: runtime.root,
            ...(runtime.invocation ? { invocation: runtime.invocation } : {}),
            policy: runtime.policy,
            readiness: runtime.sandbox,
            shell: adapters.platform.shell(),
            ...(shellCommand ? { shellCommand } : {}),
            execBackend: posture.execBackend,
            enforcement: posture.enforcement,
            exec: fence.exec,
            binding: fence.binding,
          })
        },
        openHooks: async (runtime) => {
          const loader = new WorkspaceHookLoader(
            runtime.fs,
            () => commandHookInvocationSnapshot(hotPolicy).revision,
          )
          return Object.freeze({ snapshot: () => loader.snapshot() })
        },
        openServices: (runtime) => openWorkspaceSeamContexts(seams, runtime),
        closeServices: (services) => (services as WorkspaceSeamContexts).close(),
      })
    }
    const quietState = new HostQuietState()
    const publicationGate = new PublicationGate()
    const runtimeMutationGate = new RuntimeMutationGate()
    const publicationDispatch = new PublicationDispatch(publicationGate, hotPolicy)
    let kernel!: Kernel
    let preloadSkills = deps.skillResources
    let activeSkillResources = deps.skillResources
    // Shared workers discover workspace Skills lazily inside a session invocation. Their global
    // list() can stay empty while the workspace catalogue changes, so an unchanged row must still
    // read the newly bootstrapped source on the next turn.
    const liveSkillInput: SkillRuntimeInput = Object.freeze({
      list: () => activeSkillResources?.list() ?? [],
      read: (resourceId, session) =>
        activeSkillResources?.read(resourceId, session) ?? { ok: false, code: 'NOT_FOUND' },
      readFile: (resourceId, revision, path, session) =>
        activeSkillResources?.readFile(resourceId, revision, path, session) ?? {
          ok: false,
          code: 'NOT_FOUND',
        },
      readRoots: () => activeSkillResources?.readRoots?.() ?? [],
      scopeWorkspace: (root, sessionKey, invoke) =>
        activeSkillResources?.scopeWorkspace?.(root, sessionKey, invoke) ?? invoke(),
    })
    const skillReadContext = {
      homeDir: deps.homeDir ?? homedir(),
      agnesHome: dirname(dataDir),
      dataDir,
    }
    skillReadRoots = () => safeSkillReadRoots(preloadSkills?.readRoots?.() ?? [], skillReadContext)
    const runtimePromptPreloader = deps.skillResources
      ? createSkillPromptPreloader(() => preloadSkills, workspaceInvocationFor, publicationDispatch)
      : undefined
    const generationViews = new Map<string, GenerationRegistries>()
    const sessionRuntimeView = (
      sessionKey: string,
      runtimeRegistryRevision?: string,
    ): CurrentSessionRuntime => {
      const session = kernel.get(sessionKey)
      const revision =
        runtimeRegistryRevision ??
        runtimeTargetPublisher.current().value.current?.runtimeRegistryRevision ??
        'unspecified'
      return publishedSessionRuntime({
        runtimeRegistryRevision: revision,
        cache: generationViews,
        hooks: session?.hooks ?? noopHooks,
        ...(kernel ? { seed: { tools: kernel.tools, resources: kernel.resources } } : {}),
        ...(runtimePromptPreloader ? { runtimePromptPreloader } : {}),
      })
    }
    const builtSeams = buildSeamRows({
      profile,
      modules,
      preset: defaultPreset.doc,
      contextFor: (owner, name) => contextFor(owner, name).context,
    })
    const builtPresets = buildPresetRows(presets)
    const ordinaryModules = new Map(modules)
    for (const [id, loaded] of runtimePackages) ordinaryModules.set(id, loaded.module)
    const builtOrdinary = buildOrdinaryRows(profile, ordinaryModules, deps.ordinaryPluginLayers)
    // `activeBuiltinClaims` is a `let` because ext: rows can only be built much further down, after
    // the managed ext host and the bundled-extension finder exist. `staticClaims` below is already a
    // thunk, so reassigning here is picked up by the publisher.
    let activeBuiltinClaims: readonly Readonly<HostBuiltinRowClaim>[] = Object.freeze([
      ...builtPresets.builtinClaims,
      ...builtOrdinary.builtinClaims,
      ...builtSeams.builtinClaims,
    ])
    const staticBootRows = Object.freeze(
      [...builtPresets.rows, ...builtOrdinary.rows, ...builtSeams.rows].filter(
        (row) =>
          row.plugin.startsWith('builtin:') || row.id.startsWith('seam:') || row.id.startsWith('preset:'),
      ),
    )
    // The Host owns its builtin ext: rows the way it owns seam and preset rows: a daemon target is
    // built from installed packages only and never names them, so they are merged back like
    // staticBootRows. A target that does carry one of these ids wins over this default.
    let hostExtensionRows: readonly Readonly<EntryRow>[] = Object.freeze([])
    let replacePublishedSeamRoot: ((root: import('@agnes/cordis').Context) => void) | undefined
    const bootCatalogue = deps.runtimePluginCatalogue ?? activeRuntimeSources
    const pluginCatalogue = new RuntimePluginCatalogue(bootCatalogue)
    const extensionInfo = {
      agnesVersion: deps.agnesVersion ?? '0.0.0',
      apiVersion: API_VERSION,
      profileName: profile.name,
    }
    const extensionOrder = createExtensionOrder()
    // Which supplier holds an `ext:` row id: shared by builtin rows and plugin rows that replace them.
    const extensionOwners = new ExtensionOwners()
    // Registrations made by third-party plugin rows through ctx.extension(). It exists before the
    // first tree so that tree can hand rows the service; it stays dormant until the kernel is up.
    const requestSkillInstall = deps.skillInstall
    const rowExtensions = createRowExtensionHost({
      ...(deps.mcpManage ? { mcpManage: deps.mcpManage } : {}),
      ...(deps.pluginManage ? { pluginManage: deps.pluginManage } : {}),
      ...(requestSkillInstall
        ? {
            skillInstall: async (invocation, signal) => {
              const session = kernel.get(invocation.sessionKey)
              if (!session) throw new Error('Skill installation session unavailable')
              const digest = deps.workspacePolicyDigestFor?.(invocation.sessionKey)
              const plan = [...workspacePlans.values()].find((plan) => plan.policy.digest === digest)
              if (!plan) throw new Error('Skill installation workspace policy unavailable')
              return requestSkillInstall(
                {
                  ...invocation,
                  pathPolicy: { policy: plan.policy, caseSensitive: plan.semantics.caseSensitive },
                  deniedPaths: plan.policy.rules
                    .filter((rule) => rule.effect === 'deny')
                    .map((rule) => rule.path),
                },
                signal,
              )
            },
          }
        : {}),
      info: extensionInfo,
      log: deps.log,
      audit: say,
      order: extensionOrder,
      owners: extensionOwners,
      describePackage: (packageId, snapshotId) => pluginCatalogue.describe(packageId, snapshotId),
    })
    const rowServices = createRowServiceHost((packageId, snapshotId) =>
      pluginCatalogue.describe(packageId, snapshotId),
    )
    // Like a loader importing by name at update time: each target sees what is installed now.
    const refreshPluginCatalogue = async () => {
      if (!deps.runtimePluginSources) return
      const sources = new Map(
        bootCatalogue.map((source) => [
          `${source.snapshot.packageId}\0${source.snapshot.snapshotId}`,
          source,
        ]),
      )
      // The refreshed record wins: it carries the current trust decision for that snapshot.
      for (const source of await deps.runtimePluginSources()) {
        sources.set(`${source.snapshot.packageId}\0${source.snapshot.snapshotId}`, source)
      }
      pluginCatalogue.replace([...sources.values()])
    }
    const runtimeTargetPublisher = new RuntimeTargetPublisher<
      HostRuntimeTargetResources,
      IsolatedSessionOverlay
    >({
      catalogue: pluginCatalogue,
      publication: publicationGate,
      mutation: runtimeMutationGate,
      ...(deps.ordinaryStartTimeoutMs === undefined ? {} : { startTimeoutMs: deps.ordinaryStartTimeoutMs }),
      resourceFactory: createHostRuntimeTargetResourceFactory({
        ...(deps.skillResources ? { skills: deps.skillResources } : {}),
      }),
      load: async (source) => {
        if (!deps.extensionLoader) return undefined
        const loaded = await loadRuntimeModule(source)
        return loaded?.module
      },
      trust: (source) => {
        const resolved = profile.packages.find((pkg) => pkg.id === source.snapshot.packageId)
        if (resolved?.trust === 'builtin' || resolved?.trust === 'trusted') return resolved.trust
        // A package the user trusted after this Host booted is not in the boot profile.
        return source.trusted ? 'trusted' : undefined
      },
      staticClaims: () => activeBuiltinClaims,
      privateInput: () => {
        // Asked once claims have resolved, right before the candidate tree starts mounting rows.
        candidateMounting = true
        return {
          bootRows: Object.freeze([...staticBootRows, ...hostExtensionRows]),
          exactExtras: builtSeams.exactExtras,
          thirdPartyExtras: builtSeams.thirdPartyExtras,
          requiredRowIds: REQUIRED_SEAM_ROW_IDS,
          rootServices: (root, origins) => {
            rowExtensions.installRoot(root, origins)
            rowServices.installRoot(root, origins)
          },
          ...(deps.skillContribution ? { skillContribution: deps.skillContribution } : {}),
          afterApply: () => {
            if (kernel) kernel.invalidateSeams()
          },
        }
      },
      verifyCandidate: (candidate, tree) => rowExtensions.assertReplacements(candidate.tree.rows, tree),
      rebuildSessionScope: async (sessionKey, desired, candidate) => {
        const overlay = isolateSessionOverlay(
          candidate.ordinary.pluginTree.root,
          sessionKey,
          sessionOverlayDesired(desired).preset,
        )
        return Object.freeze({
          desired: { preset: overlay.preset },
          overlay,
          runtime: sessionRuntimeView(sessionKey, candidate.runtimeRegistryRevision),
          close: () => undefined,
        })
      },
      onPublished: (target) => {
        const root = runtimeTargetPublisher.current().value.current?.ordinary.pluginTree.root
        if (root) replacePublishedSeamRoot?.(root)
        syncHotPolicyFromTarget(hotPolicy, target)
      },
    })
    rollback.push('runtime-target-publisher', () => runtimeTargetPublisher.close())
    const publishedOrdinary = (): HostPluginTreeBase => {
      const current = runtimeTargetPublisher.current().value.current
      if (!current) {
        throw new HostError('E_EXT_LOAD', 'runtime target publisher produced no ordinary tree', {
          detail: { reason: 'runtime-target-unpublished' },
        })
      }
      return current.ordinary.pluginTree
    }
    // Host admission for the one ordinary convergence path. `closeHost` seals this synchronously and
    // then joins the queue, so a target already admitted finishes loading and applying before the
    // rollback disposes the tree it is mounting into, and a target handed in after that is refused.
    // A rejected candidate leaves the previous tree published, but the candidate's rows have already
    // taken over the extension ids they share with it (the kernel tables are shared), so the previous
    // tree's tools and hooks are gone. Mounting the published target again puts them back; nothing
    // else would, because applying an unchanged target is a no-op.
    let candidateMounting = false
    const rebuildLiveTree = async () => {
      const live = runtimeTargetPublisher.current().value.current?.target
      if (!live) return
      try {
        await runtimeTargetPublisher.apply(live, { rebuild: true })
      } catch (error) {
        deps.log.error('could not restore the published runtime target after a rejected one', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    let applyQueue: Promise<unknown> = Promise.resolve()
    let applyClosed = false
    let applyDrain: Promise<void> | undefined
    // `resolveTarget` runs when this apply's turn in the queue comes, not when it is enqueued: a
    // target derived from the live one (the ext: rows' own composition) must see every apply queued
    // ahead of it, or it would be built on the tree before them and, published after them, drop them.
    const enqueueRuntimeTarget = (
      resolveTarget: () => Parameters<typeof runtimeTargetPublisher.apply>[0],
    ): Promise<RuntimeConvergenceReport> => {
      if (applyClosed)
        throw new HostError('E_HOST_CLOSED', 'ordinary runtime target application is closed', {
          detail: { reason: 'ordinary-reconciliation-closed' },
        })
      const applied = applyQueue.then(async () => {
        const target = resolveTarget()
        await refreshPluginCatalogue()
        let published: Awaited<ReturnType<typeof runtimeTargetPublisher.apply>>
        candidateMounting = false
        try {
          published = await runtimeTargetPublisher.apply(target)
        } catch (error) {
          // A transaction compensates on the live tree itself, and a tree holding a row that never
          // finished mounting must not be retired: waiting on that fiber would hold the mutation
          // gate for ever. Only a failed whole-tree candidate, which had already taken the shared
          // ids over, needs the published target mounted again — UNLESS the transaction's own
          // compensation failed (the live tree may be left half-recovered: a row unmounted but
          // still tracked, so it silently vanishes from the plugin table on the next delivery).
          // A tainted tree already gets the backgrounded-retirement safety net either way.
          const live = runtimeTargetPublisher.current().value.current?.ordinary.pluginTree
          const compensationFailed =
            runtimeTargetPublisher.lastAttempt === 'transaction' &&
            error instanceof Error &&
            error.message.includes('recovery failed')
          // Compensation failing leaves the tree tainted, but a tainted tree must still be repaired
          // here — the backgrounded-retirement path only runs on the next retire/close, and does not
          // by itself put the vanished row back. Only the ordinary (non-transaction) candidate-failure
          // branch below stays gated on `!tainted`, since a plain tainted tree is otherwise healthy and
          // does not need rebuilding.
          if (compensationFailed)
            deps.log.error('a transaction failed to compensate; rebuilding the whole tree to repair it', {
              message: error instanceof Error ? error.message : String(error),
            })
          if (
            candidateMounting &&
            (compensationFailed ||
              (!live?.tainted?.() && runtimeTargetPublisher.lastAttempt !== 'transaction'))
          ) {
            await rebuildLiveTree()
          }
          throw error
        }
        const report = published.value.current?.report
        if (!report) {
          throw new HostError('E_EXT_LOAD', 'runtime target publisher produced no report', {
            detail: { reason: 'runtime-target-unpublished' },
          })
        }
        return report
      })
      applyQueue = applied.catch(() => undefined)
      return applied
    }
    const applyRuntimeTarget = (target: RuntimeTarget): Promise<RuntimeConvergenceReport> =>
      enqueueRuntimeTarget(() => target)
    const ordinaryReconciliation: OrdinaryReconciliationLifecycle = Object.freeze({
      close: () => {
        applyClosed = true
        applyDrain ??= applyQueue.then(() => undefined)
        return applyDrain
      },
    })
    const bootTreeRows = Object.freeze([...builtPresets.rows, ...builtOrdinary.rows, ...builtSeams.rows])
    const initialRuntimeTarget = buildCompleteRuntimeTarget({
      rows: bootTreeRows,
      resources: { mcp: [], skills: {} },
    }).target
    await applyRuntimeTarget(initialRuntimeTarget)
    const pluginTree: HostPluginTreeBase = {
      get root() {
        return publishedOrdinary().root
      },
      get tree() {
        return publishedOrdinary().tree
      },
      get leases() {
        return publishedOrdinary().leases
      },
      get bootRows() {
        return publishedOrdinary().bootRows
      },
      currentRows: () => publishedOrdinary().currentRows(),
      applyRows: () => {
        throw new HostError('E_EXT_LOAD', 'ordinary rows apply only through applyRuntimeTarget', {
          detail: { reason: 'ordinary-apply-via-runtime-target' },
        })
      },
    }
    const bindRuntimeSession = async (sessionKey: string, preset: string): Promise<void> => {
      const published = runtimeTargetPublisher.current().value.current
      if (!published) return
      const overlay = isolateSessionOverlay(published.ordinary.pluginTree.root, sessionKey, preset)
      await runtimeTargetPublisher.setSessionScope(sessionKey, { preset: overlay.preset }, async () =>
        Object.freeze({
          desired: { preset: overlay.preset },
          overlay,
          runtime: sessionRuntimeView(sessionKey, published.runtimeRegistryRevision),
          close: () => undefined,
        }),
      )
    }
    const unbindRuntimeSession = async (sessionKey: string): Promise<void> => {
      await runtimeTargetPublisher.closeSessionScope(sessionKey)
    }
    const mutablePackageSeams = createMutableSeamImplementations<SeamImplementations>(
      pluginTree.root,
      {
        sandbox: staticSeams.sandbox,
        platform: staticSeams.platform,
      },
      publicationDispatch,
    )
    const packageSeams = mutablePackageSeams.seams
    replacePublishedSeamRoot = mutablePackageSeams.replaceRoot
    const approvalGrantControl = createApprovalGrantControlPlane(
      lazyPackageTables(adapters.storage, '@agnes/host/approval-grants'),
      (grantId) => {
        bindApprovalTicket(hotPolicy, grantId)
      },
    )
    const seams: SeamImplementations = {
      ...packageSeams,
      approval: approvalGrantControl.bind(packageSeams.approval),
    }
    let computerUseArtifactGc: ComputerUseArtifactGcRuntime | undefined
    const startComputerUseArtifactGc = () => {
      if (
        !computerUseArtifactGc &&
        (adapters.platform.os === 'win32' ||
          adapters.platform.os === 'darwin' ||
          adapters.platform.os === 'linux') &&
        adapters.platform.os === nativePlatform &&
        privateArtifactDeleteAvailable()
      ) {
        computerUseArtifactGc = createComputerUseArtifactGcRuntime({
          dataDir,
          retention: profile.computerUse.retention,
          clock,
          onError: (error) =>
            deps.log.error('Computer Use artifact GC failed closed', {
              message: error instanceof Error ? error.message : String(error),
            }),
          onPressure: (pressure) => deps.log.warn('Computer Use artifact storage is above its cap', pressure),
        })
      }
    }
    // Old screenshots still need collection even if the feature was disabled. A fresh profile
    // should not open retention databases or start a collector before ever using the driver.
    if (computerUseArtifactMetadataPresent) startComputerUseArtifactGc()
    rollback.push('computer-use-artifact-gc', () => computerUseArtifactGc?.close())
    const initializeComputerUse = async (initializationSignal: AbortSignal) => {
      let activeComputerUseBackendProvider: ComputerUseBackendProvider | undefined
      let computerUseBackendProvider: ComputerUseBackendProvider
      let computerUseStatus: HostComputerUseStatusSource
      if (
        adapters.platform.os !== 'win32' &&
        adapters.platform.os !== 'darwin' &&
        adapters.platform.os !== 'linux'
      )
        throw new HostError('E_SEAM_INIT', 'Computer Use production driver is not admitted on this platform')
      if (profile.computerUse.appAccess === 'allowlist' && profile.computerUse.appAllowlist.length === 0)
        throw new HostError('E_SEAM_INIT', 'Computer Use requires at least one stable application identity')
      const runtimeArchitecture = adapters.platform.snapshot().arch
      if (
        runtimeArchitecture !== 'x64' &&
        runtimeArchitecture !== 'x86_64' &&
        runtimeArchitecture !== 'arm64'
      )
        throw new HostError(
          'E_SEAM_INIT',
          'Computer Use production driver is not admitted on this architecture',
        )
      const admission = evaluateFixedComputerUsePlatformAdmission(adapters.platform.os, runtimeArchitecture)
      if (!admission.allowed)
        throw new HostError('E_SEAM_INIT', 'Computer Use production driver admission is blocked', {
          detail: { blockers: admission.blockers },
        })
      const inspectedDriverLock = inspectComputerUseDriverLock(fixedComputerUseDriverLock)
      if (!inspectedDriverLock.ok) throw new HostError('E_SEAM_INIT', 'Computer Use driver lock is invalid')
      const driverRoot = join(dataDir, 'computer-use', 'driver')
      const artifactSink = {
        put: (bytes: Uint8Array, meta: { mime: 'image/png' | 'image/jpeg'; name: string }) =>
          seams.artifacts.put(bytes, { mime: meta.mime, name: meta.name }),
      }
      const runtimePlatform = adapters.platform.os
      let runtimeVersion: string
      let runtimePublisher: string
      let preparationOutcome: 'installed' | 'already-current' | 'lkg-restored'
      let probeHealth: (params: ComputerUseDoctorParams) => Promise<void>
      let readPermissions: HostComputerUseStatusSource['permissionsStatus'] = async () => null
      let grantPermissions: HostComputerUseStatusSource['permissionsGrant'] = async () => null
      let createCurrentProvider: () => ComputerUseBackendProvider
      let installCandidate: (signal: AbortSignal) => Promise<
        Readonly<{
          provider: ComputerUseBackendProvider
          commit(): void
          outcome: 'installed' | 'already-current' | 'repaired' | 'lkg-restored'
        }>
      >
      if (adapters.platform.os === 'win32') {
        const installed = await installOrUpdateLockedWindowsComputerUseDriver({
          root: driverRoot,
          lock: inspectedDriverLock.lock,
          signal: initializationSignal,
        })
        preparationOutcome = installed.usedLastKnownGood
          ? 'lkg-restored'
          : installed.installed
            ? 'installed'
            : 'already-current'
        let currentDriver = installed.verified
        const buildProvider = (driver: typeof installed.verified) =>
          createWindowsComputerUseBackendProvider({
            driver,
            profile: profile.computerUse,
            profileHash: profile.hash,
            artifacts: artifactSink,
          })
        const configure = (driver: typeof installed.verified) => {
          currentDriver = driver
          runtimeVersion = driver.version
          runtimePublisher = driver.publisher
          probeHealth = async (params) => {
            await doctorLockedWindowsComputerUseDriver({
              directory: dirname(driver.executablePath),
              lock: inspectedDriverLock.lock,
              signal: initializationSignal,
              selectors: params,
            })
          }
        }
        configure(currentDriver)
        activeComputerUseBackendProvider = buildProvider(currentDriver)
        createCurrentProvider = () => buildProvider(currentDriver)
        installCandidate = async (signal) => {
          const priorPath = currentDriver.executablePath
          const result = await installOrUpdateLockedWindowsComputerUseDriver({
            root: driverRoot,
            lock: inspectedDriverLock.lock,
            signal,
          })
          const driver = result.verified
          return Object.freeze({
            provider: buildProvider(driver),
            commit: () => configure(driver),
            outcome: result.usedLastKnownGood
              ? ('lkg-restored' as const)
              : result.installed
                ? driver.executablePath === priorPath
                  ? ('repaired' as const)
                  : ('installed' as const)
                : ('already-current' as const),
          })
        }
      } else if (adapters.platform.os === 'darwin') {
        const installed = await installOrUpdateLockedMacOSComputerUseDriver({
          root: driverRoot,
          lock: inspectedDriverLock.lock,
          signal: initializationSignal,
        })
        preparationOutcome = installed.usedLastKnownGood
          ? 'lkg-restored'
          : installed.installed
            ? 'installed'
            : 'already-current'
        let currentDriver = installed.verified
        const buildProvider = (driver: typeof installed.verified) =>
          createMacOSComputerUseBackendProvider({
            driver,
            profile: profile.computerUse,
            profileHash: profile.hash,
            artifacts: artifactSink,
          })
        const configure = (driver: typeof installed.verified) => {
          currentDriver = driver
          runtimeVersion = driver.version
          runtimePublisher = driver.authority
          probeHealth = async (params) => {
            await doctorLockedMacOSComputerUseDriver({
              directory: dirname(driver.executablePath),
              lock: inspectedDriverLock.lock,
              signal: initializationSignal,
              selectors: params,
            })
          }
          let pendingPermissionProbe:
            | Promise<Readonly<{ accessibility: boolean; screenRecording: boolean }>>
            | undefined
          readPermissions = () => {
            pendingPermissionProbe ??= probeMacOSComputerUsePermissions({
              driver,
              signal: initializationSignal,
            }).finally(() => {
              pendingPermissionProbe = undefined
            })
            return pendingPermissionProbe
          }
          let pendingPermissionGrant:
            | Promise<Readonly<{ accessibility: boolean; screenRecording: boolean }>>
            | undefined
          grantPermissions = () => {
            pendingPermissionGrant ??= grantMacOSComputerUsePermissions({
              driver,
              signal: initializationSignal,
            })
              .then(() => readPermissions())
              .then((status) => {
                if (!status) throw new Error('Computer Use macOS permission status is unavailable')
                return status
              })
              .finally(() => {
                pendingPermissionGrant = undefined
              })
            return pendingPermissionGrant
          }
        }
        configure(currentDriver)
        activeComputerUseBackendProvider = buildProvider(currentDriver)
        createCurrentProvider = () => buildProvider(currentDriver)
        installCandidate = async (signal) => {
          const priorPath = currentDriver.executablePath
          const result = await installOrUpdateLockedMacOSComputerUseDriver({
            root: driverRoot,
            lock: inspectedDriverLock.lock,
            signal,
          })
          const driver = result.verified
          return Object.freeze({
            provider: buildProvider(driver),
            commit: () => configure(driver),
            outcome: result.usedLastKnownGood
              ? ('lkg-restored' as const)
              : result.installed
                ? driver.executablePath === priorPath
                  ? ('repaired' as const)
                  : ('installed' as const)
                : ('already-current' as const),
          })
        }
      } else {
        const installed = await installOrUpdateLockedLinuxComputerUseDriver({
          root: driverRoot,
          lock: inspectedDriverLock.lock,
          signal: initializationSignal,
        })
        preparationOutcome = installed.usedLastKnownGood
          ? 'lkg-restored'
          : installed.installed
            ? 'installed'
            : 'already-current'
        let currentDriver = installed.verified
        const buildProvider = (driver: typeof installed.verified) =>
          createLinuxComputerUseBackendProvider({
            driver,
            profile: profile.computerUse,
            profileHash: profile.hash,
            artifacts: artifactSink,
          })
        const configure = (driver: typeof installed.verified) => {
          currentDriver = driver
          runtimeVersion = driver.version
          runtimePublisher = `${driver.provenanceIssuer}#${driver.provenanceSubject}`
          probeHealth = async (params) => {
            await doctorLockedLinuxComputerUseDriver({
              directory: dirname(driver.executablePath),
              lock: inspectedDriverLock.lock,
              signal: initializationSignal,
              selectors: params,
            })
          }
        }
        configure(currentDriver)
        activeComputerUseBackendProvider = buildProvider(currentDriver)
        createCurrentProvider = () => buildProvider(currentDriver)
        installCandidate = async (signal) => {
          const priorPath = currentDriver.executablePath
          const result = await installOrUpdateLockedLinuxComputerUseDriver({
            root: driverRoot,
            lock: inspectedDriverLock.lock,
            signal,
          })
          const driver = result.verified
          return Object.freeze({
            provider: buildProvider(driver),
            commit: () => configure(driver),
            outcome: result.usedLastKnownGood
              ? ('lkg-restored' as const)
              : result.installed
                ? driver.executablePath === priorPath
                  ? ('repaired' as const)
                  : ('installed' as const)
                : ('already-current' as const),
          })
        }
      }
      const requireProvider = (): ComputerUseBackendProvider => {
        if (!activeComputerUseBackendProvider) throw new Error('Computer Use backend is restarting')
        return activeComputerUseBackendProvider
      }
      computerUseBackendProvider = Object.freeze({
        acquire: (session, signal) => requireProvider().acquire(session, signal),
        release: (session) => requireProvider().release(session),
        setPermissionMode: (session, mode) => requireProvider().setPermissionMode(session, mode),
        status: () => requireProvider().status(),
        async dispose() {
          const provider = activeComputerUseBackendProvider
          activeComputerUseBackendProvider = undefined
          await provider?.dispose()
        },
      })
      const replaceProvider = async (candidate: ComputerUseBackendProvider) => {
        const previous = requireProvider()
        if (previous.status().activeSessions !== 0) {
          await candidate.dispose()
          throw new Error('Computer Use driver operation requires all sessions to be closed')
        }
        activeComputerUseBackendProvider = undefined
        try {
          await previous.dispose()
        } catch (error) {
          await candidate.dispose().catch(() => undefined)
          // A provider close can fail after partially tearing down its runtime. Recreate the same
          // already-verified driver so one failed maintenance attempt cannot strand this Host with
          // no usable provider. If recovery itself fails, remaining unavailable is fail-closed.
          try {
            activeComputerUseBackendProvider = createCurrentProvider()
          } catch {
            activeComputerUseBackendProvider = undefined
          }
          throw error
        }
        activeComputerUseBackendProvider = candidate
      }
      const operations = createComputerUseDriverOperationRuntime({
        async install(_kind, input) {
          input.phase('installing')
          const candidate = await installCandidate(input.signal)
          try {
            input.signal.throwIfAborted()
            input.phase('restarting')
            await replaceProvider(candidate.provider)
            candidate.commit()
            return candidate.outcome
          } catch (error) {
            if (activeComputerUseBackendProvider !== candidate.provider)
              await candidate.provider.dispose().catch(() => undefined)
            throw error
          }
        },
        async restart(input) {
          input.signal.throwIfAborted()
          input.phase('restarting')
          await replaceProvider(createCurrentProvider())
          return 'restarted'
        },
      })
      const pendingDoctors = new Map<string, Promise<void>>()
      const doctor = (params: ComputerUseDoctorParams = {}) => {
        const key = JSON.stringify(params)
        const pending = pendingDoctors.get(key)
        if (pending) return pending
        const running = probeHealth(params).finally(() => {
          pendingDoctors.delete(key)
        })
        pendingDoctors.set(key, running)
        return running
      }
      computerUseStatus = Object.freeze({
        status: () => {
          const runtime = activeComputerUseBackendProvider?.status() ?? {
            activeSessions: 0,
            startAttempted: true,
          }
          return Object.freeze({
            platform: runtimePlatform,
            version: runtimeVersion,
            publisher: runtimePublisher,
            ...runtime,
          })
        },
        doctor,
        permissionsStatus: () => readPermissions(),
        permissionsGrant: () => grantPermissions(),
        setSessionYolo: (session: Readonly<{ key: string; lane: string }>, enabled: boolean) =>
          computerUseBackendProvider?.setPermissionMode(session, enabled ? 'unrestricted' : 'standard') ??
          Promise.reject(new Error('Computer Use backend is unavailable')),
        operationStart: (kind) => {
          if (activeComputerUseBackendProvider?.status().activeSessions !== 0)
            throw new Error('Computer Use driver operation requires all sessions to be closed')
          return operations.start(kind)
        },
        operationStatus: (operationId) => operations.status(operationId),
        operationCancel: (operationId) => operations.cancel(operationId),
      })
      startComputerUseArtifactGc()
      return {
        backend: computerUseBackendProvider,
        controls: computerUseStatus,
        preparationOutcome,
        async dispose() {
          await operations.close()
          await computerUseBackendProvider?.dispose()
        },
      }
    }
    const computerUseArchitecture = adapters.platform.snapshot().arch
    const computerUseAdmission =
      computerUseArchitecture === 'x64' ||
      computerUseArchitecture === 'x86_64' ||
      computerUseArchitecture === 'arm64'
        ? evaluateFixedComputerUsePlatformAdmission(adapters.platform.os, computerUseArchitecture)
        : { allowed: false }
    const lazyComputerUse = createLazyComputerUseRuntime({
      ...(!profile.computerUse.enabled
        ? { unavailable: 'feature-disabled' as const }
        : !computerUseAdmission.allowed
          ? { unavailable: 'platform-unsupported' as const }
          : {}),
      initialize: initializeComputerUse,
    })
    const computerUseBackendProvider = profile.computerUse.enabled ? lazyComputerUse.backend : undefined
    const computerUseStatus = lazyComputerUse.controls
    rollback.push('computer-use', () => lazyComputerUse.dispose())
    say('seams.assembled', { seams: profile.seams, fsDigest: adapters.fs.fence().digest })
    let privacyTrajectory: SeamInitContext['privacyTrajectory']
    const hookCommands =
      adapters.platform.os === 'win32'
        ? trustedHookCommands(profile.commandHooks, workspaceRoot, adapters.platform.fs())
        : undefined
    // Factored out so a reload (Task 3, resource-live-reload) can build the same shape of context
    // against a caller-supplied fresh resource snapshot instead of the boot-time `deps` one, without
    // duplicating the owner/extensionId gating below. `resources` defaults to `deps` itself, so
    // ordinary boot-time callers (`ecosystemContext` below) are unaffected byte for byte.
    // What agnes/mcp-search's tool_search lists (design §3.9, D123): always the Skills generation
    // agnes/skills currently serves (`preloadSkills`, which reloadEcosystemExtension swaps), so a
    // resource reload never has to reload the search extension. Empty while agnes/skills reloads.
    const liveSkillDiscovery: SkillRuntimeDiscovery = Object.freeze({
      list: () => preloadSkills?.list() ?? [],
      runInWorkspace: <T>(sessionKey: string, invoke: () => Promise<T>): Promise<T> => {
        const current = preloadSkills
        if (!current) return invoke()
        return bindSkillRuntimeToWorkspace(
          current,
          workspaceInvocationFor,
          publicationDispatch,
        ).runInWorkspace(sessionKey, invoke)
      },
    })
    const buildEcosystemContext = (
      owner: string,
      extensionId: string,
      resources: Readonly<{ skillResources?: SkillRuntimeInput }> = deps,
    ): SeamInitContext => {
      const skills = resources.skillResources
        ? bindSkillRuntimeToWorkspace(resources.skillResources, workspaceInvocationFor, publicationDispatch)
        : undefined
      return {
        ...baseContext(owner),
        sandbox: seams.sandbox,
        ...(owner === '@agnes/base' && extensionId === 'agnes/hooks-runner' && hookCommands
          ? { trustedHookCommands: hookCommands }
          : {}),
        ...(owner === '@agnes/base' && extensionId === 'agnes/skills' && skills
          ? { skillResources: skills }
          : {}),
        ...(owner === '@agnes/base' && extensionId === 'agnes/mcp-search'
          ? { skillDiscovery: liveSkillDiscovery }
          : {}),
        ...(owner === '@agnes/base' && extensionId === 'agnes/privacy' && privacyTrajectory
          ? { privacyTrajectory }
          : {}),
        ...(extensionRowGrantFor(owner, extensionId)?.computerUse && computerUseBackendProvider
          ? {
              // Extension unload calls provider.dispose(). The lazy runtime's dispose closes the
              // host-lifetime driver, so a row reload would make later sessions fail closed.
              computerUseBackendProvider: {
                acquire: (...args: Parameters<typeof computerUseBackendProvider.acquire>) =>
                  computerUseBackendProvider.acquire(...args),
                release: (...args: Parameters<typeof computerUseBackendProvider.release>) =>
                  computerUseBackendProvider.release(...args),
                setPermissionMode: (
                  ...args: Parameters<typeof computerUseBackendProvider.setPermissionMode>
                ) => computerUseBackendProvider.setPermissionMode(...args),
                status: () => computerUseBackendProvider.status(),
                dispose: async () => undefined,
              },
              computerUseOptions: {
                captureAfterMode: 'som' as const,
                autoCaptureAfterActions: true,
                maxImageDimension: profile.computerUse.capture.maxImageDimension,
                maxBytesPerImage: profile.computerUse.capture.maxBytesPerImage,
                maxCapturesPerHour: profile.computerUse.capture.maxCapturesPerHour,
                maxRecentPerSession: profile.computerUse.retention.maxRecentPerSession,
              },
            }
          : {}),
      }
    }
    const ecosystemContext = (owner: string, extensionId: string): SeamInitContext =>
      buildEcosystemContext(owner, extensionId)
    done('provider')

    // 6 provider - route table first, environment second, credentials third.
    let routes: RouteTable | undefined
    try {
      routes = materializeRoutes(defaultPreset.view, profile)
    } catch (error) {
      if (
        !(error instanceof HostError) ||
        error.detail?.reason !== 'no-routes' ||
        !(deps.allowUnresolvedProvider || process.env.AGNES_WORKER_KIND === 'session')
      )
        throw error
    }
    const swept = sweepAwsDestination(env, profile)
    say('provider.env_swept', { removed: swept.removed, set: Object.keys(swept.set) })
    const factory = deps.providerFactory ? { providerFactory: deps.providerFactory } : {}
    let { provider, contractStore, preconfiguredRoutes } = routes
      ? await buildProvider(profile, routes, {
          secrets,
          clock,
          log: deps.log,
          creditsSnapshot: () => businessLimit(hotPolicy, 'cost.credits_per_usd'),
          ...factory,
        })
      : unresolvedProviderAssembly()
    const contractForModel = bindModelContracts(
      provider.registry?.models() ?? (profile.provider.routes ?? []).flatMap((route) => route.models ?? []),
      contractStore,
    )
    // createProvider sealed the registry on its way out, so both of these are readable now and
    // neither would have been before: the fingerprint identifies a reading that can no longer move,
    // and a catalogue refresh after this point cannot change what it names.
    let providerFingerprint: string | null = null
    if (provider.registry && routes) {
      verifyRoutes(routes, provider.registry)
      providerFingerprint = provider.registry.fingerprint()
    }
    const models = modelRuntime({ provider, contractForModel })
    const applyModelProfile = async (next: ResolvedProfile): Promise<void> => {
      const nextRoutes = next.provider.routes?.length
        ? materializeRoutes(defaultPreset.view, next)
        : undefined
      const nextSecrets =
        next.adapters.secrets.kind === 'file'
          ? composeSecrets(
              createSecretsFile({ dir: next.adapters.secrets.path ?? join(next.dataDir, 'secrets') }),
              createSecretsEnv(),
            )
          : next.adapters.secrets.kind === 'env'
            ? createSecretsEnv()
            : undefined
      if (!nextSecrets) throw new HostError('E_SEAM_INIT', 'unsupported model credential store')
      const built = nextRoutes
        ? await buildProvider(next, nextRoutes, {
            secrets: (ref) => nextSecrets.resolve(ref),
            clock,
            log: deps.log,
            creditsSnapshot: () => businessLimit(hotPolicy, 'cost.credits_per_usd'),
            ...factory,
          })
        : unresolvedProviderAssembly()
      if (built.provider.registry && nextRoutes) verifyRoutes(nextRoutes, built.provider.registry)
      const nextContracts = bindModelContracts(
        built.provider.registry?.models() ?? built.provider.models(),
        built.contractStore,
      )
      // No await after candidate validation: all readers move to the same verified catalogue.
      models.publish({ provider: built.provider, contractForModel: nextContracts })
      provider = built.provider
      preconfiguredRoutes = built.preconfiguredRoutes
      routes = nextRoutes
      providerFingerprint = built.provider.registry?.fingerprint() ?? null
      profile = next
    }
    const named = routes ? Object.entries(routes).map(([k, v]) => [k, `${v.route}/${v.model}`]) : []
    // The credit rate goes on the audit row, null included. An assembly that priced nothing is the
    // one whose ledger reads in dollars, and that has to be legible afterwards from the record the
    // deployment keeps, not only from a warning on a log nobody kept.
    const creditsPerUsd = readCreditsPerUsd(profile, businessLimit(hotPolicy, 'cost.credits_per_usd')) ?? null
    say('provider.assembled', {
      routes: Object.fromEntries(named),
      fingerprint: providerFingerprint,
      creditsPerUsd,
      creditUnit: creditsPerUsd === null ? 'usd' : 'credit',
    })
    // The view the sessions run on carries the resolved route and model, not the sentinel: see
    // pinPresetRoutes for what core would otherwise record in request/header.
    const view = routes ? pinPresetRoutes(defaultPreset.view, routes) : defaultPreset.view
    done('operations')

    // 7 operations + runtimes - the factory tables are called here, with the dependencies an
    // Operation cannot construct for itself (ERRATA B4).
    const hostAdapters = toSeamAdapters(adapters, { owner: '@agnes/host' })
    const opDeps: OperationDeps = {
      log: deps.log,
      signal: ac.signal,
      adapters: hostAdapters,
      secrets,
      ext: {},
      profile: seamProfile,
    }
    const operations: Operation[] = []
    const runtimes: Assembled['runtimes'] = {}
    for (const m of modules.values()) {
      for (const [name, make] of Object.entries(m.operations ?? {})) {
        const op = make(opDeps)
        if (!op || typeof op.run !== 'function')
          refuse('E_EXT_LOAD', `${m.id}: operations.${name} returned no Operation`, {
            id: m.id,
            operation: name,
          })
        operations.push(op)
      }
      for (const [n, f] of Object.entries(m.runtimes ?? {}))
        runtimes[n as keyof Assembled['runtimes']] = n in runtimes ? dup(m.id, 'runtime', n) : f
    }
    done('kernel')

    // 8 kernel - the repository's single Kernel.create call site
    let extensionLeaseFor: ((source: string) => LeaseView | undefined) | undefined
    const extensionSessions = new ExtensionSessions<HookPort>()
    const compaction = assembleCompaction(modules.get('@agnes/base')?.buildCompactionPlan)
    kernel = Kernel.create({
      storage: adapters.storage,
      seams,
      provider: models.provider,
      withModelSnapshot: (operation) => models.run(operation),
      operations,
      currentRuntime: deps.currentRuntime ?? {
        current: (sessionKey) =>
          runtimeTargetPublisher.current().value.sessionScopes.get(sessionKey)?.runtime,
      },
      sessionOverlay: {
        apply: (sessionKey, overlay) => bindRuntimeSession(sessionKey, overlay.preset),
      },
      contract: { contract_id: null, parser_version: '1' },
      contractForModel: models.contractForModel,
      preset: view,
      fsOps: adapters.fs,
      netFetch: deps.netFetch ?? createNetFetch(),
      publicFetch: deps.publicFetch ?? createPublicFetch(deps.env),
      approvalMode: profile.approvals.mode,
      ...(computerUseBackendProvider ? { hostToolDispatch: createComputerUseHostDispatchPort() } : {}),
      ...(profile.reconcile.point === 'immediate' ? {} : { quiet: quietState }),
      logger: deps.log,
      clock,
      agnesVersion: deps.agnesVersion ?? '0.0.0',
      hookLeaseFor: (source) => extensionLeaseFor?.(source),
      retainSessionRefIdentity: (sessionRef) => extensionSessions.owns(sessionRef),
      ...(deps.requestMedia !== undefined ? { requestMedia: deps.requestMedia } : {}),
      ...(deps.requestMedia !== undefined
        ? { imageInputTokenFallback: createProductionImageInputTokenFallback() }
        : {}),
      ...(runtimePromptPreloader ? { runtimePromptPreloader } : {}),
      workspacePublication: publicationDispatch,
      // A spawned child's run is its own turn: activation waits for it, and one started while an
      // activation holds the gate queues behind it.
      detachedChildRun: async (run) => (await activationBarrier.enqueue('turn').start()).run(run),
      hooksFactory: extensionSessions.factory(
        (session) =>
          Object.freeze({
            key: session.key,
            lane: session.lane,
            workspaceRoot: session.d.cwd,
            telemetryConsent: readTelemetryConsent(
              resolvePreset(session.preset.name, presets, { limits: profile.limits }).doc,
            ),
            telemetryConsentPendingAudit: profileConsent !== undefined,
          }),
        (session, sessionRef, engine) =>
          createSessionHookPort(
            session,
            engine,
            () => kernel.resources.snapshot(),
            sessionRef.telemetryConsent,
            sessionRef,
            publicationDispatch,
          ),
      ),
      ...(compaction ? { compaction } : {}),
      ...(profile.limits['lease.ttl_ms'] !== undefined ? { leaseTtlMs: profile.limits['lease.ttl_ms'] } : {}),
      // `children` is omitted on purpose: core's default factory refuses with a message saying
      // subagents are assembled later, which is more informative than a host-side stub.
    })
    rollback.push('kernel', () => kernel.close())
    privacyTrajectory = createTrajectoryLifecycle(
      {
        ...deps,
        env,
        resolve: (ref) => extensionSessions.resolve(ref),
      },
      workspaceInvocationFor,
      publicationDispatch,
    )
    done('extensions')

    // 9 extensions - what the enabled packages bundle. One that fails to load is one extension the
    // host comes up without, so this step cannot fail the assembly and is not on the crash matrix.
    // bindExtensionInvocations is the real adapter: it turns the
    // kernel's own hooks/slots/resources registries plus its registrations() aggregator into the
    // full KernelPorts an extension callback runs against. During session_start core intentionally
    // has not published the half-initialized session in kernel.sessions yet, so only this private
    // resolver can see it. ExtensionSessions removes its opening marker after session_start and
    // revokes the exact object capability during failure cleanup/shutdown; ordinary Kernel callers
    // retain the public-after-initialization rule.
    const services = new ServiceRegistry()
    const extPorts = bindExtensionInvocations(
      {
        services,
        tools: kernel.tools,
        hooks: kernel.hooks,
        slots: kernel.slots,
        resources: kernel.resources,
        projections: kernel.projections,
        registrations: (source) => kernel.registrations(source),
      },
      (ref) => kernel.get(ref.key),
      (session) =>
        extensionSessions.ref(session) ??
        Object.freeze({ key: session.key, lane: session.lane, workspaceRoot: session.d.cwd }),
      extensionSessions.resolve,
      kernel.projections,
      activationBarrier,
      publicationDispatch,
    )
    rowServices.activate(extPorts)
    // One snapshot for factory contexts and the isolated bootstrap; hooks get theirs from the kernel.
    const extensionPlatform = platformFacts(seams.platform)
    // The handlers are captured before the first await, so a caller may release the source's
    // registrations right after this returns and the shutdown still reaches every open session.
    const dispatchExtensionShutdown = async (source: string, context: { reason: 'revoke' | 'reload' }) => {
      const snapshot = kernel.hooks.snapshot(source)
      for (const session of [...kernel.sessions.values()]) {
        const sessionRef = extensionSessions.ref(session)
        if (!sessionRef) continue
        await kernel.hooks
          .dispatch(
            'shutdown',
            () => ({ reason: context.reason }),
            {
              session: sessionRef,
              signal: new AbortController().signal,
              replayed: false,
              log: deps.log,
            },
            { snapshot },
          )
          .catch(() => undefined)
      }
    }
    const managed = createManagedExtHost({
      order: extensionOrder,
      ports: extPorts,
      // JUDGMENT CALL: an extension-level revoke/reload is not scoped to one particular session the
      // way Kernel.close()'s own 'shutdown' dispatch is (that one fires once per open session, at
      // teardown, unfiltered by source - a different lifecycle use of the same hook name). This one
      // is scoped to just `source`'s own registrations via kernel.hooks.snapshot(source), but every
      // extension-registered hook handler still runs wrapped by bindExtensionInvocations, which
      // resolves ctx.session through ExtensionSessions' exact-reference WeakMap. A fabricated or
      // stale session identity therefore fails before an extension callback can run. The extension's
      // own shutdown hook would never actually run. So this dispatches once per session that is
      // genuinely open right now (mirroring Kernel.close()'s own per-session loop) instead of
      // inventing one; with zero sessions open there is nothing to notify, which is honest rather
      // than synthetic. `revoke`/`reload` are not yet reachable from Host (a later task), so this
      // path is presently unexercised by any production caller - it exists to satisfy the required
      // Options.shutdown contract now, correctly, rather than deferring the decision.
      shutdown: dispatchExtensionShutdown,
      loader: deps.extensionLoader ?? nativeExtensionImport,
      ceiling: profile.policy.capabilityCeiling,
      seamPackages: new Set([profile.seams.sandbox, profile.seams.platform]),
      // Resource extensions keep their existing independent reload path. Only the two static seam
      // owners above are immutable now; the eight ordinary Cordis seams can update in place.
      // mutable() (ext-host/managed-host.ts:214-221) refuses by PACKAGE, and the shipped local-dev
      // template puts @agnes/base in `seams.sandbox` (templates/local-dev.yaml:11), so without this
      // every @agnes/base extension is unrevokable and an ext: row can never unmount. Opening it per
      // ID keeps the protection for every sibling that is not on this list. The list is derived from
      // the constant, not from the rows actually built, so it also names ids that ended up on the
      // assembly-time fallback or were gated off and have no row - harmless: it only lifts an
      // immutability veto, it does not itself revoke or load anything.
      reloadableExtensions: new Set(['agnes/skills', ...EXT_ROW_EXTENSION_IDS]),
      // API_VERSION, not a literal: the loaded plan sample hardcoded '0.1.0', which is stale - the
      // real extension-api version is '1.0.0', and a mismatch here would fail every real manifest's
      // apiRange check at preflight (E_API_RANGE) before any real deployment ever got the chance.
      info: extensionInfo,
      platform: extensionPlatform,
      log: deps.log,
      audit: say,
    })
    // Builtin extensions that an `ext:` row supplies (MIGRATED_EXTENSION_IDS) are loaded here rather
    // than by `managed`, so a plugin row replacing one and the builtin coming back hand over cleanly.
    const builtinRows = createBuiltinRowHost({
      owners: extensionOwners,
      order: extensionOrder,
      ports: extPorts,
      platform: extensionPlatform,
      shutdown: dispatchExtensionShutdown,
      loader: deps.extensionLoader ?? nativeExtensionImport,
      ceiling: profile.policy.capabilityCeiling,
      info: extensionInfo,
      log: deps.log,
      audit: say,
    })
    extensionLeaseFor = (source) =>
      managed.leaseFor(source) ?? rowExtensions.leaseFor(source) ?? builtinRows.leaseFor(source)
    // Factored out (Task 3, resource-live-reload) so a reload can build its own selector against a
    // `contextFor` bound to fresh resources instead of boot-time `deps`, reusing every other option
    // unchanged rather than restating this literal a second time.
    const makeFactorySelector = (contextFor: (owner: string, extensionId: string) => SeamInitContext) =>
      createExtensionFactorySelector({
        ...(profile.extensionIsolation ? { options: profile.extensionIsolation } : {}),
        ...(deps.extensionIsolationServices ? { services: deps.extensionIsolationServices } : {}),
        runtimeDirectory: join(deps.hostRoot, 'dist', 'agnes-runtime'),
        target: `${adapters.platform.os}-${adapters.platform.snapshot().arch}`,
        modules,
        inventory,
        contextFor,
        managed: {
          setIsolation: (id, isolation) => {
            managed.setIsolation(id, isolation)
            builtinRows.setIsolation(id, isolation)
          },
          // `builtinRows.fail` runs first and is not blocked by `managed.fail`: for a migrated id the
          // latter is a no-op that still queues behind whatever is ahead of it in managed-host's own
          // serial tail (an unrelated resource reload's un-deadlined shutdown dispatch, say), and
          // that must not delay releasing a dead isolated child's hook registrations. `allSettled`
          // also means a rejection from either side cannot swallow the other's report or escape as
          // an unhandled rejection.
          fail: async (id, error, token) => {
            await Promise.allSettled([builtinRows.fail(id, error, token), managed.fail(id, error)])
          },
        },
        audit: say,
      })
    const selectExtensionFactory = makeFactorySelector(ecosystemContext)
    // Builtin manifests remain descriptive input for verified Cordis rows. Packaged builds supply
    // the same manifests through embeddedExtensions when no package files exist beside the binary.
    const findBundledExtension = (
      id: string,
    ):
      | {
          spec: ExtensionSpec
          packageId: string
          packageDirectory: string
          extensionDirectory: string
          embedded?: ExtensionManifest
        }
      | undefined => {
      for (const pkg of profile.packages) {
        if (!pkg.enabled || pkg.trust !== 'builtin') continue
        const packageDirectory = dirs.get(pkg.id)
        if (!packageDirectory) continue
        // Source installations keep descriptive manifests beside builtin packages.
        let extensionDirs: string[]
        try {
          extensionDirs = readBundledExtensionDirs(packageDirectory, pkg.trust === 'builtin')
        } catch {
          extensionDirs = []
        }
        for (const extensionDirectory of extensionDirs) {
          let manifest: ReturnType<typeof readAuthorManifest>
          try {
            manifest = readAuthorManifest(extensionDirectory)
          } catch {
            continue
          }
          if (manifest.id !== id) continue
          return {
            spec: {
              id: manifest.id,
              package: pkg.id,
              packageVersion: pkg.version,
              dir: extensionDirectory,
              trust: pkg.trust,
              enabled: true,
              integrity: pkg.integrity,
              revision: pkg.integrity,
            },
            packageId: pkg.id,
            packageDirectory,
            extensionDirectory,
          }
        }
        // Packaged builds embed the reviewed builtin manifest.
        const embedded = modules.get(pkg.id)?.embeddedExtensions?.find((m) => m.id === id)
        if (embedded && pkg.trust === 'builtin')
          return {
            spec: {
              id: embedded.id,
              package: pkg.id,
              packageVersion: pkg.version,
              dir: packageDirectory,
              trust: 'builtin',
              enabled: true,
              integrity: pkg.integrity,
              revision: pkg.integrity,
            },
            packageId: pkg.id,
            packageDirectory,
            extensionDirectory: packageDirectory,
            embedded,
          }
      }
      return undefined
    }
    // Third-party plugin rows may have registered before the kernel existed; they get their
    // registrations now. A tool name a builtin extension declares belongs to that extension's row.
    // `'unreadable'` is a builtin whose manifest cannot be read: nothing is known about what it declares.
    const authorManifestOf = (extensionId: string) => {
      const found = findBundledExtension(extensionId)
      if (!found) return undefined
      if (found.embedded) return found.embedded
      try {
        return readAuthorManifest(found.extensionDirectory)
      } catch {
        return 'unreadable' as const
      }
    }
    const reservedToolName = (name: string) => name.toLowerCase().replace(/^_+|_+$/g, '')
    const reservedTools = new Map<string, string>()
    for (const extensionId of [...EXT_ROW_EXTENSION_IDS, 'agnes/skills']) {
      const manifest = authorManifestOf(extensionId)
      // An unreadable manifest declares nothing to reserve: that extension fails to load on its own.
      if (manifest === 'unreadable') continue
      for (const name of manifest?.capabilities.tools?.names ?? [])
        reservedTools.set(reservedToolName(name), `ext:${extensionId}`)
    }
    rowExtensions.activate({
      ports: extPorts,
      platform: extensionPlatform,
      shutdown: (source, context) => dispatchExtensionShutdown(source, context),
      reservedTool: (name, rowId) => {
        const owner = reservedTools.get(reservedToolName(name))
        return owner !== undefined && owner !== rowId
      },
      governance: new Map(
        ['agnes/privacy', 'agnes/hooks-runner'].map((extensionId) => {
          const manifest = authorManifestOf(extensionId)
          return [
            `ext:${extensionId}`,
            manifest === 'unreadable' ? manifest : (manifest?.capabilities.hooks ?? []),
          ] as const
        }),
      ),
    })
    // ==== ext: rows ====
    // This is the earliest point where an ext: row can exist: `managed`, `selectExtensionFactory`
    // and `findBundledExtension` (just above) are all consts declared after the boot tree's own
    // applyRuntimeTarget, and the row's loader needs all three.
    const extRowOwners = new Map<string, symbol>()
    // Extensions that exist only at runtime (one per resource), keyed by extension id. Registered by
    // `prepare`, dropped again once an apply no longer carries their row.
    const dynamicExtensionIds = new Set<string>()
    // Copies one owner's current Kernel registrations into the published generation sessions are
    // bound to, which otherwise keeps the copy it took when it was created.
    const mirrorGenerationOwner = (id: string) => {
      const current = runtimeTargetPublisher.current().value.current
      if (!current) return
      const seed = { tools: kernel.tools, resources: kernel.resources }
      const generation = generationRegistries(generationViews, current.runtimeRegistryRevision, seed)
      const replacement = prepareGenerationOwnerReplacement(generation, id, seed)
      replacement.commit()
      replacement.finalize()
    }
    const extRowLoader: ExtRowLoader = Object.freeze({
      load: async (extensionId: string) => ({
        id: extensionId,
        loaded: false,
        error: { code: 'E_EXT_LOAD', message: 'legacy extension loader is retired' },
      }),
      revoke: (extensionId: string, reason: string) => managed.revoke(extensionId, reason),
    })
    // The extension is constructed inside the row's apply, so a factory that throws is a listing
    // and an empty row, not an assembly failure.
    const loadMigratedExtension = (
      extensionId: string,
      skillResources?: SkillRuntimeInput,
    ): Promise<BuiltinRowHandle> => {
      const found = findBundledExtension(extensionId)
      if (!found)
        return Promise.resolve({
          loaded: false,
          error: { code: 'E_EXT_LOAD', message: 'extension not found' },
          release: async () => {},
        })
      return builtinRows.load({
        rowId: `ext:${extensionId}`,
        spec: found.spec,
        ...(found.embedded ? { embedded: found.embedded } : {}),
        factory: (token) =>
          (extensionId === 'agnes/skills'
            ? makeFactorySelector((owner, id) =>
                buildEcosystemContext(owner, id, skillResources ? { skillResources: liveSkillInput } : {}),
              )
            : selectExtensionFactory)(
            found.packageId,
            found.spec.id,
            found.packageDirectory,
            found.embedded ? found.packageDirectory : found.extensionDirectory,
            token,
          ),
      })
    }
    const loadDynamicExtension = (
      extensionId: string,
      dynamic: DynamicExtension,
    ): Promise<BuiltinRowHandle> => {
      return builtinRows.load({
        rowId: `ext:${extensionId}`,
        spec: dynamic.spec,
        embedded: dynamic.manifest,
        factory: () => dynamic.factory(ecosystemContext(dynamic.spec.package, extensionId)),
        registration: 'lifetime',
        onLateRegistration: () => mirrorGenerationOwner(extensionId),
      })
    }
    const prepareExtensionRow = (
      input: Readonly<{
        extensionId: string
        entryRevision?: string
        config?: unknown
        disabled?: boolean
        dynamic?: DynamicExtension
        skillResources?: SkillRuntimeInput | undefined
      }>,
    ) => {
      if (input.dynamic) dynamicExtensionIds.add(input.extensionId)
      const found = input.dynamic ? undefined : findBundledExtension(input.extensionId)
      const onDisposeError = (error: unknown) =>
        say('extension.revoke_failed', {
          id: input.extensionId,
          row: `ext:${input.extensionId}`,
          ...(typeof (error as { code?: unknown }).code === 'string'
            ? { code: (error as { code: string }).code }
            : {}),
          message: error instanceof Error ? error.message : String(error),
        })
      const built = buildExtensionRow({
        extensionId: input.extensionId,
        packageId: input.dynamic?.spec.package ?? found?.packageId ?? '@agnes/base',
        entryRevision:
          input.entryRevision ??
          input.dynamic?.spec.revision ??
          found?.spec.revision ??
          EXT_ROW_MOUNT_REVISION,
        loader: extRowLoader,
        owners: extRowOwners,
        onDisposeError,
        ...(input.dynamic
          ? {
              facade: {
                load: () => loadDynamicExtension(input.extensionId, input.dynamic as DynamicExtension),
              },
            }
          : MIGRATED_EXTENSION_IDS.has(input.extensionId)
            ? {
                facade: {
                  load: () =>
                    loadMigratedExtension(
                      input.extensionId,
                      Object.hasOwn(input, 'skillResources') ? input.skillResources : deps.skillResources,
                    ),
                },
              }
            : {}),
        ...(input.config === undefined ? {} : { config: input.config }),
        ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
      })
      // Without a Host-private claim the publisher refuses the row outright:
      // E_RUNTIME_TARGET_STATIC_CLAIM (runtime-target-static-authority.ts), and Host never boots.
      activeBuiltinClaims = Object.freeze([
        ...activeBuiltinClaims.filter((claim) => claim.row.id !== built.row.id),
        built.claim,
      ])
      return built.row
    }
    // Composed inside the apply queue (see enqueueRuntimeTarget): a daemon target still in flight
    // when this is called is part of the live tree by the time these rows are merged onto it.
    const applyExtensionRows = (rows: readonly Readonly<EntryRow>[]) =>
      enqueueRuntimeTarget(
        () =>
          buildCompleteRuntimeTarget(
            composeExtensionRowTarget({
              live: runtimeTargetPublisher.current().value.current?.target,
              fallbackRows: bootTreeRows,
              rows,
              extraOwnedRowIds: new Set([...dynamicExtensionIds].map((id) => `ext:${id}`)),
            }),
          ).target,
      )
    // Only extensions this installation can actually admit get a row. A row whose apply throws
    // during assembly does not become RowState 'failed': assemble.ts's own step wrapper rewrites it
    // into E_SEAM_INIT and unwinds the rollback, i.e. Host does not exist. Admission is therefore
    // decided BEFORE the row is built, with the same preflight managed.load runs (identity,
    // manifest, api range, capability ceiling). A profile that narrows `policy.capabilityCeiling`
    // below what a builtin declares used to mean "that one extension fails to load, Host boots";
    // rowifying it must not turn that into "Host does not exist".
    const admitsExtensionRow = (found: NonNullable<ReturnType<typeof findBundledExtension>>) => {
      try {
        const ceiling = profile.policy.capabilityCeiling
        if (found.embedded)
          preflightEmbeddedExtension({
            id: found.spec.id,
            manifest: found.embedded,
            ceiling,
            apiVersion: extensionInfo.apiVersion,
          })
        else preflightExtension({ ...found.spec, ceiling, apiVersion: extensionInfo.apiVersion })
        return true
      } catch {
        return false
      }
    }
    const extRowIds: string[] = []
    for (const extensionId of EXT_ROW_EXTENSION_IDS) {
      // The Computer Use gate is a supply condition, not a grant condition: when it is off there is
      // nothing to load, so no row is built.
      if (extensionId === 'agnes/computer-use' && !profile.computerUse.enabled) continue
      const found = findBundledExtension(extensionId)
      if (!found) continue
      if (admitsExtensionRow(found)) extRowIds.push(extensionId)
      else
        say('extension.failed', {
          id: extensionId,
          code: 'E_EXT_LOAD',
          message: 'builtin row admission failed',
        })
    }
    hostExtensionRows = Object.freeze([
      ...extRowIds.map((extensionId) =>
        prepareExtensionRow({
          extensionId,
          ...(extensionId === 'agnes/skills'
            ? { entryRevision: skillRowRevision(deps.skillResources), skillResources: deps.skillResources }
            : {}),
        }),
      ),
    ])
    if (hostExtensionRows.length) await applyExtensionRows(hostExtensionRows)
    const extensionRows = Object.freeze({
      current: () => hostExtensionRows,
      prepare: prepareExtensionRow,
      apply: async (rows: readonly Readonly<EntryRow>[]) => {
        // Set before applying: the merge must not put back a row this call is removing.
        const previous = hostExtensionRows
        hostExtensionRows = Object.freeze([...rows])
        try {
          const report = await applyExtensionRows(rows)
          // A dynamic extension whose row is gone is forgotten, so a later apply cannot bring it back.
          const wanted = new Set(rows.map((row) => row.id))
          for (const id of [...dynamicExtensionIds]) {
            if (wanted.has(`ext:${id}`)) continue
            dynamicExtensionIds.delete(id)
            activeBuiltinClaims = Object.freeze(
              activeBuiltinClaims.filter((claim) => claim.row.id !== `ext:${id}`),
            )
          }
          return report
        } catch (error) {
          hostExtensionRows = previous
          const retained = new Set(previous.map((row) => row.id))
          for (const id of dynamicExtensionIds) if (!retained.has(`ext:${id}`)) dynamicExtensionIds.delete(id)
          throw error
        }
      },
    })
    let skillRefreshTail: Promise<void> = Promise.resolve()
    let skillRetry = 0
    const refreshSkillRow = (fresh: SkillRuntimeInput | undefined): Promise<void> => {
      const task = skillRefreshTail.then(async () => {
        const previous = extensionRows.current().find((row) => row.id === SKILL_ROW_ID)
        if (!previous) throw new HostError('E_EXT_LOAD', 'builtin Skills row is unavailable')
        const revision = skillRowRevision(fresh)
        const currentStatus = builtinRows
          .statusEntries()
          .find(({ status }) => status.id === 'agnes/skills')?.status
        if (
          currentStatus?.loaded &&
          (previous.entryRevision === revision || previous.entryRevision.startsWith(`${revision}:retry`))
        ) {
          activeSkillResources = fresh
          preloadSkills = fresh
          return
        }
        const oldInput = activeSkillResources
        const candidate = prepareExtensionRow({
          extensionId: 'agnes/skills',
          entryRevision: previous.entryRevision === revision ? `${revision}:retry${++skillRetry}` : revision,
          skillResources: fresh,
        })
        try {
          await extensionRows.apply(withSkillRow(extensionRows.current(), candidate))
          const status = builtinRows
            .statusEntries()
            .find(({ status }) => status.id === 'agnes/skills')?.status
          if (!status?.loaded)
            throw new HostError('E_EXT_LOAD', 'Skills row failed to load', {
              detail: { id: 'agnes/skills', ...(status?.error ? { error: status.error.code } : {}) },
            })
          activeSkillResources = fresh
          preloadSkills = fresh
        } catch (error) {
          try {
            const restored = prepareExtensionRow({
              extensionId: 'agnes/skills',
              entryRevision: previous.entryRevision,
              skillResources: oldInput,
            })
            await extensionRows.apply(withSkillRow(extensionRows.current(), restored))
            activeSkillResources = oldInput
            preloadSkills = oldInput
          } catch (restoreError) {
            throw new AggregateError([error, restoreError], 'Skills row refresh recovery required')
          }
          throw error
        }
      })
      skillRefreshTail = task.then(
        () => undefined,
        () => undefined,
      )
      return task
    }
    // ==== end ext: rows ====
    const reloadEcosystemExtension = async (
      id: string,
      freshInit: Readonly<{ skillResources?: SkillRuntimeInput }>,
    ): Promise<ExtensionStatus> => {
      // Transitional worker API: Skills now load only through their Cordis row. The worker call is
      // retired after its resource-generation compensation transaction moves to refreshSkillRow.
      if (id === 'agnes/skills') {
        await refreshSkillRow(freshInit.skillResources)
        const status = builtinRows.statusEntries().find(({ status }) => status.id === id)?.status
        if (!status) throw new HostError('E_EXT_LOAD', 'Skills row has no status')
        return status
      }
      throw new HostError('E_EXT_LOAD', `${id} is not a reloadable bundled ecosystem extension`, {
        detail: { id },
      })
    }
    rollback.push('extensions', () => managed.disposeAll())
    // A row that replaced a builtin row's extension (or the builtin coming back) evicts the
    // incumbent without waiting for its wind-down (`ExtensionOwners.claim`); the eviction still runs
    // to completion in the background. Left unawaited, `Host.close()` could return with an isolated
    // child still alive, and repeated replacements during the session's life would accumulate
    // children no one ever reaps. This runs last (LIFO), after the tree and every extension have
    // been torn down, so it also catches whatever the teardown itself just evicted.
    rollback.push('extension-evictions', () => extensionOwners.settled())
    // Teardown runs last-in-first-out. The tree's ext: rows revoke their extensions when they are
    // torn down, so the tree has to go before the extension host does, or every revoke fails.
    // Closing twice is a no-op, so the earlier registration still covers a half-finished assembly.
    rollback.push('runtime-target-tree', () => runtimeTargetPublisher.close())

    const extensionStatus = () =>
      mergeExtensionStatus(
        [managed.statusEntries(), rowExtensions.statusEntries(), builtinRows.statusEntries()],
        rowExtensions.replacedBy,
      )
    // 10 ready
    say('host.ready', { hash: profile.hash, extensions: extensionStatus().length })
    const servicesInvocation = serviceInvoker({
      registry: services,
      ...(deps.serviceAuthority ? { authority: deps.serviceAuthority } : {}),
      principals: seams.principals,
      audit: deps.audit,
      signal: ac.signal,
      context: serviceContext({
        seams,
        networkAllow: Object.freeze([...adapters.fs.fence().networkAllow]),
        log: deps.log,
      }),
    })
    return {
      activationBarrier,
      approvalGrants: approvalGrantControl.management,
      callService: servicesInvocation.call,
      inspectService: servicesInvocation.inspect,
      prepareService: servicesInvocation.prepare,
      callPreparedService: servicesInvocation.callPrepared,
      inspectPreparedService: servicesInvocation.inspectPrepared,
      kernel,
      seams,
      get provider() {
        return provider
      },
      get providerFingerprint() {
        return providerFingerprint
      },
      get routes() {
        return routes
      },
      get preconfiguredRoutes() {
        return preconfiguredRoutes
      },
      applyModelProfile,
      presets,
      runtimes,
      adapters,
      lockedPackageMutations,
      computerUse: computerUseStatus,
      get computerUseArtifactGc() {
        return computerUseArtifactGc
      },
      pluginTree,
      extHost: managed,
      extensionStatus,
      rollback,
      defaultPreset: { view, hash: defaultPreset.hash },
      openWorkspaceRuntime,
      reloadEcosystemExtension,
      extensionRows,
      refreshSkillRow,
      ordinaryReconciliation,
      ordinaryConvergence: () => {
        const report = runtimeTargetPublisher.current().value.current?.report
        if (!report) {
          throw new HostError('E_EXT_LOAD', 'runtime target publisher produced no report', {
            detail: { reason: 'runtime-target-unpublished' },
          })
        }
        return report
      },
      publicationDispatch,
      applyRuntimeTarget,
      bindRuntimeSession,
      unbindRuntimeSession,
      sessionPresetLimits: () => ({
        limits: profile.limits,
        park: businessLimit(hotPolicy, 'approval.park'),
      }),
    }
  } catch (e) {
    return fail(step, e)
  }
}
