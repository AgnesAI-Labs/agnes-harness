import type { CurrentSessionRuntime } from '@agnes/core'
import { noopHooks } from '@agnes/core'
import { memoryKind, type SystemPromptProvider, sandboxKind, systemPromptKind } from '@agnes/extension-api'
import { installProviderRegistry, installProviders } from '@agnes/host-common/assemble/provider-registry'
import { HostError } from '@agnes/host-common/errors'
import type { HostPluginTreeBase } from '@agnes/host-extensions/assemble/seams-cordis'
import { pluginRowSource } from '@agnes/host-extensions/ext-host/row-extension-host'
import { createLocalSandboxProvider } from '@agnes/host-infrastructure/adapters/sandbox-local'
import { persistenceProviderRegistry } from '@agnes/host-infrastructure/adapters/storage-provider'
import { installHostPlatform } from '@agnes/host-providers/adapters/platform-provider'
import { installSandboxProviders } from '@agnes/host-providers/adapters/sandbox-providers'
import { installCompactionEngines } from '@agnes/host-providers/assemble/compaction-engines'
import { DeferredInvocationsService } from '@agnes/host-providers/assemble/deferred-invocations'
import { installLoops } from '@agnes/host-providers/assemble/loops'
import { installModelAdapters } from '@agnes/host-providers/assemble/model-adapters'
import { providerConfigurationScopes } from '@agnes/host-providers/assemble/provider-selection'
import { installReferenceResolvers } from '@agnes/host-providers/assemble/reference-resolvers'
import { installSeamKinds } from '@agnes/host-providers/assemble/seam-kinds'
import { REQUIRED_SEAM_ROW_IDS } from '@agnes/host-providers/assemble/seam-rows'
import { installToolProviders } from '@agnes/host-providers/assemble/tool-providers'
import {
  type GenerationRegistries,
  publishedSessionRuntime,
  retainGenerationRegistries,
} from '@agnes/host-providers/runtime-generation-view'
import {
  type IsolatedSessionOverlay,
  isolateSessionOverlay,
  syncHotPolicyFromTarget,
} from '@agnes/host-providers/runtime-hot-policy'
import { pluginSnapshotIdentity } from '@agnes/host-providers/runtime-plugin-catalogue'
import { sessionOverlayDesired } from '@agnes/host-providers/runtime-session-overlay'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import { RuntimeTargetPublisher } from '@agnes/host-providers/runtime-target-publisher'
import {
  createHostRuntimeTargetResourceFactory,
  type HostRuntimeTargetResources,
} from '@agnes/host-providers/runtime-target-resource-bootstrap'
import { developmentPluginRows } from '@agnes/package-manager'
import type { RuntimeConvergenceReport, RuntimeTarget } from '@agnes/plugin-runtime/host'
import { createTreeSnapshot } from '@agnes/plugin-runtime/host'
import { compositionTools } from '../profile/composition-visibility.js'
import { createExtensionServiceHost, type ExtensionServiceHost } from '../services/author-port.js'
import { installHostServices } from '../services/install.js'
import { rememberDeferredInvocations } from '../sessions/deferred-invocations.js'
import { createIntelligentUiBridge, type UiDataSourceCatalog } from '../sessions/intelligent-ui.js'
import type { OrdinaryReconciliationLifecycle } from './assembled.js'
import type { BootRows } from './boot-rows.js'
import { installChildAgents } from './child-agents.js'
import { type AssemblyContext, Late } from './context.js'
import type { PackageSet } from './packages.js'
import type { PresetCatalog } from './presets.js'
import type { ProcessServices } from './process-services.js'
import type { RowHosts } from './row-hosts.js'
import type { SeamSet } from './seam-set.js'
import type { SkillState } from './skills.js'
import { localSandboxImplementation, sandboxBackendPackages } from './workspace-runtime.js'

