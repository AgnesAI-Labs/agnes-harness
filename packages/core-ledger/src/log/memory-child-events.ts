import {
  type AppendChildEventInput,
  type AppendChildEventResult,
  type BudgetScopeRecord,
  type ChildCreationCasInput,
  type ChildEventEnvelope,
  type ChildEventReplayResult,
  type ChildLeaseRecord,
  type ChildTaskRecord,
  isTerminalChildState,
} from '@agnes/core-child-control/child/types'
import { CoreError, type SessionKey } from '@agnes/core-common/types'

export function assertMemoryCreationCas(
  row: ChildTaskRecord | undefined,
  input: ChildCreationCasInput,
  expectedPhase: ChildTaskRecord['creationPhase'],
): asserts row is ChildTaskRecord {
  if (
    !row ||
    row.creationId !== input.creationId ||
    row.attemptId !== input.attemptId ||
    row.creationRevision !== input.expectedRevision ||
    row.creationPhase !== expectedPhase
  )
    throw new CoreError('E_CAS', 'child creation attempt changed', {
      childKey: input.childKey,
      creationId: input.creationId,
      attemptId: input.attemptId,
      expectedRevision: input.expectedRevision,
    })
}

type ChildEventState = {
  events: ChildEventEnvelope[]
  eventIds: Map<string, ChildEventEnvelope>
  highWaterSeq: number
  droppedOutOfOrder: number
}

const MAX_CHILD_EVENTS = 1000
const ONE_CREDIT_MICRO = 1_000_000n

/**
 * Unconsumed budget reserved by non-terminal direct children under `ancestorScopeId`:
 * - Explicit child scopes reserve `max(0, capMicro - settledMicro - heldMicro)` (direct children only,
 *   so multi-generation descendants never double-count at ancestor levels).
 * - Unbounded direct children (sharing `ancestorScopeId`) reserve a lightweight floor unit
 *   `min(1 credit, cap / maxFanOut)` so mixed unbounded + explicit spawns cannot breach the cap.
 */
export function unconsumedChildCapMicro(
  scopes: ReadonlyMap<string, BudgetScopeRecord>,
  tasks: ReadonlyMap<SessionKey, ChildTaskRecord>,
  ancestorScopeId: string,
  ancestorCapMicro: bigint,
  maxFanOut: number,
): bigint {
  let reserved = 0n
  const explicitChildren = new Set<SessionKey>()
  for (const scope of scopes.values()) {
    if (scope.parentScopeId !== ancestorScopeId || scope.childKey === null) continue
    explicitChildren.add(scope.childKey)
    const task = tasks.get(scope.childKey)
    if (!task || task.creationPhase === 'cancelled' || isTerminalChildState(task.state)) continue
    const remaining = scope.capMicro - scope.settledMicro - scope.heldMicro
    if (remaining > 0n) reserved += remaining
  }
  const fanDiv = BigInt(Math.max(1, maxFanOut))
  const perUnboundedFloor =
    ancestorCapMicro / fanDiv < ONE_CREDIT_MICRO ? ancestorCapMicro / fanDiv : ONE_CREDIT_MICRO
  if (perUnboundedFloor > 0n) {
    for (const task of tasks.values()) {
      if (
        task.budgetScopeId !== ancestorScopeId ||
        explicitChildren.has(task.childKey) ||
        task.creationPhase === 'cancelled' ||
        isTerminalChildState(task.state)
      )
        continue
      reserved += perUnboundedFloor
    }
  }
  return reserved
}

export function checkAncestorBudget(
  scopes: ReadonlyMap<string, BudgetScopeRecord>,
  tasks: ReadonlyMap<SessionKey, ChildTaskRecord>,
  ancestorScopeIds: readonly string[],
  childCapMicro: bigint | null,
  maxFanOut: number,
): string | null {
  if (childCapMicro !== null && childCapMicro <= 0n) return 'child budget must be positive'
  const fanDiv = BigInt(Math.max(1, maxFanOut))
  for (const id of ancestorScopeIds) {
    const scope = scopes.get(id)
    if (!scope) return `unknown ancestor scope ${id}`
    const reserved = unconsumedChildCapMicro(scopes, tasks, scope.scopeId, scope.capMicro, maxFanOut)
    const remaining = scope.capMicro - scope.settledMicro - scope.heldMicro - reserved
    if (childCapMicro !== null) {
      if (childCapMicro > remaining) return 'child budget exceeds remaining ancestor cap'
    } else {
      const floor = scope.capMicro / fanDiv < ONE_CREDIT_MICRO ? scope.capMicro / fanDiv : ONE_CREDIT_MICRO
      if (remaining <= 0n || (floor > 0n && remaining < floor)) return 'ancestor budget cap is exhausted'
    }
  }
  return null
}

