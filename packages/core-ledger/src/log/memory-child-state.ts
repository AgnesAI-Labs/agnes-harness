import { admitFanOut } from '@agnes/core-child-control/child/admission'
import {
  type ChildTaskRecord,
  canTransitionChildState,
  isActiveChildState,
} from '@agnes/core-child-control/child/types'
import { CoreError, type SessionKey } from '@agnes/core-common/types'

/** Synchronous memory transaction: the count and CAS must not yield between observation and update. */
export function transitionMemoryChild(
  tasks: Map<SessionKey, ChildTaskRecord>,
  childKey: SessionKey,
  expectedRevision: number,
  next: ChildTaskRecord['state'],
  admission?: { maxFanOut: number },
): boolean {
  const row = tasks.get(childKey)
  if (!row || row.stateRevision !== expectedRevision || !canTransitionChildState(row.state, next))
    return false
  if (!isActiveChildState(row.state) && isActiveChildState(next) && next !== 'cancelling') {
    if (!admission) return false
    const rows = [...tasks.values()]
    const fan = admitFanOut(
      rows.filter((task) => task.parentKey === row.parentKey && isActiveChildState(task.state)).length,
      rows.filter((task) => task.rootTaskId === row.rootTaskId && isActiveChildState(task.state)).length,
      admission.maxFanOut,
    )
    if (!fan.ok) throw new CoreError('E_CHILD_LIMIT', fan.message)
  }
  row.state = next
  row.stateRevision += 1
  return true
}
