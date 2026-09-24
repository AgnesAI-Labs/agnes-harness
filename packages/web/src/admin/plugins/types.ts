import type {
  PackageAdminContext,
  PackageAdminError,
  PackageAdminPermission,
  PackageBlocker,
  PackageCatalogDescriptor,
  PackageCatalogPage,
  PackageInstalledDescriptor,
  PackageListResult,
  PackageOperation,
  PackageOperationReceipt,
  PackagePreview,
  PackageSource,
  PluginTreeView,
} from '@agnes/protocol'
import type { PluginRuntimeState } from '../../client-modules/runtime-status.js'

export type AdminContext = Readonly<
  Omit<PackageAdminContext, 'permissions' | 'features'> & {
    permissions: readonly PackageAdminPermission[]
    features?: readonly string[]
  }
>

export const ADMIN_FEATURES = Object.freeze({
  compositeActivation: 'packages.composite-activation.v1',
  runtimeIdentity: 'packages.runtime-identity.v1',
  rollbackTarget: 'packages.rollback-target.v1',
  operationControl: 'packages.operation-control.v1',
} as const)
export type AdminFeature = (typeof ADMIN_FEATURES)[keyof typeof ADMIN_FEATURES]

export function hasFeature(context: AdminContext | undefined, feature: AdminFeature): boolean {
  return !!context?.features?.includes(feature)
}

export type PluginRuntimeSource = Readonly<{
  snapshot(): ReadonlyMap<string, PluginRuntimeState>
  subscribe(listener: (state: PluginRuntimeState) => void): () => void
  reconcileNow(): Promise<void>
  invalidate(): Promise<void>
}>

export type AdminError = Readonly<{
  code: string
  message: string
  blockers?: readonly PackageBlocker[] | undefined
}>

export type AdminPageState = {
  context?: AdminContext | undefined
  installed: readonly PackageInstalledDescriptor[]
  surfaceLinks: readonly AdminSurfaceLink[]
  catalog: readonly PackageCatalogDescriptor[]
  nextCursor: string | null
  selectedId?: string | undefined
  selectedCatalog?: PackageCatalogDescriptor | undefined
  preview?: PackagePreview | undefined
  previewMode?: 'install' | 'update' | undefined
  operations: ReadonlyMap<string, PackageOperation>
  /** Browser-only module truth; backend desired/actual remain authoritative separately. */
  runtime: ReadonlyMap<string, PluginRuntimeState>
  /** True only after the current page successfully read the installed inventory. */
  inventoryAuthoritative: boolean
  /** The last terminal DTO is retained only for an honest completion notice. */
  lastOperation?: PackageOperation | undefined
  error?: AdminError | undefined
  loading: boolean
  connection: 'loading' | 'connected' | 'offline' | 'forbidden'
  /** Qualified tree actual from plugins.tree.list; diagnostics never stand in for actual. */
  tree?: PluginTreeView | undefined
}

export type AdminSurfaceLink = Readonly<{
  packageId: string
  surfaceId: string
  mount: string
}>

export type AdminSurfaceLinksResult = Readonly<{ surfaces: readonly AdminSurfaceLink[] }>

export type {
  PackageAdminError,
  PackageAdminPermission,
  PackageCatalogPage,
  PackageListResult,
  PackageOperationReceipt,
  PackageSource,
  PluginTreeView,
}
