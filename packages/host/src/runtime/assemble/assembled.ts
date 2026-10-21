import type { Kernel, PresetView, SeamImplementations, ToolRegistry } from '@agnes/core'
import type { MemorySession, SystemPromptProvider } from '@agnes/extension-api'
import type { ComputerUseArtifactGcRuntime } from '@agnes/host-artifacts/computer-use-artifact-gc'
import type { Permission } from '@agnes/host-common/presets/permission'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import type { CompositionPatch, ResolvedComposition } from '@agnes/host-common/profile/composition'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import type { PublicationDispatch } from '@agnes/host-common/publication-dispatch'
import type { WorkspaceBinding } from '@agnes/host-common/workspace-authority'
import type { HostLockedPackageMutationRuntime } from '@agnes/host-computer-use/computer-use/locked-package-mutation-runtime'
import type { HostComputerUseStatusSource } from '@agnes/host-computer-use/computer-use/status'
import type { DynamicExtension } from '@agnes/host-extensions/assemble/ext-rows'
import type { RuntimeFactory } from '@agnes/host-extensions/assemble/packages'
import type { HostPluginTreeBase } from '@agnes/host-extensions/assemble/seams-cordis'
import type { createExtensionActivationBarrier } from '@agnes/host-extensions/ext-host/activation-barrier'
import type { createManagedExtHost, ExtensionStatus } from '@agnes/host-extensions/ext-host/index'
import type { serviceInvoker } from '@agnes/host-extensions/ext-host/service-invocation'
import type { SkillRuntimeInput } from '@agnes/host-extensions/resources/skills'
import type { SessionWorkspaceRuntime } from '@agnes/host-infrastructure/session-workspace-runtime'
import type { compactionEngineCatalog } from '@agnes/host-providers/assemble/compaction-engines'
import type { modelAdapterCatalog } from '@agnes/host-providers/assemble/model-adapters'
import type { buildProvider } from '@agnes/host-providers/assemble/provider'
import type { EntryRow, RuntimeConvergenceReport, RuntimeTarget } from '@agnes/plugin-runtime/host'
import type { RouteTable } from '@agnes/protocol'
import type { AdapterBundle } from '../adapters/index.js'
import type { ApprovalGrantManagement } from '../approval/grants.js'
import type { Rollback } from '../lifecycle/lifecycle.js'
import type { SessionCapabilitySet } from '../profile/session-capabilities.js'
import type { createIntelligentUiBridge } from '../sessions/intelligent-ui.js'
import type { childAgentCatalog } from './child-agents.js'

/** What `Assembled.extHost` and `Host.extensions()` actually are, named once for both call sites. */
export type ManagedExtHost = ReturnType<typeof createManagedExtHost>

