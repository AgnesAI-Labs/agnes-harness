import { CoreError, type SessionKey } from '../types.js'
import type {
  BeginChildAttemptInput,
  BudgetScopeRecord,
  CancelCreatingChildInput,
  CancelledChildFact,
  ChildCreationCasInput,
  ChildTaskRecord,
  CreateDelegatedChildInput,
  CreateDelegatedChildResult,
  DeferCreatingChildInput,
  DeferredChildFact,
  PlannedWorkspace,
  ReleaseRequest,
  ReserveRequest,
  ReserveResult,
  SettleRequest,
  TreeUsage,
} from './types.js'
import { CHILD_CONTROL_FORMAT } from './types.js'

export interface ChildControlStore {
  childControlFormat(): number
  assertWritableFormat(): void
  createDelegatedChild(input: CreateDelegatedChildInput): Promise<CreateDelegatedChildResult>
  lookupByKey(childKey: SessionKey): Promise<ChildTaskRecord | null>
  lookupByCreationId(creationId: string): Promise<ChildTaskRecord | null>
  listByParent(parentKey: SessionKey): Promise<ChildTaskRecord[]>
  listByRoot(rootTaskId: string): Promise<ChildTaskRecord[]>
  listCreatingChildAttempts(): Promise<ChildTaskRecord[]>
  beginChildAttempt(input: BeginChildAttemptInput): Promise<ChildTaskRecord | null>
  deferCreatingChild(input: DeferCreatingChildInput): Promise<DeferredChildFact>
  commitCreatingChild(input: ChildCreationCasInput): Promise<boolean>
  cancelCreatingChild(input: CancelCreatingChildInput): Promise<CancelledChildFact>
  casState(childKey: SessionKey, expectedRevision: number, next: ChildTaskRecord['state']): Promise<boolean>
  nextOrdinal(parentKey: SessionKey, effectId: string): Promise<number>
  existsSession(key: SessionKey): Promise<boolean>
  ensureRootScope(rootTaskId: string, capMicro: bigint): Promise<BudgetScopeRecord>
  scopeForChild(childKey: SessionKey): Promise<BudgetScopeRecord | null>
  reserve(req: ReserveRequest): Promise<ReserveResult>
  settleOrigin(req: SettleRequest): Promise<void>
  releaseReservation(request: string | ReleaseRequest): Promise<void>
  projectTree(rootTaskId: string): Promise<TreeUsage | null>
  workspace(workspaceId: string): Promise<PlannedWorkspace | null>
  updateWorkspace?(
    workspaceId: string,
    patch: Partial<Pick<PlannedWorkspace, 'phase' | 'path' | 'root' | 'branch'>>,
  ): Promise<void>
  lookupWorkspaceByPath?(path: string): Promise<PlannedWorkspace | null>
  bumpWriterGeneration?(key: SessionKey): Promise<number>
  takeoverReservation?(
    permitId: string,
    expectedWriterGeneration: number,
  ): Promise<import('./types.js').ReservationRecord>
  writerGeneration?(key: SessionKey): Promise<number>
  peekReservation?(permitId: string): Promise<import('./types.js').ReservationRecord | null>
  lookupReservationByIdentity?(
    rootTaskId: string,
    effectId: string,
    requestHash: string,
  ): Promise<import('./types.js').ReservationRecord | null>
  clearWriterLease?(key: SessionKey): Promise<void>
}

/** Cancels only stale creating attempts that have neither a durable deferred marker nor a live
 * factory owner. Each cancellation is an exact CAS, so a late recovery scan cannot cancel a newer
 * attach attempt that won after the scan. */
export async function recoverCreatingChildAttempts(
  store: ChildControlStore,
  input: {
    staleBefore: number
    now: number
    liveAttemptIds?: ReadonlySet<string>
  },
): Promise<CancelledChildFact[]> {
  const cancelled: CancelledChildFact[] = []
  for (const row of await store.listCreatingChildAttempts()) {
    if (
      row.creationPhase !== 'creating' ||
      row.deferredFact ||
      row.attemptStartedAt > input.staleBefore ||
      input.liveAttemptIds?.has(row.attemptId)
    )
      continue
    try {
      cancelled.push(
        await store.cancelCreatingChild({
          childKey: row.childKey,
          creationId: row.creationId,
          attemptId: row.attemptId,
          expectedRevision: row.creationRevision,
          reason: 'open_failed',
          cancelledAt: input.now,
        }),
      )
    } catch (error) {
      if (error instanceof CoreError && error.code === 'E_CAS') continue
      throw error
    }
  }
  return cancelled
}

export function hasChildControl(storage: object): storage is ChildControlStore {
  return (
    typeof (storage as ChildControlStore).createDelegatedChild === 'function' &&
    typeof (storage as ChildControlStore).lookupByKey === 'function' &&
    typeof (storage as ChildControlStore).reserve === 'function'
  )
}

export type DurableReservationStore = ChildControlStore &
  Required<
    Pick<
      ChildControlStore,
      'lookupReservationByIdentity' | 'peekReservation' | 'writerGeneration' | 'takeoverReservation'
    >
  >

/** Narrow opt-in: legacy child-control backends remain usable but cannot mint explicit handles. */
export function hasDurableReservations(storage: object): storage is DurableReservationStore {
  return (
    hasChildControl(storage) &&
    typeof storage.lookupReservationByIdentity === 'function' &&
    typeof storage.peekReservation === 'function' &&
    typeof storage.writerGeneration === 'function' &&
    typeof storage.takeoverReservation === 'function'
  )
}

export function requireChildControl(storage: object): ChildControlStore {
  if (!hasChildControl(storage))
    throw new CoreError('E_UNSUPPORTED', 'child control store unavailable on this backend')
  storage.assertWritableFormat()
  if (storage.childControlFormat() > CHILD_CONTROL_FORMAT)
    throw new CoreError(
      'E_FORMAT',
      `child control format ${storage.childControlFormat()} is newer than runtime ${CHILD_CONTROL_FORMAT}`,
    )
  return storage
}

export async function transitionChildState(
  store: ChildControlStore,
  childKey: SessionKey,
  next: ChildTaskRecord['state'],
): Promise<void> {
  const live = await store.lookupByKey(childKey)
  if (!live || live.state === next) return
  if (live.state === 'completed' || live.state === 'failed' || live.state === 'cancelled') return
  await store.casState(childKey, live.stateRevision, next)
}