export type RuntimeTargetHost = Readonly<{
  publishProfileCurrent(): void
  publisher: RuntimeTargetPublisher<HostRuntimeTargetResources, IsolatedSessionOverlay>
  generationViews: Map<string, GenerationRegistries>
  rawSessionRuntime(sessionKey: string, runtimeRegistryRevision?: string): CurrentSessionRuntime
  sessionRuntimeView(sessionKey: string, runtimeRegistryRevision?: string): CurrentSessionRuntime
  extensionServices: { current?: ExtensionServiceHost }
  intelligentUi: ReturnType<typeof createIntelligentUiBridge>
  /** Runs `resolveTarget` when this apply's turn in the queue comes, then publishes it. */
  enqueueRuntimeTarget(
    resolveTarget: () => Parameters<
      RuntimeTargetPublisher<HostRuntimeTargetResources, IsolatedSessionOverlay>['apply']
    >[0],
  ): Promise<RuntimeConvergenceReport>
  applyRuntimeTarget(target: RuntimeTarget): Promise<RuntimeConvergenceReport>
  ordinaryReconciliation: OrdinaryReconciliationLifecycle
  pluginTree: HostPluginTreeBase
  bindRuntimeSession(sessionKey: string, preset: string): Promise<void>
  unbindRuntimeSession(sessionKey: string): Promise<void>
}>

type Publisher = RuntimeTargetPublisher<HostRuntimeTargetResources, IsolatedSessionOverlay>
type RuntimeTargetInput = Readonly<{
  pkgs: PackageSet
  proc: ProcessServices
  presets: PresetCatalog
  bootRows: BootRows
  hosts: RowHosts
  skillState: SkillState
  seamSet: SeamSet
}>

/** State the publisher callbacks, the session views and the apply queue all read; one per assembly. */
type Shared = {
  /** True from the moment the publisher asks for the private input until the next apply starts. */
  candidateMounting: boolean
  publisher: Late<Publisher>
  views: SessionViews
  extensionServices: { current?: ExtensionServiceHost }
  intelligentUi: Late<ReturnType<typeof createIntelligentUiBridge>>
}

type SessionViews = Readonly<{
  generationViews: Map<string, GenerationRegistries>
  rawSessionRuntime: RuntimeTargetHost['rawSessionRuntime']
  sessionRuntimeView: RuntimeTargetHost['sessionRuntimeView']
}>

/** The runtime each open session sees: the published generation's registries, composition-filtered. */
function createSessionViews(
  ctx: AssemblyContext,
  skillState: SkillState,
  publisher: Late<Publisher>,
): SessionViews {
  const generationViews = new Map<string, GenerationRegistries>()
  const rawSessionRuntime = (sessionKey: string, runtimeRegistryRevision?: string): CurrentSessionRuntime => {
    const kernel = ctx.live.kernel.get()
    const session = kernel.get(sessionKey)
    const revision =
      runtimeRegistryRevision ??
      publisher.get().current().value.current?.runtimeRegistryRevision ??
      'unspecified'
    const runtime = publishedSessionRuntime({
      runtimeRegistryRevision: revision,
      cache: generationViews,
      hooks: session?.hooks ?? noopHooks,
      seed: { tools: kernel.tools, resources: kernel.resources },
      ...(skillState.promptPreloader ? { runtimePromptPreloader: skillState.promptPreloader } : {}),
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
        (tools) => ctx.live.sessionCapabilities.get()(sessionKey, tools),
      ),
    }
  }
  return { generationViews, rawSessionRuntime, sessionRuntimeView }
}

function publishProfileActivations(
  proc: ProcessServices,
  catalogue: RowHosts['pluginCatalogue'],
  target: RuntimeTarget,
): void {
  proc.profileActivations.publish(
    target.tree.rows.flatMap((row) => {
      if (row.disabled) return []
      const identity = pluginSnapshotIdentity(row.plugin)
      const description = identity && catalogue.describe(identity.packageId, identity.snapshotId)
      return description
        ? [
            {
              owner: pluginRowSource(row.id),
              revision: createTreeSnapshot([row]).hash,
              integrity: description.integrity,
            },
          ]
        : []
    }),
  )
  void proc.profileManaged.publish().catch(() => undefined)
}

