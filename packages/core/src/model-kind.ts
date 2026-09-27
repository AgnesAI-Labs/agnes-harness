import type { DecisionSlot } from '@agnes/protocol'

/** The one route-table key that names a decision model rather than a chat model. */
export const DECISION_SLOT: DecisionSlot = 'decision'

/** A catalogue record for a decision model. Chat records carry no `kind`. */
export function isDecisionModel(record: object): boolean {
  return (record as { kind?: unknown }).kind === 'decision'
}
