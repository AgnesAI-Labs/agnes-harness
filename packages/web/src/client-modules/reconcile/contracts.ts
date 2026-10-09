import type { Context } from '@agnes/cordis'
import type { ClientContext, ModuleIdentity } from '@agnes/web-client'
import type {
  PluginRuntimeError,
  PluginRuntimePhase,
  PluginRuntimeState,
} from '@agnes/web-foundation/client-modules/runtime-status'

/** 名册里的 ready 模块（WC3 modules 的最小子集）。 */
export interface ReadyClientModule {
  /** Isolated Intelligent UI renderers; never imported into the workbench document. */
  intelligentComponents?: readonly import('@agnes/protocol/gen/extension-manifest').UiComponentDeclaration[]
  /** Stable lifecycle key for one browser row; omitted only by legacy roster producers. */
  rowId?: string
  packageId: string
  revision: string
  entryUrl: string
  styleUrls: string[]
  slots: string[]
  /** Required for DSH-aligned slots; omitted for the legacy Agnes slot set. */
  slotCatalogVersion?: string
  /** Digest of the daemon-verified immutable snapshot manifest. */
  contentDigest?: string
  extIds: string[]
  services?: string[]
  /** Explicit browser-safe manifest metadata; never a daemon runtime row config. */
  publicConfig?: Readonly<Record<string, unknown>>
}

/** 名册状态项（WC3 statuses 的最小子集）。 */
export interface ClientModuleStatus {
  packageId: string
  installedRevision: string
  backendRevision: string | null
  state: 'ready' | 'pending-activation' | 'blocked'
  reason?: string
}

export interface ClientRoster {
  revision: string
  modules: ReadyClientModule[]
  statuses: ClientModuleStatus[]
  /** Old daemon/browser lifecycle keys mapped to their canonical contribution row. */
  rowAliases?: Readonly<Record<string, string>>
}

/** 名册源契约；P1a 落地后由 SDK 客户端实现。 */
export interface RosterSource {
  list(): Promise<ClientRoster>
}

/** 可注入的模块导入器（测试用 fake 替换；生产是动态 import）。 */
export type ModuleImporter = (url: string) => Promise<unknown>

export type ClientModuleLifecycleStep =
  | 'invalidate'
  | 'prefetch'
  | 'cache-registry-delete'
  | 'drain'
  | 'remove-styles'
  | 'refresh'
  | 'await'

export interface ClientModuleCache {
  delete(entryUrl: string): Promise<void> | void
}

/** Prepared stylesheet set. Preparation fetches without applying; activation is the commit point. */
export interface PreparedClientStyles {
  activate(): void
  dispose(): void
}

export type ClientStylePreparer = (
  target: ReadyClientModule,
  timeoutMs: number,
) => Promise<PreparedClientStyles>

export interface ReconcilerOptions {
  ctx: Context
  source: RosterSource
  /** Locale for user-facing module failure copy; optional, falls back to message keys. */
  locale?: import('@agnes/web-client').LocaleService
  /** Remove registrations owned by one browser row before/after its fiber teardown. */
  removeOwner?: (rowId: string) => void
  importer?: ModuleImporter
  /** Drop an old module namespace from an author/runtime registry before its fiber is drained. */
  moduleCache?: ClientModuleCache
  /** Lifecycle probe used by focused tests and diagnostics; it does not own reconciliation. */
  onLifecycleStep?: (step: ClientModuleLifecycleStep, packageId: string) => Promise<void> | void
  /** Stylesheet preparation is injectable so lifecycle tests do not need a browser network stack. */
  prepareStyles?: ClientStylePreparer
  /** 超时可注入以便测试；毫秒。 */
  timeouts?: { import?: number; styles?: number; apply?: number; dispose?: number }
}

export interface PackageState {
  packageId: string
  revision: string | undefined
  phase: PluginRuntimePhase
  epoch: number
  target: ReadyClientModule | undefined
  active: ReadyClientModule | undefined
  /** Registration owner may remain on a legacy row until its fiber is drained. */
  ownerRowId: string | undefined
  fiber: { dispose(): Promise<void> | void } | undefined
  styles: PreparedClientStyles | undefined
  draining: Promise<void> | undefined
  /** Whether the current roster still contains this package. Used to make revocation one-shot. */
  rosterPresent: boolean
  cleanup: {
    fiber: { dispose(): Promise<void> | void } | undefined
    styles: PreparedClientStyles | undefined
  }
  cleanupPending: boolean
  cleanupQueued: boolean
  failure: PluginRuntimeError | undefined
  chain: Promise<void>
}

export interface ClientReconciler {
  reconcileNow(): Promise<void>
  /** 名册失效提示（WC10 packages_changed 的语义：推送是失效提示，必须重读名册）。 */
  invalidate(): Promise<void>
  /**
   * Reload one snapshot named by the SSE channel.  The hint is never trusted as an asset URL: we
   * first reread the daemon roster, then only apply its matching immutable module row.  A failed
   * reload remains retryable on the next event/invalidation; there is intentionally no blacklist.
   */
  reload(packageId: string, revision: string): Promise<void>
  subscribe(listener: (state: PluginRuntimeState) => void): () => void
  snapshot(): Map<string, PluginRuntimeState>
}

/** 供宿主判断模块身份的类型出口（clientModule config 的形状）。 */
export type ClientModuleConfig = ModuleIdentity & Record<string, unknown>

export type { ClientContext }