/** The publisher of the one ordinary tree: how rows are loaded, trusted, mounted and verified. */
function createPublisher(ctx: AssemblyContext, input: RuntimeTargetInput, shared: Shared): Publisher {
  const { deps } = ctx
  const { publicationGate, runtimeMutationGate, hotPolicy } = ctx.gates
  const { pkgs, proc, presets, bootRows, hosts } = input
  const { loadRuntimeModule } = pkgs
  const { pluginCatalogue, rowExtensions, rowServices } = hosts
  return new RuntimeTargetPublisher<HostRuntimeTargetResources, IsolatedSessionOverlay>({
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
    staticClaims: () => bootRows.builtin.claims,
    privateInput: () => {
      // Asked once claims have resolved, right before the candidate tree starts mounting rows.
      shared.candidateMounting = true
      return {
        bootRows: Object.freeze([...bootRows.staticBootRows, ...bootRows.builtin.hostExtensionRows]),
        requiredRowIds: REQUIRED_SEAM_ROW_IDS,
        thirdPartyReservedRowIds: REQUIRED_SEAM_ROW_IDS,
        thirdPartyReservedProvides: REQUIRED_SEAM_ROW_IDS,
        rootServices: (root, origins) => {
          const providers = installProviders(root, origins)
          shared.extensionServices.current?.attachBinder(providers)
          providers.configurationSource((entry) =>
            providerConfigurationScopes(entry, ctx.profile, presets.defaultPreset.view),
          )
          const persistence = persistenceProviderRegistry(proc.adapters.storage)
          if (persistence) providers.add(persistence)
          rowExtensions.installRoot(root, origins)
          rowServices.installRoot(root, origins)
          installModelAdapters(root, origins)
          const deferred = new DeferredInvocationsService(root, origins)
          rememberDeferredInvocations(root, deferred)
          shared.intelligentUi.get().attach(root, origins, deferred)
          installLoops(root, origins, deferred)
          installReferenceResolvers(root)
          installSeamKinds(root, origins)
          const promptRegistry: import('@agnes/host-common/assemble/provider-registry').ProviderRegistry<SystemPromptProvider> =
            installProviderRegistry(root, systemPromptKind, (owner, source, provider) =>
              promptRegistry.register(source, provider, owner),
            )
          const extensionHost = shared.extensionServices.current
          if (!extensionHost) throw new HostError('E_EXT_LOAD', 'service binding is closed')
          installHostServices(extensionHost, root, origins, proc.gitWorktrees, ctx.deps)
          const memoryRegistry: import('@agnes/host-common/assemble/provider-registry').ProviderRegistry<
            import('@agnes/extension-api').MemoryProvider
          > = installProviderRegistry(root, memoryKind, (owner, source, provider) =>
            memoryRegistry.register(source, provider, owner),
          )
          installToolProviders(root, origins)
          installCompactionEngines(root, origins)
          installChildAgents(root, origins, ctx.providerSelections['child-agent'], {
            ...(proc.adapters.windowsNodeExecutable
              ? { windowsNodeExecutable: proc.adapters.windowsNodeExecutable }
              : {}),
          })
          const sandboxProviders = installSandboxProviders(root, origins)
          root.providers.registerHost(
            sandboxKind,
            '@agnes/host',
            createLocalSandboxProvider(proc.adapters.exec, proc.adapters.platform.os, {
              l1Implementation: localSandboxImplementation(
                ctx.profile,
                pkgs.modules,
                proc.adapters.platform.os,
              ),
            }),
          )
          // Providers a package exports as `sandboxProvider` are registered under that package; the
          // Host read them before the tree existed because a remote one opens its channel then.
          for (const [packageId, mod] of pkgs.modules)
            if (mod.sandboxProvider) root.providers.registerHost(sandboxKind, packageId, mod.sandboxProvider)
          installHostPlatform(root, proc.adapters.platform.os)
          proc.sandboxProviderSlot.registry = sandboxProviders
        },
        ...(deps.skillContribution ? { skillContribution: deps.skillContribution } : {}),
        afterApply: () => {
          ctx.live.kernel.peek()?.invalidateSeams()
          const backend = proc.sandboxProviderSlot.registry
            ?.catalog()
            .find((entry) => entry.id === ctx.profile.sandbox?.provider)
          deps.onGenerationBasePackages?.([
            ...sandboxBackendPackages(ctx.profile, pkgs.modules),
            ...(backend ? [backend.sourcePackage] : []),
          ])
        },
      }
    },
    verifyCandidate: (candidate, tree) => {
      // The candidate has mounted, so the Kernel tables hold its registrations and leases. A revision
      // cached by an earlier delivery (or by a candidate that was rejected) describes older ones.
      retainGenerationRegistries(
        shared.views.generationViews,
        shared.publisher.get().current().value.current?.runtimeRegistryRevision,
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
        runtime: shared.views.sessionRuntimeView(sessionKey, candidate.runtimeRegistryRevision),
        close: () => undefined,
      })
    },
    onPublished: (target) => {
      if (deps.profileAuthorityPublication !== 'retained')
        publishProfileActivations(proc, pluginCatalogue, target)
      const root = shared.publisher.get().current().value.current?.ordinary.pluginTree.root
      if (root) {
        rowServices.publishRoot(root)
        input.seamSet.adopt(root)
      }
      syncHotPolicyFromTarget(hotPolicy, target)
    },
  })
}

