import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionImpl } from '@agnes/core'
import type { ResourceEntry } from '@agnes/extension-api'
import { HostError } from '@agnes/host-common/errors'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { businessLimit } from '@agnes/host-common/profile-policy'
import { mergeExtensionStatus } from '@agnes/host-extensions/ext-host/extension-status-book'
import { compactionEngineCatalog } from '@agnes/host-providers/assemble/compaction-engines'
import { readAdminLoopDefault } from '@agnes/host-providers/assemble/loop-selection'
import { modelAdapterCatalog } from '@agnes/host-providers/assemble/model-adapters'
import { mountComputerUse } from '../computer-use/index.js'
import type { Assembled } from './assembled.js'
import type { AssembleDeps } from './assembly-deps.js'
import { buildBootRows } from './boot-rows.js'
import { createBundledExtensions } from './bundled-extensions.js'
import { createCapabilities } from './capabilities.js'
import { childAgentCatalog } from './child-agents.js'
import { createAssemblyContext, failAssembly } from './context.js'
import { createEcosystemContexts } from './ecosystem-context.js'
import { createExtensionHost } from './extension-host.js'
import { mountExtensionRows } from './extension-rows.js'
import { createHostServices } from './host-services.js'
import { startKernelHooks } from './kernel-hooks.js'
import { createKernel, type ExtensionLeases } from './kernel-stage.js'
import { buildOperations } from './operations.js'
import { bindSeams } from './package-seams.js'
import { loadPackages } from './packages.js'
import { resolvePresetCatalog } from './presets.js'
import { openProcessServices } from './process-services.js'
import { assembleProvider } from './provider-stage.js'
import { createRowHosts } from './row-hosts.js'
import { mountRuntimeTarget } from './runtime-target.js'
import { openSeamContexts } from './seam-contexts.js'
import { createSkillRefresh } from './skill-refresh.js'
import { createSkillState } from './skills.js'
import { createWorkspaceRuntimeFactory } from './workspace-runtime.js'

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

    const proc = await openProcessServices(ctx, pkgs)
    const {
      adapters,
      sandboxProviderSlot,
      skillReadRoots,
      gitWorktrees,
      lockedPackageMutations,
      secrets,
      nativePlatform,
    } = proc
    done('presets')

    const presetCatalog = resolvePresetCatalog(ctx, pkgs)
    const { presets, defaultPreset, profileConsent } = presetCatalog
    done('seams')
    const seamContexts = await openSeamContexts(ctx, pkgs, proc, presetCatalog)
    const { seamProfile, baseContext, contextFor, retention, staticSeams } = seamContexts
    const workspaceRuntime = createWorkspaceRuntimeFactory(ctx, pkgs, proc, presetCatalog, seamContexts)
    const { openWorkspaceRuntime } = workspaceRuntime
    const discoveredResources = new WeakMap<SessionImpl, readonly ResourceEntry[]>()
    const skillState = createSkillState(ctx, proc)
    const { owners: skillOwners } = skillState
    const bootRows = buildBootRows(ctx, pkgs, presetCatalog, seamContexts)
    const {
      builtSeams,
      builtPresets,
      builtOrdinary,
      compositionOwners,
      staticBootRows,
      bootTreeRows,
      builtin,
    } = bootRows
    const rowHosts = createRowHosts(ctx, pkgs, workspaceRuntime)
    const { pluginCatalogue, extensionInfo, extensionOrder, extensionOwners, rowExtensions, rowServices } =
      rowHosts
    const runtimeTarget = await mountRuntimeTarget(ctx, {
      pkgs,
      proc,
      presets: presetCatalog,
      bootRows,
      hosts: rowHosts,
      skillState,
    })
    const {
      publisher: runtimeTargetPublisher,
      generationViews,
      rawSessionRuntime,
      sessionRuntimeView,
      extensionServices,
      intelligentUi,
      enqueueRuntimeTarget,
      applyRuntimeTarget,
      ordinaryReconciliation,
      pluginTree,
      bindRuntimeSession,
      unbindRuntimeSession,
    } = runtimeTarget
    const { seams, approvalGrantControl } = bindSeams(ctx, proc, seamContexts, runtimeTarget)
    ctx.live.seams.set(seams)
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
    const ecosystem = createEcosystemContexts(ctx, proc, seamContexts, skillState, computerUse)
    const { buildEcosystemContext, ecosystemContext, privacyTrajectory } = ecosystem
    done('provider')

    const providerStage = await assembleProvider(ctx, proc, presetCatalog, pluginTree)
    const { models, view, applyModelProfile } = providerStage
    done('operations')

    const { operations, runtimes } = buildOperations(ctx, pkgs, proc, seamContexts)
    done('kernel')

    const extensionLeases: ExtensionLeases = {}
    const kernelStage = await createKernel(ctx, {
      proc,
      presets: presetCatalog,
      providerStage,
      operations,
      runtimeTarget,
      skillState,
      computerUse,
      discoveredResources,
      extensionLeases,
    })
    const { kernel, extensionSessions, compositionLease, systemPromptProvider, memory } = kernelStage
    const capabilities = createCapabilities(ctx, {
      pkgs,
      presets: presetCatalog,
      bootRows,
      providerStage,
      runtimeTarget,
      skillState,
      discoveredResources,
    })
    const { compositionForPreset, sessionCapabilities } = capabilities
    const { observability, observeSession } = await startKernelHooks(ctx, {
      kernel,
      kernelStage,
      capabilities,
      ecosystem,
      runtimeTarget,
    })
    done('extensions')

    const extensionHost = createExtensionHost(ctx, {
      pkgs,
      proc,
      kernel,
      kernelStage,
      rowHosts,
      runtimeTarget,
      ecosystem,
      extensionLeases,
    })
    const { managed, builtinRows, makeFactorySelector, selectExtensionFactory } = extensionHost
    const bundled = createBundledExtensions(ctx, pkgs, extensionHost, rowHosts)
    const { findBundledExtension, authorManifestOf, consumesSkills, declaredExtensionIds } = bundled
    const rows = await mountExtensionRows(ctx, {
      kernel,
      bootRows,
      rowHosts,
      runtimeTarget,
      host: extensionHost,
      bundled,
      skillState,
      buildEcosystemContext,
    })
    const { extensionRows, prepareExtensionRow, preparedExtensionInputs } = rows
    const { refreshSkillRow, reloadEcosystemExtension } = createSkillRefresh(ctx, {
      skillState,
      bootRows,
      host: extensionHost,
      rows,
    })
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
    const { servicesInvocation, sessionConfiguration } = createHostServices(ctx, {
      proc,
      kernel,
      host: extensionHost,
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
        return providerStage.provider
      },
      get providerFingerprint() {
        return providerStage.providerFingerprint
      },
      get routes() {
        return providerStage.routes
      },
      get preconfiguredRoutes() {
        return providerStage.preconfiguredRoutes
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