/** In-memory reference port for durable child event logs and heartbeat leases. */
export function memoryChildEventPort(tasks: ReadonlyMap<SessionKey, ChildTaskRecord>) {
  const streams = new Map<SessionKey, ChildEventState>()
  const leases = new Map<SessionKey, ChildLeaseRecord>()

  const streamOf = (childKey: SessionKey): ChildEventState => {
    let state = streams.get(childKey)
    if (!state) {
      state = { events: [], eventIds: new Map(), highWaterSeq: 0, droppedOutOfOrder: 0 }
      streams.set(childKey, state)
    }
    return state
  }

  return {
    async appendChildEvent(event: AppendChildEventInput): Promise<AppendChildEventResult> {
      const s = streamOf(event.childKey)
      const existing = s.eventIds.get(event.eventId)
      if (existing) {
        return { accepted: false, duplicate: true, envelope: existing }
      }
      if (event.seq !== undefined && (!Number.isSafeInteger(event.seq) || event.seq <= s.highWaterSeq)) {
        s.droppedOutOfOrder += 1
        const rejected: ChildEventEnvelope = Object.freeze({ ...event, seq: event.seq ?? s.highWaterSeq })
        return { accepted: false, outOfOrder: true, envelope: rejected }
      }
      const task = tasks.get(event.childKey)
      if (
        task &&
        isTerminalChildState(task.state) &&
        event.kind === 'status' &&
        event.state !== undefined &&
        !isTerminalChildState(event.state)
      ) {
        const rejected: ChildEventEnvelope = Object.freeze({ ...event, seq: event.seq ?? s.highWaterSeq })
        return { accepted: false, terminalLocked: true, envelope: rejected }
      }
      const seq = event.seq ?? s.highWaterSeq + 1
      const envelope: ChildEventEnvelope = Object.freeze({ ...event, seq })
      s.highWaterSeq = seq
      s.events.push(envelope)
      s.eventIds.set(envelope.eventId, envelope)
      while (s.events.length > MAX_CHILD_EVENTS) {
        const dropIdx = s.events.findIndex((e) => !e.state || !isTerminalChildState(e.state))
        if (dropIdx < 0) break
        const [dropped] = s.events.splice(dropIdx, 1)
        if (dropped) s.eventIds.delete(dropped.eventId)
      }
      return { accepted: true, envelope }
    },

    async scanChildEvents(
      childKey: SessionKey,
      opts?: { afterSeq?: number; limit?: number },
    ): Promise<ChildEventReplayResult> {
      const s = streams.get(childKey)
      if (!s) return { events: [], highWaterSeq: 0, droppedOutOfOrder: 0 }
      const after = opts?.afterSeq ?? 0
      let filtered = s.events.filter((e) => e.seq > after)
      if (opts?.limit !== undefined && opts.limit > 0) filtered = filtered.slice(0, opts.limit)
      return {
        events: filtered,
        highWaterSeq: s.highWaterSeq,
        droppedOutOfOrder: s.droppedOutOfOrder,
      }
    },

    async upsertChildLease(lease: ChildLeaseRecord): Promise<void> {
      const task = tasks.get(lease.childKey)
      leases.set(
        lease.childKey,
        Object.freeze({
          ...lease,
          ...(lease.parentKey ? { parentKey: lease.parentKey } : task ? { parentKey: task.parentKey } : {}),
        }),
      )
    },

    async lookupChildLease(childKey: SessionKey): Promise<ChildLeaseRecord | null> {
      return leases.get(childKey) ?? null
    },

    async listChildLeasesByParent(parentKey: SessionKey): Promise<ChildLeaseRecord[]> {
      const out: ChildLeaseRecord[] = []
      for (const lease of leases.values()) {
        const owner = lease.parentKey ?? tasks.get(lease.childKey)?.parentKey
        if (owner === parentKey) out.push(lease)
      }
      return out
    },
  }
}
