import { hasChildControl } from '@agnes/core-child-control/child/store'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { SessionLogImpl } from '@agnes/core-ledger/log/session-log'
import type { StorageAdapter } from '@agnes/core-ledger/log/storage'
import { ChildTraceCache } from '@agnes/core-ledger/project/child-trace-cache'
import { exportRlaf, type RlafRange } from '@agnes/core-ledger/project/rlaf'

/** One audited export cut; ordinary appends can continue while the prefix check runs. */
export async function exportVerifiedRlaf(log: SessionLogImpl, range: RlafRange) {
  const upto = log.lastSeq
  await log.fullVerified()
  const events = await scanAll((q) => log.scan(q), { toSeq: upto })
  return exportRlaf(events, range)
}

/** Resolve the evidence fence before tool side effects, without applying it to ordinary tools. */
export async function verifiedToolMeta<T extends { attestsHistory?: boolean }>(
  log: SessionLogImpl,
  meta: T,
): Promise<T> {
  if (meta.attestsHistory) await log.fullVerified()
  return meta
}

/** Resolve the optional child history capability at its storage boundary. */
export function createChildTraceCache(key: string, storage: StorageAdapter): ChildTraceCache | undefined {
  if (!hasChildControl(storage)) return undefined
  return new ChildTraceCache(key, {
    lookup: (childKey) => storage.lookupByKey(childKey),
    scan: (childKey, q) => storage.scan(childKey, q),
  })
}
