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

/**
 * Unconsumed budget reserved by non-terminal direct child scopes under `ancestorScopeId`.
 * Computed live inside the synchronous admission transaction so terminal transitions and
 * cancelled creations release unused capacity automatically without drift or double-counting.
 */
export function unconsumedChildCapMicro(
  scopes: ReadonlyMap<string, BudgetScopeRecord>,
  tasks: ReadonlyMap<SessionKey, ChildTaskRecord>,
  ancestorScopeId: string,
): bigint {
  let reserved = 0n
  for (const scope of scopes.values()) {
    if (scope.parentScopeId !== ancestorScopeId || scope.childKey === null) continue
    const task = tasks.get(scope.childKey)
    if (!task || task.creationPhase === 'cancelled' || isTerminalChildState(task.state)) continue
    const remaining = scope.capMicro - scope.settledMicro - scope.heldMicro
    if (remaining > 0n) reserved += remaining
  }
  return reserved
}

export function checkAncestorBudget(
  scopes: ReadonlyMap<string, BudgetScopeRecord>,
  tasks: ReadonlyMap<SessionKey, ChildTaskRecord>,
  ancestorScopeIds: readonly string[],
  childCapMicro: bigint | null,
): string | null {
  if (childCapMicro !== null && childCapMicro <= 0n) return 'child budget must be positive'
  for (const id of ancestorScopeIds) {
    const scope = scopes.get(id)
    if (!scope) return `unknown ancestor scope ${id}`
    const reserved = unconsumedChildCapMicro(scopes, tasks, scope.scopeId)
    const remaining = scope.capMicro - scope.settledMicro - scope.heldMicro - reserved
    if (childCapMicro !== null) {
      if (childCapMicro > remaining) return 'child budget exceeds remaining ancestor cap'
    } else if (remaining <= 0n) {
      return 'ancestor budget cap is exhausted'
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
