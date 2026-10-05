import type * as W from '@agnes/protocol/runtime'

export type ActionView = Readonly<{
  visibility: 'absent' | 'pending' | 'ready'
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown_effect' | null
}>

export type WaitFacts = Readonly<{
  /** Trusted-clock epoch milliseconds, fixed for one evaluation. */
  nowMs: number
  /** actionId by localKey, resolved inside this run's namespace. */
  keys: ReadonlyMap<string, string>
  views: ReadonlyMap<string, ActionView>
  interactions: ReadonlyMap<string, 'pending' | 'terminal'>
  signals: readonly Readonly<{ seq: number; typeId: string; consumed: boolean }>[]
}>

export type WaitVerdict =
  | Readonly<{ satisfied: false }>
  | Readonly<{ satisfied: true; by: 'clause'; clause: number }>
  | Readonly<{ satisfied: true; by: 'deadline' }>

function ready(ref: W.ActionRef, readyWhen: 'receipt' | 'resolved', facts: WaitFacts): boolean {
  const id = 'existingActionId' in ref ? ref.existingActionId : facts.keys.get(ref.localKey)
  if (id === undefined) return false
  const view = facts.views.get(id)
  // A raw receipt, settled attempt or usage never satisfy a wait; only the visibility gate does.
  if (view?.visibility !== 'ready') return false
  return readyWhen === 'receipt' || view.outcome !== 'unknown_effect'
}

function clauseHolds(clause: W.WaitClause, facts: WaitFacts): boolean {
  if (clause.kind === 'actions') {
    const test = (ref: W.ActionRef) => ready(ref, clause.readyWhen, facts)
    return clause.mode === 'any' ? clause.actions.some(test) : clause.actions.every(test)
  }
  if (clause.kind === 'interaction') return facts.interactions.get(clause.interactionId) === 'terminal'
  return facts.signals.some(
    (signal) => !signal.consumed && signal.seq > clause.afterSeq && clause.typeIds.includes(signal.typeId),
  )
}

/** Pure and idempotent: the same facts give the same verdict, so a duplicated wake cannot advance twice. */
export function evaluateWait(condition: W.WaitCondition, facts: WaitFacts): WaitVerdict {
  for (const [index, clause] of condition.anyOf.entries())
    if (clauseHolds(clause, facts)) return { satisfied: true, by: 'clause', clause: index }
  if (condition.deadline !== undefined && Date.parse(condition.deadline) <= facts.nowMs)
    return { satisfied: true, by: 'deadline' }
  return { satisfied: false }
}
