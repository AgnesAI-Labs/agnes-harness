import type {
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PackageSource,
  RuntimePinDescriptor,
} from '@agnes/protocol'
import type { PluginRuntimeState } from '@agnes/web-foundation/client-modules/runtime-status'
import type { RuntimeStateView } from '@agnes/web-ui'
import { AdminApiError } from '../api.js'
import type { AdminError } from '../types.js'

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
