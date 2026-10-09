import {
  DSH_SLOT_CATALOG_VERSION,
  getDshSlotDefinition,
  isPublicDshSlot,
  isRuntimeSupportedDshSlot,
} from '@agnes/web-client'
import { type ReadyClientModule } from './contracts.js'

export function rowKey(module: Pick<ReadyClientModule, 'packageId' | 'rowId'>): string {
  return module.rowId ?? module.packageId
}

export function validateCatalogContract(target: ReadyClientModule): string | undefined {
  const dshSlots = target.slots.filter((slot) => getDshSlotDefinition(slot) !== undefined)
  if (dshSlots.length === 0) return undefined
  if (target.slotCatalogVersion !== DSH_SLOT_CATALOG_VERSION)
    return `slot catalog version is not supported: ${target.slotCatalogVersion ?? 'missing'}`
  const hostOnly = dshSlots.find((slot) => !isPublicDshSlot(slot))
  if (hostOnly !== undefined) return `host-only slot cannot be contributed: ${hostOnly}`
  const unsupported = dshSlots.find((slot) => !isRuntimeSupportedDshSlot(slot))
  if (unsupported !== undefined) return `slot is not mounted by the current host: ${unsupported}`
  return undefined
}
