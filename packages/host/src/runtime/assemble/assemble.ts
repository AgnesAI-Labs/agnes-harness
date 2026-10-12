import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolRegistry } from '@agnes/core'
import {
  type CurrentSessionRuntime,
  DEFAULT_LOOP,
  type Enforcement,
  type HookPort,
  Kernel,
  noopHooks,
  type Operation,
  platformFacts,
  type SandboxExecBackend,
  type SeamImplementations,
  type SeamName,
  type SessionImpl,
} from '@agnes/core'
import {
  API_VERSION,
  type ExtensionManifest,
  type LeaseView,
  type MemorySession,
  memoryKind,
  type ResourceEntry,
  type SystemPromptProvider,
  systemPromptKind,
} from '@agnes/extension-api'
import { createProductionImageInputTokenFallback } from '@agnes/host-artifacts/request-media-runtime'
import { createTrajectoryLifecycle } from '@agnes/host-artifacts/trajectory-lifecycle'
import { installProviderRegistry, installProviders } from '@agnes/host-common/assemble/provider-registry'
import { HostError } from '@agnes/host-common/errors'
import { privateStateRoots } from '@agnes/host-common/paths'
import { resolvePreset } from '@agnes/host-common/presets/resolve'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import {
  assertCompositionCompatible,
  type CompositionPatch,
  type ResolvedComposition,
  resolveComposition,
} from '@agnes/host-common/profile/composition'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import {
  bindApprovalTicket,
  businessLimit,
  commandHookInvocationSnapshot,
  createHotPolicyFacade,
} from '@agnes/host-common/profile-policy'
import { PublicationDispatch } from '@agnes/host-common/publication-dispatch'
import { PublicationGate } from '@agnes/host-common/publication-gate'
import { HostQuietState } from '@agnes/host-common/quiet-state'
import type { WorkspaceBinding } from '@agnes/host-common/workspace-authority'
import { compileWorkspacePolicy, normalizeSandboxStaticConfig } from '@agnes/host-common/workspace-policy'
import {
  buildExtensionRow,
  composeExtensionRowTarget,
  type DynamicExtension,
  EXT_ROW_EXTENSION_IDS,
  EXT_ROW_MOUNT_REVISION,
  type ExtRowLoader,
  MIGRATED_EXTENSION_IDS,
} from '@agnes/host-extensions/assemble/ext-rows'
import { bindExtensionInvocations } from '@agnes/host-extensions/assemble/extension-ports'
import type {
  OperationDeps,
  SeamInitContext,
  SeamProfileView,
  SkillRuntimeDiscovery,
} from '@agnes/host-extensions/assemble/packages'
import type { HostBuiltinRowClaim, HostPluginTreeBase } from '@agnes/host-extensions/assemble/seams-cordis'
import { type BuiltinRowHandle, createBuiltinRowHost } from '@agnes/host-extensions/ext-host/builtin-row-host'
import { createExtensionFactorySelector } from '@agnes/host-extensions/ext-host/extension-isolation-selector'
import { ExtensionOwners } from '@agnes/host-extensions/ext-host/extension-owners'
import {
  createExtensionOrder,
  mergeExtensionStatus,
} from '@agnes/host-extensions/ext-host/extension-status-book'
import {
  createManagedExtHost,
  type ExtensionSpec,
  type ExtensionStatus,
} from '@agnes/host-extensions/ext-host/index'
import { leaseFor, ROW_BOUND_LEASE_TTL_MS } from '@agnes/host-extensions/ext-host/lease'
import { readAuthorManifest, readBundledExtensionDirs } from '@agnes/host-extensions/ext-host/manifest'
import { preflightEmbeddedExtension, preflightExtension } from '@agnes/host-extensions/ext-host/preflight'
import { createRowExtensionHost } from '@agnes/host-extensions/ext-host/row-extension-host'
import { createRowServiceHost } from '@agnes/host-extensions/ext-host/row-services'
import { serviceContext } from '@agnes/host-extensions/ext-host/service-context'
import { serviceInvoker } from '@agnes/host-extensions/ext-host/service-invocation'
import { ServiceRegistry } from '@agnes/host-extensions/ext-host/services'
import { ExtensionSessions } from '@agnes/host-extensions/ext-host/session-bindings'
import {
  bindSkillRuntimeToWorkspace,
  createSkillPromptPreloader,
} from '@agnes/host-extensions/resources/skill-preload'
import { safeSkillReadRoots } from '@agnes/host-extensions/resources/skill-read-roots'
import type { SkillRuntimeInput } from '@agnes/host-extensions/resources/skills'
import { resolveFileSecretsDirectory } from '@agnes/host-infrastructure/adapters/file-secrets-dir'
import { powerShellCommand } from '@agnes/host-infrastructure/adapters/powershell-command'
import { createPublicFetch } from '@agnes/host-infrastructure/adapters/public-fetch/index'
import { createLocalSandboxProvider } from '@agnes/host-infrastructure/adapters/sandbox-local'
import {
  composeSecrets,
  createSecretsEnv,
  createSecretsFile,
} from '@agnes/host-infrastructure/adapters/secrets'
import type { SessionWorkspaceFence } from '@agnes/host-infrastructure/adapters/session-workspace'
import { persistenceProviderRegistry } from '@agnes/host-infrastructure/adapters/storage-provider'
import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import { RequestTraceStore } from '@agnes/host-infrastructure/request-traces'
import { sandboxReadPaths } from '@agnes/host-infrastructure/sandbox-read-paths'
import { SandboxReadinessManager } from '@agnes/host-infrastructure/sandbox-readiness-manager'
import { prepareSandboxWorkspaceAncestor } from '@agnes/host-infrastructure/sandbox-workspace-ancestor'
import {
  createSessionWorkspaceRuntime,
  type SessionWorkspaceRuntime,
  type WorkspaceRuntimeFence,
} from '@agnes/host-infrastructure/session-workspace-runtime'
import { SystemPromptSettingsStore } from '@agnes/host-infrastructure/system-prompt-settings'
import { WorkspaceHookLoader } from '@agnes/host-infrastructure/workspace-hook-loader'
import {
  openWorkspaceSeamContexts,
  type WorkspaceSeamContexts,
} from '@agnes/host-infrastructure/workspace-seam-contexts'
import {
  bindStartupSandboxProvider,
  installSandboxProviders,
  LOCAL_SANDBOX_PROVIDER_ID,
  sandboxProviderCatalog,
  sandboxProviderIdFrom,
} from '@agnes/host-providers/adapters/sandbox-providers'
import { assembleCompaction } from '@agnes/host-providers/assemble/compaction'
import {
  compactionEngineCatalog,
  installCompactionEngines,
  withBuiltinCompactionEngines,
} from '@agnes/host-providers/assemble/compaction-engines'
import { bindModelContracts } from '@agnes/host-providers/assemble/contracts'
import { DeferredInvocationsService } from '@agnes/host-providers/assemble/deferred-invocations'
import { readAdminLoopDefault } from '@agnes/host-providers/assemble/loop-selection'
import { installLoops } from '@agnes/host-providers/assemble/loops'
import {
  installModelAdapters,
  modelAdapterCatalog,
  withBuiltinModelAdapters,
} from '@agnes/host-providers/assemble/model-adapters'
import { modelRuntime } from '@agnes/host-providers/assemble/model-runtime'
import { buildOrdinaryRows } from '@agnes/host-providers/assemble/ordinary-rows'
import { buildPresetRows } from '@agnes/host-providers/assemble/preset-rows'
import {
  buildProvider,
  readCreditsPerUsd,
  unresolvedProviderAssembly,
} from '@agnes/host-providers/assemble/provider'
import {
  applyProviderSelections,
  providerConfigurationScopes,
  selectConfiguredProviders,
} from '@agnes/host-providers/assemble/provider-selection'
import { installReferenceResolvers } from '@agnes/host-providers/assemble/reference-resolvers'
import {
  materializeRoutes,
  pinPresetRoutes,
  sweepAwsDestination,
  verifyRoutes,
} from '@agnes/host-providers/assemble/routes'
import { buildSeamRows, REQUIRED_SEAM_ROW_IDS } from '@agnes/host-providers/assemble/seam-rows'
import { skillRowRevision, withSkillRows } from '@agnes/host-providers/assemble/skill-row'
import { installToolProviders, withBuiltinToolPolicies } from '@agnes/host-providers/assemble/tool-providers'
import {
  type GenerationRegistries,
  generationRegistries,
  prepareGenerationOwnerReplacement,
  publishedSessionRuntime,
  retainGenerationRegistries,
} from '@agnes/host-providers/runtime-generation-view'
import {
  type IsolatedSessionOverlay,
  isolateSessionOverlay,
  syncHotPolicyFromTarget,
} from '@agnes/host-providers/runtime-hot-policy'
import { RuntimeMutationGate } from '@agnes/host-providers/runtime-mutation-gate'
import { RuntimePluginCatalogue } from '@agnes/host-providers/runtime-plugin-catalogue'
import { sessionOverlayDesired } from '@agnes/host-providers/runtime-session-overlay'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import { RuntimeTargetPublisher } from '@agnes/host-providers/runtime-target-publisher'
import {
  createHostRuntimeTargetResourceFactory,
  type HostRuntimeTargetResources,
} from '@agnes/host-providers/runtime-target-resource-bootstrap'
import { correlatedLogger } from '@agnes/observability'
import { developmentPluginRows, readPluginCapabilities } from '@agnes/package-manager'
import {
  createMutableSeamImplementations,
  type EntryRow,
  type RuntimeConvergenceReport,
  type RuntimeTarget,
} from '@agnes/plugin-runtime/host'
import type { RouteTable } from '@agnes/protocol'
import { createNetFetch, lazyPackageTables, sandboxHostServices, toSeamAdapters } from '../adapters/index.js'
import { createApprovalGrantControlPlane, migrateApprovalGrants } from '../approval/grants.js'
import { inspectComputerUseArtifacts, mountComputerUse } from '../computer-use/index.js'
import {
  compositionSkillOwners,
  compositionSkills,
  compositionTools,
} from '../profile/composition-visibility.js'
import {
  capabilityClientCatalog,
  capabilityEnabled,
  capabilityToolCatalog,
  resolveSessionCapabilities,
} from '../profile/session-capabilities.js'
import { createExtensionServiceHost, type ExtensionServiceHost } from '../services/author-port.js'
import { installGitWorktreeService } from '../services/git-worktrees.js'
import { installObservabilityService, startObservabilityFeed } from '../services/observability-feed.js'
import { rememberDeferredInvocations } from '../sessions/deferred-invocations.js'
import { createIntelligentUiBridge, type UiDataSourceCatalog } from '../sessions/intelligent-ui.js'
import { createSessionHookPort, readTelemetryConsent } from '../sessions/session-hooks.js'
import type { Assembled, OrdinaryReconciliationLifecycle } from './assembled.js'
import type { AssembleDeps } from './assembly-deps.js'
import { childAgentCatalog, installChildAgents, withBuiltinChildAgents } from './child-agents.js'
import { createAssemblyContext, duplicateContribution, failAssembly } from './context.js'
import { loadPackages } from './packages.js'
import { resolvePresetCatalog } from './presets.js'
import { openProcessServices } from './process-services.js'
import { initStaticSeams } from './seams.js'
import { authorizeServiceProcess } from './service-process-policy.js'
import { trustedHookCommands } from './trusted-hooks.js'

