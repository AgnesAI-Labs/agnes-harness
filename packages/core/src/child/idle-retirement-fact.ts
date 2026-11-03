import { requireChildControl } from '@agnes/core-child-control/child/store'
import type { ChildTaskRecord } from '@agnes/core-child-control/child/types'
import type { SessionImpl } from '../step/session.js'

export const IDLE_RETIRED = 'x/core/child-idle-retired'

/** A pre-CAS intent becomes authoritative only at its exact completed state revision. */
export async function retiredCompletionIdentity(
  parent: SessionImpl,
  record: ChildTaskRecord,
  resultSeq: number,
): Promise<string | undefined> {
  const live = await requireChildControl(parent.d.log.storage).lookupByKey(record.childKey)
  if (live?.state !== 'completed') return
  const rows = await parent.d.log.storage.scan(record.childKey, {
    type: IDLE_RETIRED,
    fromSeq: record.boundarySeq + 1,
    order: 'desc',
    limit: 1,
  })
  const row = rows[0]
  const fact = row?.data as { stateRevision?: number; resultSeq?: number; completionId?: string } | undefined
  if (
    row?.origin === 'system' &&
    row.trust === 'trusted' &&
    fact?.stateRevision === live.stateRevision &&
    fact.resultSeq === resultSeq &&
    typeof fact.completionId === 'string'
  )
    return fact.completionId
}
