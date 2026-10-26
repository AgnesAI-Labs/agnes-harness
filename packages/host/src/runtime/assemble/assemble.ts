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
import { type AssemblyContext, createAssemblyContext, failAssembly } from './context.js'
import { createEcosystemContexts } from './ecosystem-context.js'
import { createExtensionHost } from './extension-host.js'
import { mountExtensionRows } from './extension-rows.js'
import { createHostServices } from './host-services.js'
import { startKernelHooks } from './kernel-hooks.js'
import { createKernel, type ExtensionLeases } from './kernel-stage.js'
import { buildOperations } from './operations.js'
import { loadPackages, type PackageSet } from './packages.js'
import { type PresetCatalog, resolvePresetCatalog } from './presets.js'
import { openProcessServices, type ProcessServices } from './process-services.js'
import { assembleProvider } from './provider-stage.js'
import { createRowHosts } from './row-hosts.js'
import { mountRuntimeTarget } from './runtime-target.js'
import { openSeamContexts } from './seam-contexts.js'
import { openSeamSet } from './seam-set.js'
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

/**
 * Assembly runs in five phases, each returning the typed state the next one reads:
 *
 * - `openFoundation` (steps `packages`, `adapters`, `presets`): the enabled packages, the
 *   process-scope services and the preset catalogue.
 * - `mountTree` (step `seams`): the published runtime tree and everything bound to it.
 * - `startCore` (steps `provider`, `operations`, `kernel`): model provider, operations, Kernel.
 * - `mountExtensions` (step `extensions`): bundled extensions and the `ext:` rows.
 * - `publish`: the `Assembled` the Host and its facade read.
 *
 * Only `Foundation.proc` is process scope: it is what does not depend on the plugin set a
 * generation runs. Everything else is rebuilt for every generation container.
 */
type Foundation = Readonly<{ pkgs: PackageSet; proc: ProcessServices; presets: PresetCatalog }>

async function openFoundation(ctx: AssemblyContext): Promise<Foundation> {
  mkdirSync(join(ctx.dataDir, 'tmp'), { recursive: true, mode: 0o700 })
  const pkgs = await loadPackages(ctx)
  ctx.done('adapters')
  const proc = await openProcessServices(ctx, pkgs)
  ctx.done('presets')
  const presets = resolvePresetCatalog(ctx, pkgs)
  return { pkgs, proc, presets }
}

async function mountTree(ctx: AssemblyContext, { pkgs, proc, presets }: Foundation) {
  ctx.done('seams')
  const seamContexts = openSeamContexts(ctx, proc, presets, pkgs)
  const seamSet = openSeamSet(ctx, proc, seamContexts)
  const { seams, approvalGrantControl } = seamSet
  const workspaceRuntime = createWorkspaceRuntimeFactory(ctx, pkgs, proc, presets, seamContexts, seams)
  const skillState = createSkillState(ctx, proc)
  const bootRows = buildBootRows(ctx, pkgs, presets, seamContexts)
  const rowHosts = createRowHosts(ctx, pkgs, workspaceRuntime, proc)
  const runtimeTarget = await mountRuntimeTarget(ctx, {
    pkgs,
    proc,
    presets,
    bootRows,
    hosts: rowHosts,
    skillState,
    seamSet,
  })
  // The first published tree already adopted itself; this keeps the facades correct even when a
  // publisher delivers its first root without the callback.
  seamSet.adopt(runtimeTarget.pluginTree.root)
  const computerUse = mountComputerUse({
    profile: ctx.profile,
    dataDir: ctx.dataDir,
    platform: proc.adapters.platform,
    retention: seamContexts.retention,
    artifacts: { put: (bytes, meta) => seams.artifacts.put(bytes, { mime: meta.mime, name: meta.name }) },
    ...(seams.artifacts.attachments
      ? { pendingAttachments: () => seams.artifacts.attachments!.pendingRoots() }
      : {}),
    rollback: ctx.rollback,
  })
  ctx.say('seams.assembled', { seams: ctx.profile.seams, fsDigest: proc.adapters.fs.fence().digest })
  const ecosystem = createEcosystemContexts(ctx, proc, seamContexts, skillState, computerUse, seams, pkgs)
  return {
    seamContexts,
    workspaceRuntime,
    skillState,
    bootRows,
    rowHosts,
    runtimeTarget,
    seamSet,
    seams,
    approvalGrantControl,
    computerUse,
    ecosystem,
  }
}
type Tree = Awaited<ReturnType<typeof mountTree>>

