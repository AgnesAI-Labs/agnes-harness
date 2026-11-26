import { projectChildStatus } from '@agnes/core-child-control/child/status-projection'
import { type ChildControlStore, hasChildControl } from '@agnes/core-child-control/child/store'
import { type ChildTaskRecord, isTerminalChildState } from '@agnes/core-child-control/child/types'
import type { ChildHandle } from '@agnes/core-effects/effects/tool-context'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import { bestEffort } from '../best-effort.js'
import type { SessionImpl } from '../step/session.js'
import { deliverChildCompletion, recoverChildCompletions } from './completion-notice.js'
import { protectChildLeases } from './heartbeat.js'
import { canSettleColdCancelling, hasLivePendingPause } from './pause-control.js'
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
  const store = parent.d.log.storage
  const parentRows = hasChildControl(store) ? await store.listByParent(parent.key).catch(() => []) : []
  const liveBefore = new Set(
    parentRows.map((row) => row.childKey).filter((key) => here.handle(key) || here.opening(key)),
  )
  await recoverRoleChildren(parent, roles, here.handle, here.resume)
  await recoverChildCompletions(parent, (key) => liveBefore.has(key), parentRows).catch(
    bestEffort(parent.d.logger, 'child-completion-recovery'),
  )
  const lostKeys = new Set(
    hasChildControl(store) && store.listLostChildren
      ? (await store.listLostChildren(parent.key).catch(() => [])).map((row) => row.childKey)
      : [],
  )
  const leased = await protectChildLeases(parent, (key) => here.handle(key) || here.opening(key))
  await settleLostChildren(
    parent,
    (key) => here.handle(key) || here.opening(key) || (!lostKeys.has(key) && leased(key)),
  ).catch(bestEffort(parent.d.logger, 'lost-child-settle'))
  await reconcilePendingPauseAdmissions(parent).catch(
    bestEffort(parent.d.logger, 'child-pause-admission-reconcile'),
  )
}

const SETTLED_PAUSE_OUTCOMES = new Set(['applied', 'withdrawn', 'refused', 'uncertain'])

/**
 * Reconciles `child-pause` admissions that remained `queued` when the parent closed or crashed before
 * the child's safe-point drain settled, appending one idempotent terminal fact per `admissionId`.
 */
async function reconcilePendingPauseAdmissions(parent: SessionImpl): Promise<void> {
  if (parent.closingOrClosed) return
  const store = parent.d.log.storage
  if (!hasChildControl(store)) return
  type QueuedPause = {
    admissionId: string
    childId: string
    actor: SessionImpl['d']['actor']
    seq: number
  }
  const queued = new Map<string, QueuedPause>()
  const settled = new Set<string>()
  const latestAppliedByChild = new Map<string, number>()
  for await (const rows of scanPages((query) => parent.scan(query), {
    type: 'x/core/control',
    lane: parent.lane,
    toSeq: parent.lastSeq,
  })) {
    for (const row of rows) {
      if (row.trust !== 'trusted') continue
      const data = row.data as {
        action?: string
        outcome?: string
        admissionId?: string
        childId?: string
      }
      if (data.action !== 'child-pause' || typeof data.admissionId !== 'string' || !data.admissionId) continue
      if (data.outcome === 'queued' && typeof data.childId === 'string' && data.childId) {
        queued.set(data.admissionId, {
          admissionId: data.admissionId,
          childId: data.childId,
          actor: row.actor,
          seq: row.seq,
        })
      } else if (typeof data.outcome === 'string' && SETTLED_PAUSE_OUTCOMES.has(data.outcome)) {
        settled.add(data.admissionId)
        if (data.outcome === 'applied' && typeof data.childId === 'string' && data.childId)
          latestAppliedByChild.set(data.childId, row.seq)
      }
    }
  }
  const unresolved = [...queued.values()].filter((entry) => !settled.has(entry.admissionId))
  if (unresolved.length === 0) return
  const tailFrom = Math.min(...unresolved.map((entry) => entry.seq)) + 1
  await parent.locked(async () => {
    if (parent.closingOrClosed) return
    const nowSettled = new Set<string>()
    for await (const rows of scanPages((query) => parent.scan(query), {
      type: 'x/core/control',
      lane: parent.lane,
      fromSeq: tailFrom,
      toSeq: parent.lastSeq,
    })) {
      for (const row of rows) {
        if (row.trust !== 'trusted') continue
        const data = row.data as { action?: string; outcome?: string; admissionId?: string }
        if (
          data.action === 'child-pause' &&
          typeof data.admissionId === 'string' &&
          typeof data.outcome === 'string' &&
          SETTLED_PAUSE_OUTCOMES.has(data.outcome)
        )
          nowSettled.add(data.admissionId)
      }
    }
    const events = []
    for (const entry of unresolved) {
      if (nowSettled.has(entry.admissionId) || hasLivePendingPause(entry.childId)) continue
      const record = await store.lookupByKey(entry.childId)
      const outcome: 'applied' | 'withdrawn' | 'uncertain' =
        !record || isTerminalChildState(record.state)
          ? 'withdrawn'
          : record.state === 'paused' && (latestAppliedByChild.get(entry.childId) ?? 0) < entry.seq
            ? 'applied'
            : 'uncertain'
      const reason =
        outcome === 'withdrawn'
          ? 'CHILD_TERMINATED_BEFORE_PAUSE'
          : outcome === 'uncertain'
            ? 'PAUSE_UNSETTLED_ON_RECOVERY'
            : undefined
      events.push(
        parent.controls.fact('child-pause', outcome, entry.actor, {
          admissionId: entry.admissionId,
          childId: entry.childId,
          ...(record ? { executionState: record.state } : {}),
          ...(reason ? { reason } : {}),
        }),
        parent.ev(
          'x/core/child-control-result',
          {
            action: 'pause',
            admissionId: entry.admissionId,
            childKey: entry.childId,
            status: record ? projectChildStatus(record).status : 'cancelled',
            executionState: record?.state ?? 'cancelled',
            ...(outcome === 'applied' ? {} : { failed: true, ...(reason ? { reason } : {}) }),
          },
          { actor: entry.actor, ignorable: true },
        ),
      )
    }
    if (events.length > 0) await parent.d.log.append(events)
  })
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
    const outcome = await settleSubtree(parent, store as Settling, record, attached)
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
  parent: SessionImpl,
  store: Settling,
  record: ChildTaskRecord,
  attached: (childKey: string) => boolean,
): Promise<'failed' | 'cancelled' | null> {
  if (record.state === 'cancelling' && !(await canSettleColdCancelling(parent, record))) return null
  for (const descendant of await store.listByParent(record.childKey)) {
    if (descendant.creationPhase !== 'committed' || !CANDIDATE.has(descendant.state)) continue
    if (attached(descendant.childKey) || !(await settleSubtree(parent, store, descendant, attached)))
      return null
  }
  return store.settleLostChild(record.childKey, record.stateRevision)
}
