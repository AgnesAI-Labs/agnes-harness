import { hasChildControl, requireChildControl } from '@agnes/core-child-control/child/store'
import { isTerminalChildState } from '@agnes/core-child-control/child/types'
import { CoreError } from '@agnes/core-common/types'
import type { ChildControlStore, ChildTaskRecord } from '@agnes/extension-api'
import type { SessionImpl } from '../step/session.js'

/** A stopped creation cannot be readmitted by reopening its session or retaining its inbox. */
async function cancelAdmission(store: ChildControlStore, record: ChildTaskRecord): Promise<void> {
  let live: ChildTaskRecord | null = record
  while (live && !isTerminalChildState(live.state)) {
    if (await store.casState(live.childKey, live.stateRevision, 'cancelled')) return
    const next = await store.lookupByKey(live.childKey)
    if (next && !isTerminalChildState(next.state) && next.stateRevision === live.stateRevision)
      throw new CoreError('E_CAS', 'Child lifecycle cancellation did not commit')
    live = next
  }
}

/** Explicit lifecycle stops cover durable admissions, even children never opened in this process. */
export async function stopChildAdmissions(session: SessionImpl): Promise<void> {
  const store = session.d.log.storage
  if (!hasChildControl(store)) return
  requireChildControl(store)
  const pending = [session.key]
  const seen = new Set<string>()
  while (pending.length) {
    const parent = pending.pop()
    if (parent === undefined) break
    if (seen.has(parent)) throw new CoreError('E_RELATION', 'Cyclic child admission ancestry')
    seen.add(parent)
    for (const child of await store.listByParent(parent)) {
      // Terminal ancestors may still have admitted descendants; do not prune that subtree.
      pending.push(child.childKey)
      await cancelAdmission(store, child)
    }
  }
}
