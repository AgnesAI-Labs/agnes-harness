import { createUsageLedgerConsumer } from '../runtime/usage-ledger/consumer.js'
import type { UsageLedgerOwners } from '../runtime/usage-ledger/ports.js'

/** Host-only assembly slot. Owners are supplied by the selected runtime installation/session. */
export function assembleRuntimeUsageLedger(path: string, owners: UsageLedgerOwners = {}) {
  return createUsageLedgerConsumer(path, owners)
}
export type { UsageLedgerOwners }
