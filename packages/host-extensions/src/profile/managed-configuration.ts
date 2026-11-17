import type { OwnedStore } from '@agnes/extension-api'
import {
  configurationRevision,
  type DecisionHandle,
  type JsonValue,
  type ProfileServiceReceipt,
  rpcError,
} from '@agnes/protocol'
import type { ProfileJournal, ProfileOperation } from './journal.js'

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

/** The revision a managed configuration operation was reviewed against, when its caller stated one. */
function boundRevision(row: ProfileOperation): string | undefined {
  const prepared = row.prepared as { resourceRevision?: unknown } | null
  return typeof prepared?.resourceRevision === 'string' ? prepared.resourceRevision : undefined
}

/**
 * Ends `row` when it waits for review but its stored configuration revision moved: such an operation can
 * never write. Its pending decision is withdrawn first, which notifies the principal; then the no-write
 * refusal becomes the journaled receipt. Returns undefined when `row` is not such an operation.
 */
export async function settleStaleConfiguration(
  log: ProfileJournal,
  managed: { configurationRevision(owner: string, service: string): string | undefined } | undefined,
  row: ProfileOperation,
  withdraw: (handle: DecisionHandle) => Promise<unknown>,
  alive: () => void,
): Promise<ProfileServiceReceipt | undefined> {
  const bound = boundRevision(row)
  const stored = managed?.configurationRevision(row.owner, row.service)
  if (
    row.receipt.state !== 'approval-required' ||
    bound === undefined ||
    stored === undefined ||
    stored === bound
  )
    return undefined
  return refuseStale(log, row, withdraw, alive)
}

/** Journals the no-write refusal of `row`, after withdrawing its pending decision outside the journal lock. */
export async function refuseStale(
  log: ProfileJournal,
  row: ProfileOperation,
  withdraw: (handle: DecisionHandle) => Promise<unknown>,
  alive: () => void,
): Promise<ProfileServiceReceipt> {
  const decision = (log.operations.get(row.key) ?? row).receipt.decision
  if (decision) await withdraw(decision)
  return log.locked(async () => {
    alive()
    const current = log.operations.get(row.key)
    if (current && current.receipt.state !== 'approval-required') return structuredClone(current.receipt)
    const receipt = conflictReceipt(row.receipt.operationId)
    await log.write({ ...(current ?? row), receipt }, [], alive)
    return receipt
  })
}

/**
 * The revision a call stated for a managed configuration. Only Host-managed `<id>.configure` effects
 * accept one. The result tells whether the stored configuration has moved away from it since.
 */
export function configurationPrecondition(
  managed: { configurationRevision(owner: string, service: string): string | undefined } | undefined,
  owner: string,
  service: string,
  expected: string | undefined,
): () => boolean {
  if (expected === undefined) return () => false
  if (managed?.configurationRevision(owner, service) === undefined) throw rpcError('INVALID_PARAMS')
  return () => managed.configurationRevision(owner, service) !== expected
}

/** Withdraws the decision of an operation whose configuration moved since review. */
export const withdrawStale =
  <S>(
    decisions: { withdraw(handle: DecisionHandle, source: S, code: string): Promise<unknown> },
    source: S,
  ) =>
  (handle: DecisionHandle) =>
    decisions.withdraw(handle, source, 'configuration-changed')

/** The receipt of a failed effect: only the Host's own compare-and-set refusal proves nothing was written. */
export function failedEffectReceipt(
  error: unknown,
  stated: boolean,
  operationId: string,
  log: (error: unknown) => void,
): ProfileServiceReceipt {
  if (stated && isConfigurationConflict(error)) return conflictReceipt(operationId)
  log(error)
  return { state: 'unknown', operationId, code: 'OUTCOME_UNKNOWN' }
}
