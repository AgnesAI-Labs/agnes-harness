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
  takesSlot: (task: ChildTaskRecord) => boolean = (task) => isActiveChildState(task.state),
): boolean {
  const row = tasks.get(childKey)
  if (!row || row.stateRevision !== expectedRevision || !canTransitionChildState(row.state, next))
    return false
  if (!isActiveChildState(row.state) && isActiveChildState(next) && next !== 'cancelling') {
    if (!admission) return false
    const rows = [...tasks.values()]
    const fan = admitFanOut(
      rows.filter((task) => task.parentKey === row.parentKey && takesSlot(task)).length,
      rows.filter((task) => task.rootTaskId === row.rootTaskId && takesSlot(task)).length,
      admission.maxFanOut,
    )
    if (!fan.ok) throw new CoreError('E_CHILD_LIMIT', fan.message)
  }
  row.state = next
  row.stateRevision += 1
  return true
}

/** Active states that need a live own or owner lease to take a fan-out slot; see `ChildControlStore`. */
const LEASED = new Set<ChildTaskRecord['state']>([
  'running',
  'waiting_approval',
  'recovery_pending',
  'cancelling',
])

/** The fan-out slot rule of `ChildControlStore.createDelegatedChild`, given which writers are live. */
export function takesFanOutSlot(task: ChildTaskRecord, writerLive: (key: SessionKey) => boolean): boolean {
  if (!isActiveChildState(task.state)) return false
  return !LEASED.has(task.state) || writerLive(task.childKey) || writerLive(task.runtimeOwnerSessionKey)
}

/** `ChildControlStore.listLostChildren` over the in-memory rows. */
export function lostMemoryChildren(
  tasks: Map<SessionKey, ChildTaskRecord>,
  parentKey: SessionKey,
  writerLive: (key: SessionKey) => boolean,
): ChildTaskRecord[] {
  return [...tasks.values()].filter(
    (row) =>
      row.parentKey === parentKey &&
      row.creationPhase === 'committed' &&
      (row.state === 'ready' || LEASED.has(row.state)) &&
      !writerLive(row.childKey),
  )
}

/** `ChildControlStore.settleLostChild` over the in-memory rows. */
export function settleMemoryLostChild(
  tasks: Map<SessionKey, ChildTaskRecord>,
  childKey: SessionKey,
  expectedRevision: number,
  writerLive: (key: SessionKey) => boolean,
): 'failed' | 'cancelled' | null {
  const row = tasks.get(childKey)
  if (!row || row.stateRevision !== expectedRevision || row.creationPhase !== 'committed') return null
  if (!(row.state === 'ready' || LEASED.has(row.state)) || writerLive(childKey)) return null
  const next = row.state === 'cancelling' ? ('cancelled' as const) : ('failed' as const)
  row.state = next
  row.stateRevision += 1
  return next
}

/** The optional lost-child pair of `ChildControlStore` and the fan-out slot rule, over the in-memory rows. */
export function lostChildPort(
  tasks: Map<SessionKey, ChildTaskRecord>,
  writerLive: (key: SessionKey) => boolean,
) {
  return {
    listLostChildren: async (parentKey: SessionKey) => lostMemoryChildren(tasks, parentKey, writerLive),
    settleLostChild: async (childKey: SessionKey, expectedRevision: number) =>
      settleMemoryLostChild(tasks, childKey, expectedRevision, writerLive),
    takesSlot: (task: ChildTaskRecord) => takesFanOutSlot(task, writerLive),
  }
}
