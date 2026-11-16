import type { OwnedStore } from '@agnes/extension-api'
import { configurationRevision, type JsonValue, type ProfileServiceReceipt, rpcError } from '@agnes/protocol'

/** Receipt code of a managed configuration refused because the stored revision moved; nothing was written. */
export const REVISION_CONFLICT = 'REVISION_CONFLICT'

// Only conflicts raised here mean "not written": a plugin cannot mint one to hide an unknown outcome.
const conflicts = new WeakSet<object>()
export function configurationConflict() {
  const error = rpcError('SEMANTIC_REJECTED', { code: REVISION_CONFLICT })
  conflicts.add(error)
  return error
}
export const isConfigurationConflict = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && conflicts.has(error)
export const conflictReceipt = (operationId: string): ProfileServiceReceipt => ({
  state: 'refused',
  operationId,
  code: REVISION_CONFLICT,
})

/**
 * Writes a managed configuration. With an expected revision, the stored value is compared inside the
 * same storage transaction that writes it, so a concurrent writer can never be overwritten.
 */
export function writeManagedConfiguration(
  store: OwnedStore,
  key: string,
  fallback: JsonValue,
  config: JsonValue,
  expected?: string,
): void {
  if (expected === undefined) {
    store.set(key, config)
    return
  }
  store.transaction(() => {
    if (configurationRevision(store.get(key) ?? fallback) !== expected) throw configurationConflict()
    store.set(key, config)
  })
}
