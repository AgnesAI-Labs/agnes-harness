import { type ChildControlStore, hasChildControl } from '@agnes/core-child-control/child/store'
import type { ChildTaskRecord } from '@agnes/core-child-control/child/types'
import type { ChildHandle } from '@agnes/core-effects/effects/tool-context'
import { bestEffort } from '../best-effort.js'
import type { SessionImpl } from '../step/session.js'
import { deliverChildCompletion } from './completion-notice.js'
import { recoverRoleChildren } from './resume-role.js'
import { type ChildRolePort, recordedChildRole } from './roles.js'

/** What the parent is told about a child whose process exited before the child finished. */
export const CHILD_LOST = {
  code: 'E_CHILD_LOST',
  message: 'the process running this child exited before it finished',
} as const

const CANDIDATE = new Set<ChildTaskRecord['state']>([
  'ready',
  'running',
  'waiting_approval',
  'recovery_pending',
  'cancelling',
])

type Settling = Required<Pick<ChildControlStore, 'listLostChildren' | 'settleLostChild'>> & ChildControlStore

/**
 * What a parent run starts with: role recovery reopens role children (giving them a handle), then the
 * children a process that exited left behind are settled. A failure here never stops the run.
 */
export async function recoverChildren(
  parent: SessionImpl,
  roles: ChildRolePort | undefined,
  here: {
    handle: (childKey: string) => boolean
    /** Being opened here, or open anywhere in this kernel: some live owner may still drive it. */
    opening: (childKey: string) => boolean
    resume: (childKey: string) => Promise<ChildHandle>
  },
): Promise<void> {
  await recoverRoleChildren(parent, roles, here.handle, here.resume)
  await settleLostChildren(parent, (key) => here.handle(key) || here.opening(key)).catch(
    bestEffort(parent.d.logger, 'lost-child-settle'),
  )
}

/**
 * Settles this parent's children whose own session holds no live writer lease (see
 * `ChildControlStore.listLostChildren`) and tells the parent the way a finished background child
 * would. Left alone: children with a handle or an opening attempt here, role children (role recovery
 * reopens them) and loop children (the loop adopts them, see `adoptResident`).
 */
async function settleLostChildren(parent: SessionImpl, attached: (childKey: string) => boolean) {
  const store = parent.d.log.storage
  if (!hasChildControl(store) || !store.listLostChildren || !store.settleLostChild) return
  const loopChild = `${parent.key}:${parent.lane}:loop-child-`
  for (const record of await store.listLostChildren(parent.key)) {
    if (
      attached(record.childKey) ||
      record.creationId.startsWith(loopChild) ||
      (await recordedChildRole(parent, record.childKey))
    )
      continue
    const outcome = await settleSubtree(store as Settling, record, attached)
    if (!outcome) continue
    await deliverChildCompletion(
      parent,
      record,
      outcome,
      outcome === 'failed' ? { end: { error: { ...CHILD_LOST } } } : {},
    ).catch(bestEffort(parent.d.logger, 'lost-child-delivery'))
  }
}

/**
 * Settles a lost child after its descendants, which ran in the same process. Each session's lease
 * lapses on its own timer, so while any active descendant still holds one, or is open in this
 * kernel, the whole subtree is left for a later run and the child stays a candidate until then.
 */
async function settleSubtree(
  store: Settling,
  record: ChildTaskRecord,
  attached: (childKey: string) => boolean,
): Promise<'failed' | 'cancelled' | null> {
  for (const descendant of await store.listByParent(record.childKey)) {
    if (descendant.creationPhase !== 'committed' || !CANDIDATE.has(descendant.state)) continue
    if (attached(descendant.childKey) || !(await settleSubtree(store, descendant, attached))) return null
  }
  return store.settleLostChild(record.childKey, record.stateRevision)
}
