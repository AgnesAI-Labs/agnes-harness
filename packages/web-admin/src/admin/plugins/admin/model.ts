import type {
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PackageSource,
  RuntimePinDescriptor,
} from '@agnes/protocol'
import type { PluginRuntimeState } from '@agnes/web-foundation/client-modules/runtime-status'
import { type DetailActionSpec, isBundledPlugin, type RuntimeStateView } from '@agnes/web-ui'
import { AdminApiError, type PluginAdminApi } from '../api.js'
import type { AdminError } from '../types.js'
import type { PluginAdminPage } from './page.js'

export function safeMessage(error: unknown): AdminError {
  if (error instanceof AdminApiError) return error.details
  return {
    code: 'ADMIN_UNAVAILABLE',
    message: 'Could not connect to the plugin admin service. The current page content has been kept.',
  }
}

export function hasClientContribution(item: PackageInstalledDescriptor): boolean {
  return item.contributions.some(
    (contribution) =>
      (contribution.kind === 'client' && 'client' in contribution) ||
      (contribution.kind === 'extension' && contribution.client !== undefined),
  )
}

export function isClientOnly(item: PackageInstalledDescriptor): boolean {
  return (
    item.contributions.length > 0 &&
    item.contributions.every(
      (contribution) =>
        contribution.kind === 'extension' &&
        contribution.client !== undefined &&
        Object.keys(contribution.capabilities ?? {}).every((capability) => capability === 'ui'),
    )
  )
}

export function sourceForCatalog(item: PackageCatalogDescriptor): PackageSource {
  return item.source
}

export function pinPurposeLabel(
  purpose: RuntimePinDescriptor['purpose'],
  t: (key: string) => string,
): string {
  const key: Record<RuntimePinDescriptor['purpose'], string> = {
    active: 'pin.active',
    candidate: 'pin.candidate',
    recovery: 'pin.recovery',
    rollback: 'pin.rollback',
    turn: 'pin.turn',
  }
  return t(key[purpose])
}

export function asRuntimeView(state: PluginRuntimeState | undefined): RuntimeStateView | undefined {
  return state
}

/** A release update is identified by its reserved source and bytes, even if versions coincide. */
export function bundledUpdate(
  installed: PackageInstalledDescriptor,
  catalog: readonly PackageCatalogDescriptor[],
): PackageCatalogDescriptor | undefined {
  const example =
    installed.presentation?.origin === 'example' &&
    installed.source.type === 'file' &&
    installed.source.ref.startsWith('file:./bundled-examples/')
  if (!isBundledPlugin(installed) && !example) return undefined
  return catalog.find(
    (entry) =>
      entry.id === installed.id &&
      entry.sourceId === (example ? 'official-examples' : 'builtin-plugins') &&
      entry.source.type === installed.source.type &&
      entry.source.ref === installed.source.ref &&
      entry.integrity !== installed.integrity,
  )
}

/** Built-in update discovery is independent of the marketplace's search and pagination state. */
export async function readBundledCatalog(api: PluginAdminApi): Promise<PackageCatalogDescriptor[]> {
  const entries: PackageCatalogDescriptor[] = []
  let cursor: string | undefined
  do {
    const page = await api.catalog('', cursor)
    entries.push(
      ...page.items.filter((item) => ['builtin-plugins', 'official-examples'].includes(item.sourceId)),
    )
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return entries
}

export function bundledUpdateAction(
  page: PluginAdminPage,
  current: PackageInstalledDescriptor,
  candidate: PackageCatalogDescriptor,
): DetailActionSpec {
  const view = page.viewContext()
  return {
    label: view.t('action.review-bundled-update', { from: current.version, to: candidate.version }),
    group: 'versions',
    className: '',
    disabled:
      !view.canEffect('packages.install') || view.packageBusy(current.id) || view.inspecting(current.id),
    onClick: () => void view.inspectCatalog(candidate),
  }
}

export function canCombineUpdate(
  page: PluginAdminPage,
  item: PackageInstalledDescriptor,
  preview: import('@agnes/protocol').PackagePreview,
): boolean {
  return (
    page.supportsCompositeActivation() &&
    page.activeIntegrity(item) !== undefined &&
    !!preview.capabilityHash &&
    page.can('packages.install') &&
    page.can('packages.trust') &&
    page.can('packages.activate')
  )
}