/**
 * Host admission for the one ordinary convergence path, in queue order. `close` seals it
 * synchronously and then joins the queue.
 */
function createApplyQueue(ctx: AssemblyContext, hosts: RowHosts, shared: Shared) {
  const { deps } = ctx
  const { refreshPluginCatalogue } = hosts
  const publisher = shared.publisher.get()
  // A target already admitted finishes loading and applying before the rollback disposes the tree
  // it is mounting into, and a target handed in after that is refused.
  // A rejected candidate leaves the previous tree published, but the candidate's rows have already
  // taken over the extension ids they share with it (the kernel tables are shared), so the previous
  // tree's tools and hooks are gone. Mounting the published target again puts them back; nothing
  // else would, because applying an unchanged target is a no-op.
  const rebuildLiveTree = async () => {
    const live = publisher.current().value.current?.target
    if (!live) return
    try {
      await publisher.apply(live, { rebuild: true })
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
    resolveTarget: () => Parameters<typeof publisher.apply>[0],
  ): Promise<RuntimeConvergenceReport> => {
    if (applyClosed)
      throw new HostError('E_HOST_CLOSED', 'ordinary runtime target application is closed', {
        detail: { reason: 'ordinary-reconciliation-closed' },
      })
    const applied = applyQueue.then(async () => {
      const target = resolveTarget()
      await refreshPluginCatalogue()
      let published: Awaited<ReturnType<typeof publisher.apply>>
      shared.candidateMounting = false
      try {
        published = await publisher.apply(target)
      } catch (error) {
        // A transaction compensates on the live tree itself, and a tree holding a row that never
        // finished mounting must not be retired: waiting on that fiber would hold the mutation
        // gate for ever. Only a failed whole-tree candidate, which had already taken the shared
        // ids over, needs the published target mounted again — UNLESS the transaction's own
        // compensation failed (the live tree may be left half-recovered: a row unmounted but
        // still tracked, so it silently vanishes from the plugin table on the next delivery).
        // A tainted tree already gets the backgrounded-retirement safety net either way.
        const live = publisher.current().value.current?.ordinary.pluginTree
        const compensationFailed =
          publisher.lastAttempt === 'transaction' &&
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
          shared.candidateMounting &&
          (compensationFailed || (!live?.tainted?.() && publisher.lastAttempt !== 'transaction'))
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
  return { enqueueRuntimeTarget, applyRuntimeTarget, ordinaryReconciliation }
}

/**
 * Builds the publisher that owns the one ordinary Cordis tree, applies the boot target and
 * returns the facades the rest of the assembly reads the published tree through. The kernel and
 * session capabilities do not exist yet; the views reach them through `ctx.live`.
 */
export async function mountRuntimeTarget(
  ctx: AssemblyContext,
  input: RuntimeTargetInput,
): Promise<RuntimeTargetHost> {
  const { pkgs, bootRows } = input
  const publisherRef = new Late<Publisher>('runtime target publisher')
  const shared: Shared = {
    candidateMounting: false,
    publisher: publisherRef,
    views: createSessionViews(ctx, input.skillState, publisherRef),
    extensionServices: {},
    intelligentUi: new Late('intelligent ui'),
  }
  const publisher = createPublisher(ctx, input, shared)
  shared.publisher.set(publisher)
  ctx.rollback.push('runtime-target-publisher', () => publisher.close())
  const publishedOrdinary = (): HostPluginTreeBase => {
    const current = publisher.current().value.current
    if (!current) {
      throw new HostError('E_EXT_LOAD', 'runtime target publisher produced no ordinary tree', {
        detail: { reason: 'runtime-target-unpublished' },
      })
    }
    return current.ordinary.pluginTree
  }
  shared.extensionServices.current = createExtensionServiceHost({
    providers: () => publishedOrdinary().root.providers,
    sessionGeneration: (key) => ctx.deps.sessionGeneration?.(key),
    serviceIdentity: (owner) => input.hosts.rowExtensions.serviceIdentity(owner),
  })
  const intelligentUi = createIntelligentUiBridge({
    dataDir: ctx.dataDir,
    extensionHost: shared.extensionServices.current,
    profileDir: ctx.deps.profileDir,
    profileName: ctx.profile.name,
    agnesVersion: ctx.deps.agnesVersion ?? '0.0.0',
    sessionGeneration: (key) => ctx.deps.sessionGeneration?.(key),
    session: (key) => ctx.live.kernel.peek()?.get(key),
    providers: () => publishedOrdinary().root.providers as UiDataSourceCatalog,
  })
  shared.intelligentUi.set(intelligentUi)
  const { enqueueRuntimeTarget, applyRuntimeTarget, ordinaryReconciliation } = createApplyQueue(
    ctx,
    input.hosts,
    shared,
  )
  const initialRuntimeTarget = buildCompleteRuntimeTarget({
    rows: [
      ...bootRows.bootTreeRows,
      ...pkgs.activeRuntimeSources.flatMap((source) =>
        ctx.profile.packages.some((pkg) => pkg.id === source.snapshot.packageId && pkg.enabled)
          ? developmentPluginRows(source, bootRows.bootTreeRows).filter((row) => row.id.startsWith('web:'))
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
  ctx.live.pluginTree.set(pluginTree)
  const bindRuntimeSession = async (sessionKey: string, preset: string): Promise<void> => {
    ctx.deps.onGenerationSessionBinding?.(sessionKey)
    const published = publisher.current().value.current
    if (!published) return
    const overlay = isolateSessionOverlay(published.ordinary.pluginTree.root, sessionKey, preset)
    await publisher.setSessionScope(sessionKey, { preset: overlay.preset }, async () =>
      Object.freeze({
        desired: { preset: overlay.preset },
        overlay,
        runtime: shared.views.sessionRuntimeView(sessionKey, published.runtimeRegistryRevision),
        close: () => undefined,
      }),
    )
  }
  const unbindRuntimeSession = async (sessionKey: string): Promise<void> => {
    await publisher.closeSessionScope(sessionKey)
  }
  return {
    publishProfileCurrent: () => {
      const target = publisher.current().value.current?.target
      if (!target) throw new Error('Profile target unavailable')
      publishProfileActivations(input.proc, input.hosts.pluginCatalogue, target)
    },
    publisher: publisher,
    generationViews: shared.views.generationViews,
    rawSessionRuntime: shared.views.rawSessionRuntime,
    sessionRuntimeView: shared.views.sessionRuntimeView,
    extensionServices: shared.extensionServices,
    intelligentUi,
    enqueueRuntimeTarget,
    applyRuntimeTarget,
    ordinaryReconciliation,
    pluginTree,
    bindRuntimeSession,
    unbindRuntimeSession,
  }
}
