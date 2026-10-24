import { requireChildControl } from '@agnes/core-child-control/child/store'
import type { ChildTaskRecord } from '@agnes/core-child-control/child/types'
import { CoreError } from '@agnes/core-common/types'
import { bestEffort } from '../best-effort.js'
import type { SessionImpl } from '../step/session.js'

/** Preserve the failed-attach hook without delivering completion into a parent's pending gate. */
export async function reportFailedCreation(
  parent: SessionImpl,
  childKey: string,
  credits: number,
): Promise<void> {
  const available = () => !parent.d.log.faulted && !parent.closingOrClosed
  if (!available()) return
  const record = await requireChildControl(parent.d.log.storage).lookupByKey(childKey)
  if (!available()) return
  await parent.hooks
    .subagentEnd?.({
      childKey,
      outcome: record?.state === 'cancelled' ? 'cancelled' : 'failed',
      credits: Math.max(0, credits),
    })
    .catch(bestEffort(parent.d.logger, 'failed-child-end-hook'))
}

export async function cancelOpenAttempt(
  store: ReturnType<typeof requireChildControl>,
  parent: SessionImpl,
  attempt: ChildTaskRecord,
): Promise<void> {
  let failure: unknown
  for (let tries = 0; tries < 3; tries += 1) {
    try {
      await store.cancelCreatingChild({
        childKey: attempt.childKey,
        creationId: attempt.creationId,
        attemptId: attempt.attemptId,
        expectedRevision: attempt.creationRevision,
        reason: 'open_failed',
        cancelledAt: parent.d.clock(),
      })
      return
    } catch (error) {
      if (error instanceof CoreError && error.code === 'E_CAS') throw error
      failure = error
    }
  }
  throw new CoreError('E_STORAGE_FAULT', 'failed to persist child open cancellation', {
    childKey: attempt.childKey,
    attemptId: attempt.attemptId,
    cause: failure instanceof Error ? failure.message : String(failure),
  })
}