async function startCore(ctx: AssemblyContext, f: Foundation, t: Tree) {
  const { pkgs, proc, presets } = f
  ctx.done('provider')
  const providerStage = await assembleProvider(ctx, proc, presets, t.runtimeTarget.pluginTree)
  ctx.done('operations')
  const { operations, runtimes } = buildOperations(ctx, pkgs, proc, t.seamContexts)
  ctx.done('kernel')
  const extensionLeases: ExtensionLeases = {}
  const discoveredResources = new WeakMap<SessionImpl, readonly ResourceEntry[]>()
  const kernelStage = await createKernel(ctx, {
    proc,
    presets,
    providerStage,
    operations,
    runtimeTarget: t.runtimeTarget,
    skillState: t.skillState,
    computerUse: t.computerUse,
    approvalGrants: t.approvalGrantControl.port,
    seamSet: t.seamSet,
    discoveredResources,
    extensionLeases,
  })
  const capabilities = createCapabilities(ctx, {
    pkgs,
    presets,
    bootRows: t.bootRows,
    providerStage,
    runtimeTarget: t.runtimeTarget,
    skillState: t.skillState,
    discoveredResources,
  })
  const hooks = await startKernelHooks(ctx, {
    kernel: kernelStage.kernel,
    kernelStage,
    capabilities,
    ecosystem: t.ecosystem,
    runtimeTarget: t.runtimeTarget,
  })
  return { providerStage, runtimes, extensionLeases, kernelStage, capabilities, hooks }
}
type Core = Awaited<ReturnType<typeof startCore>>

async function mountExtensions(ctx: AssemblyContext, f: Foundation, t: Tree, c: Core) {
  ctx.done('extensions')
  const { kernel } = c.kernelStage
  const host = createExtensionHost(ctx, {
    pkgs: f.pkgs,
    proc: f.proc,
    kernel,
    kernelStage: c.kernelStage,
    rowHosts: t.rowHosts,
    runtimeTarget: t.runtimeTarget,
    ecosystem: t.ecosystem,
    extensionLeases: c.extensionLeases,
    seams: t.seams,
  })
  const bundled = createBundledExtensions(ctx, f.pkgs, host, t.rowHosts)
  const rows = await mountExtensionRows(ctx, {
    kernel,
    bootRows: t.bootRows,
    rowHosts: t.rowHosts,
    runtimeTarget: t.runtimeTarget,
    host,
    bundled,
    pkgs: f.pkgs,
    skillState: t.skillState,
    buildEcosystemContext: t.ecosystem.buildEcosystemContext,
  })
  const skillRefresh = createSkillRefresh(ctx, { skillState: t.skillState, bootRows: t.bootRows, host, rows })
  ctx.rollback.push('extensions', () => host.managed.disposeAll())
  // A row that replaced a builtin row's extension (or the builtin coming back) evicts the
  // incumbent without waiting for its wind-down (`ExtensionOwners.claim`); the eviction still runs
  // to completion in the background. Left unawaited, `Host.close()` could return with an isolated
  // child still alive, and repeated replacements during the session's life would accumulate
  // children no one ever reaps. This runs last (LIFO), after the tree and every extension have
  // been torn down, so it also catches whatever the teardown itself just evicted.
  ctx.rollback.push('extension-evictions', () => t.rowHosts.extensionOwners.settled())
  // Teardown runs last-in-first-out. The tree's ext: rows revoke their extensions when they are
  // torn down, so the tree has to go before the extension host does, or every revoke fails.
  // Closing twice is a no-op, so the earlier registration still covers a half-finished assembly.
  ctx.rollback.push('runtime-target-tree', () => t.runtimeTarget.publisher.close())
  // Managed shutdown still needs the current plugin registrations and streams. Drain it before
  // disposing the tree; the earlier registration also protects partially assembled Hosts.
  ctx.rollback.push('profile-managed-drain', () => f.proc.profileManaged.close())
  return { host, rows, skillRefresh }
}
type Extensions = Awaited<ReturnType<typeof mountExtensions>>