/**
 * A raw module import, distinct from `PackageLoader`: `createManagedExtHost` evaluates an
 * extension's own entry file and reads its `default` export itself, whereas `deps.loader`
 * (`PackageLoader.importPackage`) normally runs that entry through `readNamedExports`'
 * seams/operations/runtimes/presets validation. Static preflight defers required/isolated-only
 * nonbuiltin roots so their entry cannot run before isolation selection.
 *
 * The default, when `deps.extensionLoader` is not supplied, is plain native `import()` - the exact
 * native-import behavior used by the builtin-row extension loader. That default is load-bearing:
 * `@agnes/base`'s real
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

export type {
  Assembled,
  HostComputerUseRuntimeStatus,
  HostComputerUseStatusSource,
  ManagedExtHost,
  OrdinaryReconciliationLifecycle,
} from './assembled.js'
export type { AssembleDeps, HostPaths } from './assembly-deps.js'

export async function assemble(profile: ResolvedProfile, deps: AssembleDeps): Promise<Assembled> {
  const ctx = createAssemblyContext(profile, deps)
  const {
    dataDir,
    workspaceRoot,
    rollback,
    clock,
    env,
    say,
    refuse,
    done,
    activationBarrier,
    workspaceInvocationFor,
    providerSelections,
  } = ctx
  const ac = ctx.abort
  const { hotPolicy, quietState, publicationGate, runtimeMutationGate, publicationDispatch } = ctx.gates
  try {
    mkdirSync(join(dataDir, 'tmp'), { recursive: true, mode: 0o700 })
    const pkgs = await loadPackages(ctx)
    const {
      dirs,
      modules,
      runtimePackages,
      runtimePackageIds,
      activeRuntimeSources,
      inventory,
      loadRuntimeModule,
    } = pkgs
    done('adapters')

    const {
      adapters,
      sandboxProviderSlot,
      skillReadRoots,
      gitWorktrees,
      lockedPackageMutations,
      secrets,
      nativePlatform,
    } = await openProcessServices(ctx, pkgs)
    done('presets')

    const { presets, defaultPreset, profileConsent } = resolvePresetCatalog(ctx, pkgs)
    done('seams')
    // 5 seams
    const seamProfile: SeamProfileView = {
      name: ctx.profile.name,
      resolvedProfileHash: ctx.profile.hash,
      dataDir,
      workspaceRoot,
      homeDir: deps.homeDir ?? homedir(),
      limits: ctx.profile.limits,
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
    const retention = inspectComputerUseArtifacts({
      profile: ctx.profile,
      dataDir,
      platform: adapters.platform,
      nativePlatform,
      clock,
      log: deps.log,
    })
    const contextFor = (owner: string, seamName: SeamName): { context: SeamInitContext; cleanup(): void } => {
      const context = {
        ...baseContext(owner),
        ...retention.contextFor(owner, seamName),
      }
      // Only the sandbox factory is handed the path-policy canonicalizer and a probe exec, and the
      // probe dies with the factory. Every other seam gets the plain context - and the
      // policy-bound exec inside it.
      if (seamName !== 'sandbox') return { context, cleanup: () => undefined }
      const { services, revoke } = sandboxHostServices(adapters)
      return { context: { ...context, sandboxHost: services }, cleanup: revoke }
    }
    const staticSeams = await initStaticSeams(ctx.profile, modules, contextFor, {
      timeoutMs: deps.seamTimeoutMs ?? 30_000,
      platform: adapters.platform,
      rollback,
    })
    const sandboxPackage = modules.get(ctx.profile.seams.sandbox)
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
      const providerId = sandboxProviderIdFrom(ctx.profile)
      if (providerId !== LOCAL_SANDBOX_PROVIDER_ID) {
        await bindStartupSandboxProvider(sandboxProviderSlot, ctx.profile, plan.policy.workspaceRoot, false)
        const selected = sandboxProviderSlot.selected
        if (!selected) throw new HostError('E_SANDBOX_WORKSPACE', 'sandbox provider instance is unavailable')
        const capabilities = selected.capabilities
        const enforcement = capabilities.enforcement ?? { level: 'none' as const, scope: [] }
        const full =
          enforcement.level === 'full' &&
          ['file', 'network', 'process'].every((scope) =>
            enforcement.scope.includes(scope as 'file' | 'network' | 'process'),
          )
        if (
          !capabilities.available ||
          (!full &&
            (plan.staticConfig.required ||
              (plan.staticConfig.level === 'L1' && plan.staticConfig.onUnavailable === 'deny')))
        )
          throw new HostError(
            'E_SANDBOX_WORKSPACE',
            `sandbox provider ${providerId} cannot enforce the required L1 policy`,
          )
        return Object.freeze({
          execBackend: full && plan.staticConfig.level === 'L1' ? ('l1' as const) : ('none' as const),
          enforcement,
          confine: async () => {
            throw new HostError('E_SANDBOX_WORKSPACE', 'external provider cannot rewrite host argv')
          },
        })
      }
      if (!workspaceProbe)
        throw new HostError('E_SANDBOX_WORKSPACE', 'sandbox workspace probe is unavailable', {
          detail: { reason: 'workspace-probe-missing' },
        })
      const raw = await workspaceProbe({
        level: plan.staticConfig.level,
        required: plan.staticConfig.required,
        onUnavailable: plan.staticConfig.onUnavailable,
        shell: adapters.platform.shell(),
        options: {
          ...plan.backendOptions,
          get readPaths() {
            return adapters.platform.os === 'linux' && plan.staticConfig.access !== 'full-access'
              ? sandboxReadPaths(plan.backendOptions.denyPaths)
              : undefined
          },
        },
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
      const requiresFileIsolation = pluginTree.root.providers
        .catalog()
        .some((entry) => entry.kind === 'memory')
      const requestedSandbox = normalizeSandboxStaticConfig(preset)
      const sandboxConfig = requiresFileIsolation
        ? {
            ...requestedSandbox,
            level: 'L1' as const,
            onUnavailable:
              requestedSandbox.level === 'L1' ? requestedSandbox.onUnavailable : ('allow' as const),
          }
        : requestedSandbox
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
          if (!adapters.transport && adapters.platform.os === 'linux')
            await prepareSandboxWorkspaceAncestor(sessionFence.root)
          const plan = await compileWorkspacePolicy({
            canonicalRoot: sessionFence.root,
            dataDir,
            homeDir: deps.homeDir ?? homedir(),
            protectedPaths: privateStateRoots({
              home: dirname(dirname(deps.profileDir)),
              dataDir,
              profileDir: deps.profileDir,
              ...(ctx.profile.adapters?.secrets.path
                ? { secretsDir: ctx.profile.adapters.secrets.path }
                : {}),
            }),
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
              backendId: ctx.profile.seams.sandbox,
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
                access: plan.staticConfig.access ?? 'workspace-write',
                requiredFileIsolation: requiresFileIsolation,
              })
            },
          ),
        fitSandbox: async (runtime) => {
          if (!fence || !posture)
            throw new HostError('E_SANDBOX_WORKSPACE', 'sandbox posture was not activated', {
              detail: { reason: 'workspace-posture-inactive' },
            })
          const providerId = await bindStartupSandboxProvider(
            sandboxProviderSlot,
            ctx.profile,
            runtime.root,
            adapters.transport !== undefined,
          )
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
            requiredFileIsolation: requiresFileIsolation,
            ...(providerId === LOCAL_SANDBOX_PROVIDER_ID ? {} : { providerId }),
            exec: fence.exec,
            openProcess: fence.openProcess,
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
    const discoveredResources = new WeakMap<SessionImpl, readonly ResourceEntry[]>()
    const skillOwners = compositionSkillOwners(
      deps.runtimePluginCatalogue ?? deps.runtimePluginSnapshots ?? [],
    )
    let availableSkillResources = deps.skillResources
    let preloadSkills = compositionSkills(deps.skillResources, ctx.profile.composition ?? {}, skillOwners)
    let activeSkillResources = preloadSkills
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
    skillReadRoots.current = () =>
      safeSkillReadRoots(preloadSkills?.readRoots?.() ?? [], {
        ...skillReadContext,
        generationRoot: join(deps.profileDir, '.runtime-generations'),
      })
    const runtimePromptPreloader = deps.skillResources
      ? createSkillPromptPreloader(() => preloadSkills, workspaceInvocationFor, publicationDispatch)
      : undefined
    const generationViews = new Map<string, GenerationRegistries>()
    const rawSessionRuntime = (
      sessionKey: string,
      runtimeRegistryRevision?: string,
    ): CurrentSessionRuntime => {
      const session = kernel.get(sessionKey)
      const revision =
        runtimeRegistryRevision ??
        runtimeTargetPublisher.current().value.current?.runtimeRegistryRevision ??
        'unspecified'
      const runtime = publishedSessionRuntime({
        runtimeRegistryRevision: revision,
        cache: generationViews,
        hooks: session?.hooks ?? noopHooks,
        ...(kernel ? { seed: { tools: kernel.tools, resources: kernel.resources } } : {}),
        ...(runtimePromptPreloader ? { runtimePromptPreloader } : {}),
      })
      return runtime
    }
    const sessionRuntimeView = (
      sessionKey: string,
      runtimeRegistryRevision?: string,
    ): CurrentSessionRuntime => {
      const runtime = rawSessionRuntime(sessionKey, runtimeRegistryRevision)
      if (!ctx.profile.composition) return runtime
      return {
        ...runtime,
        tools: compositionTools(
          runtime.tools,
          ctx.profile.composition ?? {},
          ctx.profile.compositionToolScope,
          (tools) => sessionCapabilities(sessionKey, tools),
        ),
      }
    }
    const builtSeams = buildSeamRows({
      ...(deps.generationBuiltinRows ? { generationBuiltinRows: deps.generationBuiltinRows } : {}),
      profile: ctx.profile,
      modules,
      preset: defaultPreset.doc,
      contextFor: (owner, name) => contextFor(owner, name).context,
    })
    const builtPresets = buildPresetRows(presets)
    const ordinaryModules = new Map(modules)
    for (const [id, loaded] of runtimePackages) ordinaryModules.set(id, loaded.module)
    const compositionModules = withBuiltinChildAgents(
      withBuiltinToolPolicies(withBuiltinCompactionEngines(withBuiltinModelAdapters(ordinaryModules))),
    )
    const compositionOwners = new Map(
      [...compositionModules.values()].flatMap((module) =>
        (module.plugins ?? []).map((plugin) => [plugin.declaration.id, module.id] as const),
      ),
    )
    const builtOrdinary = buildOrdinaryRows(ctx.profile, compositionModules, deps.ordinaryPluginLayers)
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
      profileName: ctx.profile.name,
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
      describePackage: (packageId, snapshotId) => {
        const description = pluginCatalogue.describe(packageId, snapshotId)
        const source = pluginCatalogue.get(packageId, snapshotId)
        const declaredCapabilities = source ? readPluginCapabilities(source.snapshot.directory) : undefined
        return (
          description && {
            ...description,
            ...(declaredCapabilities === undefined ? {} : { declaredCapabilities }),
          }
        )
      },
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
    const extensionServices: { current?: ExtensionServiceHost } = {}
    let intelligentUi!: ReturnType<typeof createIntelligentUiBridge>
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
        const resolved = ctx.profile.packages.find((pkg) => pkg.id === source.snapshot.packageId)
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
            const providers = installProviders(root)
            extensionServices.current?.attachBinder(providers)
            providers.configurationSource((entry) =>
              providerConfigurationScopes(entry, ctx.profile, defaultPreset.view),
            )
            const persistence = persistenceProviderRegistry(adapters.storage)
            if (persistence) providers.add(persistence)
            rowExtensions.installRoot(root, origins)
            rowServices.installRoot(root, origins)
            installModelAdapters(root, origins)
            const deferred = new DeferredInvocationsService(root, origins)
            rememberDeferredInvocations(root, deferred)
            intelligentUi.attach(root, origins, deferred)
            installLoops(root, origins, deferred)
            installReferenceResolvers(root)
            const promptRegistry: import('@agnes/host-common/assemble/provider-registry').ProviderRegistry<SystemPromptProvider> =
              installProviderRegistry(root, systemPromptKind, (owner, source, provider) =>
                promptRegistry.register(source, provider, owner),
              )
            const extensionHost = extensionServices.current
            if (!extensionHost) throw new HostError('E_EXT_LOAD', 'service binding is closed')
            installGitWorktreeService(extensionHost, root, origins, gitWorktrees)
            installObservabilityService(extensionHost, root, origins)
            const memoryRegistry: import('@agnes/host-common/assemble/provider-registry').ProviderRegistry<
              import('@agnes/extension-api').MemoryProvider
            > = installProviderRegistry(root, memoryKind, (owner, source, provider) =>
              memoryRegistry.register(source, provider, owner),
            )
            installToolProviders(root, origins)
            installCompactionEngines(root, origins)
            installChildAgents(root, origins, providerSelections['child-agent'])
            const sandboxProviders = installSandboxProviders(root, origins)
            root.providers.register(
              'sandbox',
              '@agnes/host',
              createLocalSandboxProvider(adapters.exec, adapters.platform.os),
            )
            sandboxProviderSlot.registry = sandboxProviders
          },
          ...(deps.skillContribution ? { skillContribution: deps.skillContribution } : {}),
          afterApply: () => {
            const backend = sandboxProviderSlot.registry
              ?.catalog()
              .find((entry) => entry.id === ctx.profile.sandbox?.provider)
            if (backend) deps.onGenerationBasePackages?.([backend.sourcePackage])
            if (kernel) kernel.invalidateSeams()
          },
        }
      },
      verifyCandidate: (candidate, tree) => {
        // The candidate has mounted, so the Kernel tables hold its registrations and leases. A revision
        // cached by an earlier delivery (or by a candidate that was rejected) describes older ones.
        retainGenerationRegistries(
          generationViews,
          runtimeTargetPublisher.current().value.current?.runtimeRegistryRevision,
        )
        rowExtensions.assertReplacements(candidate.tree.rows, tree)
      },
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
    extensionServices.current = createExtensionServiceHost({
      providers: () => publishedOrdinary().root.providers,
      sessionGeneration: (key) => deps.sessionGeneration?.(key),
    })
    intelligentUi = createIntelligentUiBridge({
      extensionHost: extensionServices.current,
      profileDir: deps.profileDir,
      profileName: ctx.profile.name,
      agnesVersion: deps.agnesVersion ?? '0.0.0',
      sessionGeneration: (key) => deps.sessionGeneration?.(key),
      session: (key) => kernel?.get(key),
      providers: () => publishedOrdinary().root.providers as UiDataSourceCatalog,
    })
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
      rows: [
        ...bootTreeRows,
        ...activeRuntimeSources.flatMap((source) =>
          ctx.profile.packages.some((pkg) => pkg.id === source.snapshot.packageId && pkg.enabled)
            ? developmentPluginRows(source, bootTreeRows).filter((row) => row.id.startsWith('web:'))
            : [],
        ),
      ],
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
      deps.onGenerationSessionBinding?.(sessionKey)
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
      (() => {
        const ns = adapters.storage.metadata.namespace('@agnes/host/approval-grants', 'grants')
        if (adapters.storage.sqlite)
          migrateApprovalGrants(lazyPackageTables(adapters.storage, '@agnes/host/approval-grants'), ns)
        return ns
      })(),
      (grantId) => {
        bindApprovalTicket(hotPolicy, grantId)
      },
    )
    const seams: SeamImplementations = {
      ...packageSeams,
      approval: approvalGrantControl.bind(packageSeams.approval),
    }
    const computerUse = mountComputerUse({
      profile: ctx.profile,
      dataDir,
      platform: adapters.platform,
      retention,
      artifacts: {
        put: (bytes, meta) => seams.artifacts.put(bytes, { mime: meta.mime, name: meta.name }),
      },
      rollback,
    })
    say('seams.assembled', { seams: ctx.profile.seams, fsDigest: adapters.fs.fence().digest })
    let privacyTrajectory: SeamInitContext['privacyTrajectory']
    const hookCommands =
      adapters.platform.os === 'win32'
        ? trustedHookCommands(ctx.profile.commandHooks, workspaceRoot, adapters.platform.fs())
        : undefined
    // Factored out so a reload can build the same shape of context
    // against a caller-supplied fresh resource snapshot instead of the boot-time `deps` one, without
    // duplicating the owner/extensionId gating below. `resources` defaults to `deps` itself, so
    // ordinary boot-time callers (`ecosystemContext` below) are unaffected byte for byte.
    // Search discovery follows the currently published live Skills source.
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
      liveResources?: readonly string[],
    ): SeamInitContext => {
      const skills = resources.skillResources
        ? bindSkillRuntimeToWorkspace(resources.skillResources, workspaceInvocationFor, publicationDispatch)
        : undefined
      return {
        ...baseContext(owner),
        sandbox: seams.sandbox,
        ...(owner === '@agnes/base' && extensionId === 'agnes/tools-web' && deps.searchProvider
          ? { searchProvider: deps.searchProvider }
          : {}),
        ...(owner === '@agnes/base' && extensionId === 'agnes/hooks-runner' && hookCommands
          ? { trustedHookCommands: hookCommands }
          : {}),
        ...(liveResources?.includes('skills') && skills ? { skillResources: skills } : {}),
        ...(owner === '@agnes/base' && extensionId === 'agnes/mcp-search'
          ? { skillDiscovery: liveSkillDiscovery }
          : {}),
        ...(owner === '@agnes/base' && extensionId === 'agnes/privacy' && privacyTrajectory
          ? { privacyTrajectory }
          : {}),
        ...(owner === '@agnes/base' && extensionId === 'agnes/schedule'
          ? { scheduleTables: lazyPackageTables(adapters.storage, '@agnes/daemon') }
          : {}),
        ...computerUse.extensionContext(owner, extensionId),
      }
    }
    const ecosystemContext = (owner: string, extensionId: string): SeamInitContext =>
      buildEcosystemContext(owner, extensionId)
    done('provider')

    // Validate explicit kind selections before fitting operation instances.
    selectConfiguredProviders(pluginTree.root, providerSelections)
    // 6 provider - route table first, environment second, credentials third.
    let routes: RouteTable | undefined
    try {
      routes = materializeRoutes(defaultPreset.view, ctx.profile)
    } catch (error) {
      if (
        !(error instanceof HostError) ||
        error.detail?.reason !== 'no-routes' ||
        !(deps.allowUnresolvedProvider || process.env.AGNES_WORKER_KIND === 'session')
      )
        throw error
    }
    const swept = sweepAwsDestination(env, ctx.profile)
    say('provider.env_swept', { removed: swept.removed, set: Object.keys(swept.set) })
    const requestTraces = new RequestTraceStore(
      ctx.profile.dataDir,
      ctx.profile.name,
      undefined,
      Date.now,
      (sessionKey) => ({ generationId: deps.sessionGeneration?.(sessionKey) ?? null }),
    )
    rollback.push('request-traces', requestTraces.start())
    const factory = deps.providerFactory ? { providerFactory: deps.providerFactory } : {}
    let {
      provider,
      contractStore,
      preconfiguredRoutes,
      dispose: disposeProvider,
    } = routes
      ? await buildProvider(ctx.profile, routes, {
          secrets,
          clock,
          log: deps.log,
          trace: requestTraces,
          modelAdapters: pluginTree.root.modelAdapters,
          creditsSnapshot: () => businessLimit(hotPolicy, 'cost.credits_per_usd'),
          ...factory,
        })
      : unresolvedProviderAssembly()
    rollback.push('model-adapters', () => disposeProvider())
    const contractForModel = bindModelContracts(
      provider.registry?.models() ??
        (ctx.profile.provider.routes ?? []).flatMap((route) => route.models ?? []),
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
    const models = modelRuntime({ provider, contractForModel, dispose: disposeProvider }, (error) => {
      say('provider.dispose_failed', { message: error instanceof Error ? error.message : String(error) })
    })
    disposeProvider = () => models.dispose()
    const applyModelProfile = async (next: ResolvedProfile): Promise<void> => {
      next = applyProviderSelections(next)
      const nextRoutes = next.provider.routes?.length
        ? materializeRoutes(defaultPreset.view, next)
        : undefined
      const nextSecrets =
        next.adapters.secrets.kind === 'file'
          ? composeSecrets(
              createSecretsFile({
                dir: resolveFileSecretsDirectory({
                  path: next.adapters.secrets.path,
                  dataDir: next.dataDir,
                }),
              }),
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
            trace: requestTraces,
            modelAdapters: pluginTree.root.modelAdapters,
            creditsSnapshot: () => businessLimit(hotPolicy, 'cost.credits_per_usd'),
            ...factory,
          })
        : unresolvedProviderAssembly()
      let nextContracts: typeof contractForModel
      try {
        if (built.provider.registry && nextRoutes) verifyRoutes(nextRoutes, built.provider.registry)
        nextContracts = bindModelContracts(
          built.provider.registry?.models() ?? built.provider.models(),
          built.contractStore,
        )
      } catch (error) {
        await built.dispose().catch((cleanupError) => {
          say('provider.dispose_failed', { message: String(cleanupError) })
        })
        throw error
      }
      // Publish atomically; old requests keep their image until counting/inference finishes.
      models.publish({ provider: built.provider, contractForModel: nextContracts, dispose: built.dispose })
      provider = built.provider
      preconfiguredRoutes = built.preconfiguredRoutes
      routes = nextRoutes
      providerFingerprint = built.provider.registry?.fingerprint() ?? null
      ctx.profile = next
    }
    const named = routes ? Object.entries(routes).map(([k, v]) => [k, `${v.route}/${v.model}`]) : []
    // The credit rate goes on the audit row, null included. An assembly that priced nothing is the
    // one whose ledger reads in dollars, and that has to be legible afterwards from the record the
    // deployment keeps, not only from a warning on a log nobody kept.
    const creditsPerUsd =
      readCreditsPerUsd(ctx.profile, businessLimit(hotPolicy, 'cost.credits_per_usd')) ?? null
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
        runtimes[n as keyof Assembled['runtimes']] =
          n in runtimes ? duplicateContribution(m.id, 'runtime', n) : f
    }
    done('kernel')

    // 8 kernel - the repository's single Kernel.create call site
    let extensionLeaseFor: ((source: string) => LeaseView | undefined) | undefined
    const observabilityLease = leaseFor(
      {
        id: 'agnes/observability',
        version: '1.0.0',
        apiRange: '^2.0.0',
        entry: './observability',
        capabilities: { hooks: ['session_start', 'shutdown', 'subagent_start', 'subagent_end'] },
      },
      { ttlMs: ROW_BOUND_LEASE_TTL_MS, now: Date.now() },
    )
    rollback.push('observability-lease', () => observabilityLease.revoke('host closed'))
    const compositionLease = ctx.profile.composition
      ? leaseFor(
          {
            id: 'agnes/composition',
            version: '0.1.0',
            apiRange: '^2.0.0',
            entry: './composition',
            capabilities: { hooks: ['tool_call'] },
          },
          { ttlMs: ROW_BOUND_LEASE_TTL_MS, now: Date.now() },
        )
      : undefined
    const extensionSessions = new ExtensionSessions<HookPort>()
    const compaction =
      ctx.profile.composition?.compaction === null
        ? undefined
        : await assembleCompaction(pluginTree.root.compactionEngines, ctx.profile.compaction)
    const selectedLoop = providerSelections.loop
    const loopFactory = selectedLoop
      ? pluginTree.root.loops.resolve({
          id: selectedLoop.provider,
          version: selectedLoop.version ?? pluginTree.root.providers.select('loop', selectedLoop).version,
        })
      : undefined
    const loop = loopFactory ? { id: loopFactory.id, version: loopFactory.version } : undefined
    if (loop) ctx.profile = { ...ctx.profile, loop }
    const effectiveLoop = loop ?? view.loop ?? DEFAULT_LOOP
    pluginTree.root.providers.select(
      'loop',
      { provider: effectiveLoop.id, version: effectiveLoop.version },
      loop ? 'profile' : 'preset',
    )
    pluginTree.root.providers.select('tool-runtime', view.tools.runtime ?? 'default', 'preset')
    if (
      view.approval.policy ||
      pluginTree.root.providers
        .catalog()
        .some((entry) => entry.kind === 'tool-policy' && entry.id === 'default')
    )
      pluginTree.root.providers.select('tool-policy', view.approval.policy ?? 'default', 'preset')
    const promptSelection = view.model.systemPrompt?.provider
      ? { provider: view.model.systemPrompt.provider.id, version: view.model.systemPrompt.provider.version }
      : { provider: 'agnes.system-prompt', version: '1.0.0' }
    const systemPromptProvider = pluginTree.root.providers
      .catalog()
      .some((entry) => entry.kind === 'system-prompt')
      ? (selection?: { id: string; version: string }) =>
          pluginTree.root.providers.resolve(
            systemPromptKind,
            selection ? { provider: selection.id, version: selection.version } : promptSelection,
          )
      : undefined
    if (
      systemPromptProvider &&
      pluginTree.root.providers
        .catalog()
        .some((entry) => entry.kind === 'system-prompt' && entry.id === promptSelection.provider)
    )
      pluginTree.root.providers.select('system-prompt', promptSelection, 'preset')
    const memory = (workspaceRoot: string, sessionKey: string): MemorySession | undefined => {
      const selection = providerSelections.memory ?? { provider: 'file', version: '1.0.0' }
      if (
        !providerSelections.memory &&
        !pluginTree.root.providers.catalog().some((entry) => entry.kind === 'memory')
      )
        return undefined
      return pluginTree.root.providers.resolve(memoryKind, selection).open({
        home: dirname(dirname(deps.profileDir)),
        workspaceRoot,
        sessionKey,
      })
    }
    const toolProviderCatalog = (kind: 'tool-runtime' | 'tool-policy') =>
      Object.freeze(
        pluginTree.root.providers
          .catalog()
          .filter((entry) => entry.kind === kind)
          .map(({ id, version, sourcePackage }) => Object.freeze({ id, version, sourcePackage })),
      )
    kernel = Kernel.create({
      ...(systemPromptProvider
        ? {
            systemPrompt: {
              config: async () => ({
                ...view.model.systemPrompt,
                ...(await new SystemPromptSettingsStore(ctx.profile.dataDir, ctx.profile.name).read()),
              }),
              resolve: systemPromptProvider,
            },
          }
        : {}),
      loopChildren: (parent) => {
        const generation = deps.sessionGeneration?.(parent.sessionKey)
        return pluginTree.root.childAgents.forSession({
          ...parent,
          ...(generation === undefined ? {} : { generation }),
        })
      },
      storage: adapters.storage,
      ...(loop ? { loop } : {}),
      loops: {
        resolve: (selection) => pluginTree.root.loops.resolve(selection),
        catalog: () => pluginTree.root.loops.catalog(),
      },
      toolRuntimes: {
        register: (source, provider) => pluginTree.root.providers.register('tool-runtime', source, provider),
        resolve: (id) => pluginTree.root.providers.resolve('tool-runtime', id),
        catalog: () => toolProviderCatalog('tool-runtime'),
      },
      toolPolicies: {
        register: (source, policy) => pluginTree.root.providers.register('tool-policy', source, policy),
        resolve: (id) => pluginTree.root.providers.resolve('tool-policy', id),
        catalog: () => toolProviderCatalog('tool-policy'),
      },
      loopEvents: {
        on: (event, handler) => pluginTree.root.loopEvents.on(event, handler),
        dispatch: (event, payload, context) => pluginTree.root.loopEvents.dispatch(event, payload, context),
      },
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
      fsOps: {
        ...adapters.fs,
        read: (path, opts) => adapters.fs.read(path, { ...opts, unit: 'bytes' }),
      },
      memoryFor: ({ key, workspaceRoot }) => memory(workspaceRoot, key),
      netFetch: deps.netFetch ?? createNetFetch(),
      publicFetch: deps.publicFetch ?? createPublicFetch(deps.env),
      approvalMode: ctx.profile.approvals.mode,
      toolPolicySettings: async (basePolicy, signal) =>
        pluginTree.root.providers.resolve('tool-policy', basePolicy).settings?.(
          {
            policy: basePolicy,
            dataDir: ctx.profile.dataDir,
            profile: ctx.profile.name,
            approvalMode: ctx.profile.approvals.mode,
          },
          signal,
        ) ?? {},
      ...(computerUse.hostToolDispatch ? { hostToolDispatch: computerUse.hostToolDispatch } : {}),
      ...(ctx.profile.reconcile.point === 'immediate' ? {} : { quiet: quietState }),
      ...(deps.log ? { logger: correlatedLogger(deps.log) } : {}),
      clock,
      agnesVersion: deps.agnesVersion ?? '0.0.0',
      hookLeaseFor: (source) =>
        source === 'agnes/observability'
          ? observabilityLease.view()
          : source === 'agnes/composition'
            ? compositionLease?.view()
            : extensionLeaseFor?.(source),
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
            workspaceRoot: session.workspaceRoot,
            telemetryConsent: readTelemetryConsent(
              resolvePreset(session.preset.name, presets, { limits: ctx.profile.limits }).doc,
            ),
            telemetryConsentPendingAudit: profileConsent !== undefined,
          }),
        (session, sessionRef, engine) =>
          createSessionHookPort(
            session,
            engine,
            () => session.currentResources().snapshot(),
            sessionRef.telemetryConsent,
            sessionRef,
            publicationDispatch,
            (resources) => {
              discoveredResources.set(session, resources)
              const capabilities = sessionCapabilities(session.key, undefined, { session, resources })
              return resources.filter((entry) =>
                entry.kind === 'mcp'
                  ? capabilityEnabled(capabilities.mcp, entry.id)
                  : entry.kind === 'skill'
                    ? capabilityEnabled(capabilities.skills, entry.id)
                    : true,
              )
            },
          ),
      ),
      ...(compaction ? { compaction } : {}),
      ...(ctx.profile.limits['lease.ttl_ms'] !== undefined
        ? { leaseTtlMs: ctx.profile.limits['lease.ttl_ms'] }
        : {}),
      // `children` is omitted on purpose: core's default factory refuses with a message saying
      // subagents are assembled later, which is more informative than a host-side stub.
    })
    rollback.push('kernel', () => kernel.close())
    const compositionForPreset = (name?: string, session?: CompositionPatch): ResolvedComposition =>
      resolveComposition(ctx.profile, {
        ...(name ? { preset: resolvePreset(name, presets, { limits: ctx.profile.limits }).doc } : {}),
        ...(session ? { session } : {}),
        rows: builtOrdinary.rows.map((row) => ({
          id: row.id,
          packageId: compositionOwners.get(row.id)!,
          enabled: !row.disabled,
        })),
        catalog: {
          loops: kernel.loops.catalog(),
          modelAdapters: modelAdapterCatalog(pluginTree.root),
          compactionEngines: compactionEngineCatalog(pluginTree.root),
          sandboxProviders: sandboxProviderCatalog(pluginTree.root),
          persistenceProviders: [
            { id: 'sqlite' },
            ...[...modules.values()].flatMap((module) =>
              module.persistenceProvider ? [{ id: module.persistenceProvider.id }] : [],
            ),
          ],
        },
      })
    const sessionCapabilities = (
      sessionKey: string,
      tools: ToolRegistry = rawSessionRuntime(sessionKey).tools,
      call?: {
        name?: string
        readOnly?: boolean
        mcpServer?: string
        session?: SessionImpl
        resources?: readonly ResourceEntry[]
      },
    ): ReturnType<typeof resolveSessionCapabilities> => {
      const session = call?.session ?? kernel.get(sessionKey)
      const registered = session?.currentResources().snapshot() ?? kernel.resources.snapshot()
      const resources = [
        ...new Map(
          [
            ...registered.map(({ entry }) => entry),
            ...(call?.resources ?? (session ? discoveredResources.get(session) : undefined) ?? []),
          ].map((entry) => [entry.id, entry]),
        ).values(),
      ]
      return resolveSessionCapabilities({
        profile: ctx.profile,
        composition:
          deps.compositionPin ??
          (ctx.profile.composition
            ? compositionForPreset(session?.preset.name)
            : resolveComposition(ctx.profile, {
                preset: resolvePreset(session?.preset.name ?? ctx.profile.presets.default, presets, {
                  limits: ctx.profile.limits,
                }).doc,
              })),
        ...(session
          ? {
              presetView: session.preset,
              routes: {
                ...Object.fromEntries(
                  Object.entries(session.preset.model.route).map(([slot, route]) => [
                    slot,
                    { route, model: session.preset.model.id[slot] ?? route },
                  ]),
                ),
                primary: {
                  route: session.preset.model.route.primary!,
                  model: session.preset.model.id.primary ?? session.preset.model.route.primary!,
                },
              },
              pin: {
                legacy: !ctx.profile.composition,
                loop: session.loop,
                generationId: deps.sessionGeneration?.(sessionKey),
              },
            }
          : { presetView: view }),
        installed: {
          plugins: extensionRows
            .current()
            .map((row) => ({ id: row.id, enabled: !row.disabled, packageId: compositionOwners.get(row.id) })),
          tools: capabilityToolCatalog(tools).map((tool) =>
            call?.name === tool.name ? { ...tool, readOnly: tool.readOnly && call.readOnly === true } : tool,
          ),
          modelAdapters: modelAdapterCatalog(pluginTree.root).map((entry) => entry.id),
          childEngines: childAgentCatalog(pluginTree.root).map((entry) => entry.id),
          uiModules: capabilityClientCatalog(activeRuntimeSources),
        },
        ...(session ? { computerUseAllowed: session.computerUseAllowed() } : {}),
        ...(pluginTree.root.childAgents.allowlist(sessionKey)
          ? { childAllowlist: pluginTree.root.childAgents.allowlist(sessionKey)! }
          : {}),
        ...(call?.mcpServer ? { resourceRequest: { kind: 'mcp', id: call.mcpServer } as const } : {}),
        live: {
          models: session?.d.provider.models() ?? [],
          mcp: resources
            .filter((entry) => entry.kind === 'mcp')
            .map((entry) => ({ id: entry.id, name: entry.name })),
          skills: [
            ...new Map(
              [
                ...(availableSkillResources?.list() ?? []).map((skill) => ({
                  id: skill.resourceId,
                  name: skill.name,
                  packageId: skillOwners.get(skill.resourceId),
                })),
                ...resources
                  .filter((entry) => entry.kind === 'skill')
                  .map((entry) => ({ id: entry.id, name: entry.name, packageId: skillOwners.get(entry.id) })),
              ].map((entry) => [entry.id, entry]),
            ).values(),
          ],
        },
      })
    }
    const home = deps.homeDir ?? dirname(dirname(deps.profileDir))
    const observabilityHost = extensionServices.current
    const observabilityFeed = observabilityHost
      ? await startObservabilityFeed({
          providers: pluginTree.root.providers,
          host: observabilityHost,
          home,
          kernel,
          profileHash: ctx.profile.hash,
          dataDir,
          profileDir: deps.profileDir,
          ...(ctx.profile.adapters.secrets.path ? { secretsDir: ctx.profile.adapters.secrets.path } : {}),
          ...(deps.sessionGeneration ? { sessionGeneration: deps.sessionGeneration } : {}),
        })
      : undefined
    const observability = observabilityFeed?.observability
    const observeSession = observabilityFeed?.observeSession ?? (() => () => undefined)
    if (observabilityFeed?.stop) rollback.push('observability-hooks', observabilityFeed.stop)
    if (ctx.profile.composition) {
      assertCompositionCompatible(compositionForPreset(), compositionForPreset(ctx.profile.presets.default))
      const stopPolicy = kernel.hooks.on(
        'tool_call',
        (payload, context) => {
          const session = kernel.sessions.get(context.session.key)
          if (!session) return { allow: false, reason: 'Composition session is unavailable.' }
          const args =
            payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args)
              ? payload.args
              : {}
          const mcpServer =
            ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(
              payload.name,
            ) && typeof args.server === 'string'
              ? args.server
              : undefined
          const capabilities = sessionCapabilities(session.key, undefined, {
            name: payload.name,
            readOnly: payload.meta.isReadOnly === true,
            ...(mcpServer ? { mcpServer } : {}),
          })
          return capabilityEnabled(capabilities.tools, payload.name) &&
            capabilities.resourceRequest?.enabled !== false
            ? { allow: true }
            : { allow: false, reason: 'Tool denied by the selected composition policy.' }
        },
        { source: 'agnes/composition', trust: 'builtin', hookRank: 0 },
      )
      rollback.push('composition-policy', () => {
        stopPolicy()
        compositionLease?.revoke('host closed')
      })
    }
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
    const extensionHost = extensionServices.current
    if (!extensionHost) throw new HostError('E_EXT_LOAD', 'service binding is closed')
    const extPorts = bindExtensionInvocations(
      {
        services,
        serviceProviders: extensionHost.ports,
        tools: ctx.profile.composition
          ? compositionTools(kernel.tools, ctx.profile.composition, ctx.profile.compositionToolScope)
          : kernel.tools,
        hooks: kernel.hooks,
        slots: kernel.slots,
        resources: kernel.resources,
        projections: kernel.projections,
        registrations: (source) => kernel.registrations(source),
      },
      (ref) => kernel.get(ref.key),
      (session) =>
        extensionSessions.ref(session) ??
        Object.freeze({ key: session.key, lane: session.lane, workspaceRoot: session.workspaceRoot }),
      extensionSessions.resolve,
      kernel.projections,
      activationBarrier,
      publicationDispatch,
      extensionHost.sink,
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
      ceiling: ctx.profile.policy.capabilityCeiling,
      seamPackages: new Set([ctx.profile.seams.sandbox, ctx.profile.seams.platform]),
      // Resource extensions keep their existing independent reload path. Only the two static seam
      // owners above are immutable now; the eight ordinary Cordis seams can update in place.
      // mutable() (ext-host/managed-host.ts:214-221) refuses by PACKAGE, and the shipped local-dev
      // template puts @agnes/base in `seams.sandbox` (templates/local-dev.yaml:11), so without this
      // every @agnes/base extension is unrevokable and an ext: row can never unmount. Opening it per
      // ID keeps the protection for every sibling that is not on this list. The list is derived from
      // the constant, not from the rows actually built, so it also names ids that ended up on the
      // assembly-time fallback or were gated off and have no row - harmless: it only lifts an
      // immutability veto, it does not itself revoke or load anything.
      reloadableExtensions: EXT_ROW_EXTENSION_IDS,
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
      ceiling: ctx.profile.policy.capabilityCeiling,
      info: extensionInfo,
      log: deps.log,
      audit: say,
    })
    extensionLeaseFor = (source) =>
      managed.leaseFor(source) ?? rowExtensions.leaseFor(source) ?? builtinRows.leaseFor(source)
    // Factored out so a reload can build its own selector against a
    // `contextFor` bound to fresh resources instead of boot-time `deps`, reusing every other option
    // unchanged rather than restating this literal a second time.
    const makeFactorySelector = (contextFor: (owner: string, extensionId: string) => SeamInitContext) =>
      createExtensionFactorySelector({
        ...(ctx.profile.extensionIsolation ? { options: ctx.profile.extensionIsolation } : {}),
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
      for (const pkg of ctx.profile.packages) {
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
    const consumesSkills = (extensionId: string) => {
      const manifest = authorManifestOf(extensionId)
      return manifest !== 'unreadable' && !!manifest?.liveResources?.includes('skills')
    }
    // A replacement bundled extension can declare the same public resource contract under any id.
    const declaredExtensionIds = new Set(EXT_ROW_EXTENSION_IDS)
    for (const pkg of ctx.profile.packages) {
      if (!pkg.enabled || pkg.trust !== 'builtin') continue
      for (const manifest of modules.get(pkg.id)?.embeddedExtensions ?? [])
        if (manifest.liveResources?.length) declaredExtensionIds.add(manifest.id)
      const directory = dirs.get(pkg.id)
      if (!directory) continue
      try {
        for (const extensionDirectory of readBundledExtensionDirs(directory, true)) {
          const manifest = readAuthorManifest(extensionDirectory)
          if (manifest.liveResources?.length) declaredExtensionIds.add(manifest.id)
        }
      } catch {
        /* Admission below remains fail-closed for unreadable manifests. */
      }
    }
    const reservedToolName = (name: string) => name.toLowerCase().replace(/^_+|_+$/g, '')
    const reservedTools = new Map<string, string>()
    for (const extensionId of declaredExtensionIds) {
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
          (consumesSkills(extensionId)
            ? makeFactorySelector((owner, id) =>
                buildEcosystemContext(owner, id, skillResources ? { skillResources: liveSkillInput } : {}, [
                  'skills',
                ]),
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
        factory: () =>
          dynamic.factory(
            buildEcosystemContext(
              dynamic.spec.package,
              extensionId,
              { skillResources: liveSkillInput },
              dynamic.manifest.liveResources,
            ),
          ),
        registration: 'lifetime',
        onLateRegistration: () => mirrorGenerationOwner(extensionId),
      })
    }
    const preparedExtensionInputs = new Map<string, Parameters<Assembled['extensionRows']['prepare']>[0]>()
    const prepareExtensionRow = (
      input: Readonly<{
        extensionId: string
        entryRevision?: string
        liveResourceRevision?: string
        config?: unknown
        disabled?: boolean
        dynamic?: DynamicExtension
        skillResources?: SkillRuntimeInput | undefined
      }>,
    ) => {
      if (input.dynamic) dynamicExtensionIds.add(input.extensionId)
      const found = input.dynamic ? undefined : findBundledExtension(input.extensionId)
      const manifest = input.dynamic?.manifest ?? authorManifestOf(input.extensionId)
      const liveResources = manifest && manifest !== 'unreadable' ? manifest.liveResources : undefined
      preparedExtensionInputs.set(input.extensionId, input)
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
        ...(liveResources === undefined ? {} : { liveResources }),
        ...(input.liveResourceRevision === undefined
          ? {}
          : { liveResourceRevision: input.liveResourceRevision }),
        loader: extRowLoader,
        owners: extRowOwners,
        onDisposeError,
        ...(input.dynamic
          ? {
              facade: {
                load: () => loadDynamicExtension(input.extensionId, input.dynamic as DynamicExtension),
              },
            }
          : MIGRATED_EXTENSION_IDS.has(input.extensionId) || liveResources?.length
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
        const ceiling = ctx.profile.policy.capabilityCeiling
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
    for (const extensionId of declaredExtensionIds) {
      // The Computer Use gate is a supply condition, not a grant condition: when it is off there is
      // nothing to load, so no row is built.
      if (extensionId === 'agnes/computer-use' && !ctx.profile.computerUse.enabled) continue
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
      ...extRowIds.map((extensionId) => {
        const pinned = deps.generationBuiltinRows?.find((row) => row.id === `ext:${extensionId}`)
        return prepareExtensionRow({
          extensionId,
          ...(consumesSkills(extensionId)
            ? {
                liveResourceRevision: skillRowRevision(deps.skillResources),
                skillResources: deps.skillResources,
              }
            : {}),
          ...(pinned
            ? {
                entryRevision: pinned.entryRevision,
                ...(pinned.config === undefined ? {} : { config: pinned.config }),
                ...(pinned.disabled === undefined ? {} : { disabled: pinned.disabled }),
              }
            : {}),
        })
      }),
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
          for (const id of preparedExtensionInputs.keys())
            if (!wanted.has(`ext:${id}`)) preparedExtensionInputs.delete(id)
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
      const supplied = fresh
      fresh = compositionSkills(fresh, ctx.profile.composition ?? {}, skillOwners)
      const task = skillRefreshTail.then(async () => {
        const previousRows = extensionRows.current()
        const consumers = previousRows.filter((row) => row.liveResources?.includes('skills'))
        const revision = skillRowRevision(fresh)
        const statusFor = (row: EntryRow) =>
          builtinRows.statusEntries().find(({ status }) => status.id === row.id.slice('ext:'.length))?.status
        const changed = consumers.filter(
          (row) =>
            !row.disabled &&
            (!statusFor(row)?.loaded ||
              (row.liveResourceRevision !== revision &&
                !row.liveResourceRevision?.startsWith(`${revision}:retry`))),
        )
        const oldInput = activeSkillResources
        const oldAvailable = availableSkillResources
        const oldPrepared = new Map(preparedExtensionInputs)
        const oldClaims = activeBuiltinClaims
        try {
          const replacements = new Map(
            changed.map((row) => {
              const extensionId = row.id.slice('ext:'.length)
              return [
                row.id,
                prepareExtensionRow({
                  ...oldPrepared.get(extensionId),
                  extensionId,
                  entryRevision: row.entryRevision,
                  liveResourceRevision:
                    row.liveResourceRevision === revision ? `${revision}:retry${++skillRetry}` : revision,
                  ...(row.config === undefined ? {} : { config: row.config }),
                  disabled: row.disabled,
                  skillResources: fresh,
                }),
              ]
            }),
          )
          if (changed.length)
            await extensionRows.apply(withSkillRows(previousRows, [...replacements.values()]))
          for (const row of changed) {
            const status = statusFor(row)
            if (!status?.loaded)
              throw new HostError('E_EXT_LOAD', 'Live resource consumer failed to load', {
                detail: { id: row.id, ...(status?.error ? { error: status.error.code } : {}) },
              })
          }
          activeSkillResources = fresh
          preloadSkills = fresh
          availableSkillResources = supplied
        } catch (error) {
          try {
            activeBuiltinClaims = oldClaims
            preparedExtensionInputs.clear()
            for (const [id, input] of oldPrepared) preparedExtensionInputs.set(id, input)
            await extensionRows.apply(previousRows)
            activeSkillResources = oldInput
            preloadSkills = oldInput
            availableSkillResources = oldAvailable
          } catch (restoreError) {
            throw new AggregateError([error, restoreError], 'Live resource refresh recovery required')
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
      if (
        extensionRows.current().some((row) => row.id === `ext:${id}` && row.liveResources?.includes('skills'))
      ) {
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
    say('host.ready', { hash: ctx.profile.hash, extensions: extensionStatus().length })
    const servicesInvocation = serviceInvoker({
      authorize: async (entry, params, actor, workspace, signal) => {
        if (
          entry.owner === 'agnes/jobs-web' &&
          entry.capability.name === 'jobs.control' &&
          params.input &&
          typeof params.input === 'object' &&
          !Array.isArray(params.input) &&
          ['open', 'send'].includes(String(params.input.operation))
        )
          await authorizeServiceProcess(
            kernel.get(params.sessionId),
            {
              actor,
              session: {
                key: params.sessionId,
                lane: 'main',
                workspaceRoot: workspace.root,
                turn: 0,
                step: 0,
              },
              requestId: params.commandId ?? 'inspection',
              signal,
            },
            workspace.root,
          )
      },
      registry: services,
      ...(deps.serviceAuthority ? { authority: deps.serviceAuthority } : {}),
      principals: seams.principals,
      audit: deps.audit,
      signal: ac.signal,
      context: serviceContext({
        authorizeProcess: (identity, cwd) =>
          authorizeServiceProcess(kernel.get(identity.session?.key ?? ''), identity, cwd),
        seams,
        networkAllow: Object.freeze([...adapters.fs.fence().networkAllow]),
        log: deps.log,
      }),
    })
    const sessionConfiguration = createConfigurationService({
      home: deps.homeDir ?? dirname(dirname(deps.profileDir)),
      profile: ctx.profile.name,
      profileDir: deps.profileDir,
    })
    return {
      memory,
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
      observeSession,
      ...(observability ? { observability } : {}),
      ...(deps.referenceLimits ? { referenceLimits: deps.referenceLimits } : {}),
      providers: { catalog: () => pluginTree.root.providers.catalog() },
      modelAdapterCatalog: () => modelAdapterCatalog(pluginTree.root),
      sessionPresetDefault: async () => (await sessionConfiguration.sessionDefaults()).defaults.preset,
      sessionLoopDefault: () => readAdminLoopDefault(sessionConfiguration),
      sessionModelSlots: async () => (await sessionConfiguration.modelSlots()).slots,
      compactionEngineCatalog: () => compactionEngineCatalog(pluginTree.root),
      childAgentCatalog: () => childAgentCatalog(pluginTree.root),
      compositionForPreset,
      sessionCapabilities,
      applyModelProfile,
      presets,
      runtimes,
      adapters,
      lockedPackageMutations,
      computerUse: computerUse.status,
      get computerUseArtifactGc() {
        return computerUse.artifactGc()
      },
      pluginTree,
      intelligentUi,
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
      runtimeTargetSnapshot: () => {
        const target = runtimeTargetPublisher.current().value.current?.target
        if (!target) throw new Error('E_GENERATION_TARGET_MISSING: no published target')
        return target
      },
      bindRuntimeSession,
      unbindRuntimeSession,
      ...(systemPromptProvider ? { systemPromptProvider } : {}),
      sessionPresetLimits: () => ({
        limits: ctx.profile.limits,
        park: businessLimit(hotPolicy, 'approval.park'),
      }),
    }
  } catch (e) {
    return failAssembly(ctx, e)
  }
}