export type {
  HostComputerUseRuntimeStatus,
  HostComputerUseStatusSource,
} from '@agnes/host-computer-use/computer-use/status'
export type OrdinaryReconciliationLifecycle = Readonly<{
  /** Refuses new target applications and settles only after every admitted one finishes. */
  close(): Promise<void>
}>
export type Assembled = {
  referenceLimits?: Partial<import('@agnes/extension-api').ReferenceLimits>
  activationBarrier: ReturnType<typeof createExtensionActivationBarrier>
  approvalGrants: ApprovalGrantManagement
  profileServices: import('@agnes/host-extensions/profile/runtime').ProfileServiceRuntime
  serviceBinding: (names: readonly string[]) => { extension: string; packageId: string } | undefined
  callService: ReturnType<typeof serviceInvoker>['call']
  inspectService: ReturnType<typeof serviceInvoker>['inspect']
  authorizeServiceControl: ReturnType<typeof serviceInvoker>['authorizeControl']
  prepareService: ReturnType<typeof serviceInvoker>['prepare']
  callPreparedService: ReturnType<typeof serviceInvoker>['callPrepared']
  inspectPreparedService: ReturnType<typeof serviceInvoker>['inspectPrepared']
  kernel: Kernel
  memory(workspaceRoot: string, sessionKey: string): MemorySession | undefined
  seams: SeamImplementations
  provider: Awaited<ReturnType<typeof buildProvider>>['provider']
  providerFingerprint: string | null
  applyModelProfile(next: ResolvedProfile): Promise<void>
  routes: RouteTable | undefined
  /** Read-only metadata for installed model adapter factories. */
  modelAdapterCatalog(): ReturnType<typeof modelAdapterCatalog>
  observeSession(key: string): () => void
  observability?: import('@agnes/observability').ObservabilityProvider
  providers: import('@agnes/extension-api').ProvidersCatalogPort
  /** The implementation each seam kind was bound to when this container was built. */
  seamBindings(): readonly import('@agnes/host-providers/assemble/seam-rows').SeamBinding[]
  sessionPresetDefault?(): Promise<string | undefined>
  sessionPermissionDefault?(): Promise<Permission | undefined>
  sessionModelSlots?(): Promise<Pick<import('@agnes/protocol').ModelSlotsSnapshot, 'slots' | 'auto'>>
  sessionLoopDefault?(): Promise<import('@agnes/protocol').LoopSelection | undefined>
  compactionEngineCatalog(): ReturnType<typeof compactionEngineCatalog>
  /** Read-only metadata for installed child agent providers. */
  childAgentCatalog(): ReturnType<typeof childAgentCatalog>
  compositionForPreset(name?: string, session?: CompositionPatch): ResolvedComposition
  sessionCapabilities(sessionKey: string, tools?: ToolRegistry): SessionCapabilitySet
  /** Reviewed bundled API-key routes fitted at assembly, eligible for runtime model switching. */
  preconfiguredRoutes: readonly string[]
  presets: Record<string, PresetDoc>
  retainedModelBootstrap?: boolean
  runtimes: Partial<Record<'python' | 'typescript', RuntimeFactory>>
  adapters: AdapterBundle
  lockedPackageMutations: HostLockedPackageMutationRuntime
  /** Present only after platform-scoped driver install, signature verification and health checks pass. */
  computerUse: HostComputerUseStatusSource | undefined
  /** Native, reachability-checked screenshot collector; absent on unsupported platforms. */
  computerUseArtifactGc: ComputerUseArtifactGcRuntime | undefined
  /** Live C1 ordinary Cordis tree containing preset rows and the eight dynamic runtime seams. */
  intelligentUi: ReturnType<typeof createIntelligentUiBridge>
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
    ceiling?: import('@agnes/core').FsPolicy,
  ): Promise<SessionWorkspaceRuntime>
  /**
   * Cleanly unload and reload an extension row declaring live resources with a fresh resource snapshot, without
   * restarting the worker process. It does not touch
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
        liveResourceRevision?: string
        config?: unknown
        disabled?: boolean
        /** Supply the extension itself, for a row that exists only at runtime (stage 2b, D107′). */
        dynamic?: DynamicExtension
        skillResources?: SkillRuntimeInput | undefined
      }>,
    ): Readonly<EntryRow>
    apply(rows: readonly Readonly<EntryRow>[]): Promise<RuntimeConvergenceReport>
  }>
  /** Refresh every row declaring Skills consumption against a newly bootstrapped resource view. */
  refreshSkillRow(fresh: SkillRuntimeInput | undefined): Promise<void>
  ordinaryReconciliation: OrdinaryReconciliationLifecycle
  ordinaryConvergence(): RuntimeConvergenceReport
  publicationDispatch: PublicationDispatch
  /** The sole Host publication of a complete RuntimeTarget. It shares this assembly's PublicationGate. */
  applyRuntimeTarget(target: RuntimeTarget): Promise<RuntimeConvergenceReport>
  runtimeTargetSnapshot(): RuntimeTarget
  bindRuntimeSession(sessionKey: string, preset: string): Promise<void>
  unbindRuntimeSession(sessionKey: string): Promise<void>
  systemPromptProvider?: (selection?: { id: string; version: string }) => SystemPromptProvider
  sessionPresetLimits(): { limits?: Record<string, number>; park?: unknown }
}