function publish(
  ctx: AssemblyContext,
  f: Foundation,
  t: Tree,
  c: Core,
  e: Extensions,
  timing: Readonly<{ reason: string; durationMs: number; stages: Readonly<Record<string, number>> }>,
): Assembled {
  const { deps } = ctx
  const { adapters } = f.proc
  const { pluginTree, publisher } = t.runtimeTarget
  const { rowExtensions } = t.rowHosts
  const { managed, builtinRows } = e.host
  const { systemPromptProvider } = c.kernelStage
  const extensionStatus = () =>
    mergeExtensionStatus(
      [managed.statusEntries(), rowExtensions.statusEntries(), builtinRows.statusEntries()],
      rowExtensions.replacedBy,
    )
  ctx.say('host.ready', { hash: ctx.profile.hash, extensions: extensionStatus().length, ...timing })
  const { servicesInvocation, sessionConfiguration, profileServices } = createHostServices(ctx, {
    proc: f.proc,
    kernel: c.kernelStage.kernel,
    host: e.host,
    publishProfileCurrent: t.runtimeTarget.publishProfileCurrent,
    seams: t.seams,
  })
  return {
    memory: c.kernelStage.memory,
    activationBarrier: ctx.activationBarrier,
    approvalGrants: t.approvalGrantControl.management,
    profileServices,
    serviceBinding: (names) => e.host.services.binding(names),
    callService: servicesInvocation.call,
    inspectService: servicesInvocation.inspect,
    authorizeServiceControl: servicesInvocation.authorizeControl,
    prepareService: servicesInvocation.prepare,
    callPreparedService: servicesInvocation.callPrepared,
    inspectPreparedService: servicesInvocation.inspectPrepared,
    kernel: c.kernelStage.kernel,
    seams: t.seams,
    get provider() {
      return c.providerStage.provider
    },
    get providerFingerprint() {
      return c.providerStage.providerFingerprint
    },
    get routes() {
      return c.providerStage.routes
    },
    get preconfiguredRoutes() {
      return c.providerStage.preconfiguredRoutes
    },
    observeSession: c.hooks.observeSession,
    ...(c.hooks.observability ? { observability: c.hooks.observability } : {}),
    ...(deps.referenceLimits ? { referenceLimits: deps.referenceLimits } : {}),
    providers: { catalog: () => pluginTree.root.providers.catalog() },
    seamBindings: () => t.bootRows.boundSeams(),
    modelAdapterCatalog: () => modelAdapterCatalog(pluginTree.root),
    sessionPresetDefault: async () => (await sessionConfiguration.sessionDefaults()).defaults.preset,
    sessionPermissionDefault: async () => (await sessionConfiguration.sessionDefaults()).defaults.permission,
    sessionLoopDefault: () => readAdminLoopDefault(sessionConfiguration),
    sessionModelSlots: () => sessionConfiguration.modelSlots(),
    compactionEngineCatalog: () => compactionEngineCatalog(pluginTree.root),
    childAgentCatalog: () => childAgentCatalog(pluginTree.root),
    compositionForPreset: c.capabilities.compositionForPreset,
    sessionCapabilities: c.capabilities.sessionCapabilities,
    captureSessionCapabilities: c.capabilities.captureSessionCapabilities,
    applyModelProfile: c.providerStage.applyModelProfile,
    presets: f.presets.presets,
    ...(ctx.deps.retainedModelBootstrap ? { retainedModelBootstrap: true } : {}),
    runtimes: c.runtimes,
    adapters,
    lockedPackageMutations: f.proc.lockedPackageMutations,
    computerUse: t.computerUse.status,
    get computerUseArtifactGc() {
      return t.computerUse.artifactGc()
    },
    pluginTree,
    intelligentUi: t.runtimeTarget.intelligentUi,
    extHost: managed,
    extensionStatus,
    rollback: ctx.rollback,
    defaultPreset: { view: c.providerStage.view, hash: f.presets.defaultPreset.hash },
    openWorkspaceRuntime: t.workspaceRuntime.openWorkspaceRuntime,
    reloadEcosystemExtension: e.skillRefresh.reloadEcosystemExtension,
    extensionRows: e.rows.extensionRows,
    refreshSkillRow: e.skillRefresh.refreshSkillRow,
    ordinaryReconciliation: t.runtimeTarget.ordinaryReconciliation,
    ordinaryConvergence: () => {
      const report = publisher.current().value.current?.report
      if (!report) {
        throw new HostError('E_EXT_LOAD', 'runtime target publisher produced no report', {
          detail: { reason: 'runtime-target-unpublished' },
        })
      }
      return report
    },
    publicationDispatch: ctx.gates.publicationDispatch,
    applyRuntimeTarget: t.runtimeTarget.applyRuntimeTarget,
    runtimeTargetSnapshot: () => {
      const target = publisher.current().value.current?.target
      if (!target) throw new Error('E_GENERATION_TARGET_MISSING: no published target')
      return target
    },
    bindRuntimeSession: t.runtimeTarget.bindRuntimeSession,
    unbindRuntimeSession: t.runtimeTarget.unbindRuntimeSession,
    ...(systemPromptProvider ? { systemPromptProvider } : {}),
    sessionPresetLimits: () => ({
      limits: ctx.profile.limits,
      park: businessLimit(ctx.gates.hotPolicy, 'approval.park'),
    }),
  }
}

export async function assemble(profile: ResolvedProfile, deps: AssembleDeps): Promise<Assembled> {
  const ctx = createAssemblyContext(profile, deps)
  const cause = deps.assemblyCause ?? { reason: 'unspecified' }
  ctx.say('host.assembling', { ...cause, hash: profile.hash })
  const started = performance.now()
  let mark = started
  const stage = () => {
    const now = performance.now(),
      ms = Math.round(now - mark)
    mark = now
    return ms
  }
  try {
    const foundation = await openFoundation(ctx)
    const foundationMs = stage()
    const tree = await mountTree(ctx, foundation)
    const treeMs = stage()
    const core = await startCore(ctx, foundation, tree)
    const coreMs = stage()
    const extensions = await mountExtensions(ctx, foundation, tree, core)
    const extensionsMs = stage()
    return publish(ctx, foundation, tree, core, extensions, {
      reason: cause.reason,
      durationMs: Math.round(performance.now() - started),
      stages: { foundationMs, treeMs, coreMs, extensionsMs },
    })
  } catch (e) {
    return failAssembly(ctx, e)
  }
}
