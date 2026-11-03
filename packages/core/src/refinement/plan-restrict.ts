import type { RefinementPlan } from '@agnes/core-ledger/reduce/state'

/** Whether a plan still asks for anything: an edit, or a confirmation of a session or workspace entry. */
export const asksForAnything = (plan: RefinementPlan): boolean =>
  plan.edits.length > 0 || plan.confirmations.length > 0 || (plan.workspaceConfirmations?.length ?? 0) > 0

/**
 * The plan without the edits and confirmations on entries in `gone` (`kind/id`), with the baseline and
 * the lapsed ids of the removed edits taken out too: what is left is applied as if it had been the whole
 * plan. Entries saved to the workspace are not session entries and are never in `gone`.
 */
export function withoutEntries(plan: RefinementPlan, gone: ReadonlySet<string>): RefinementPlan {
  if (gone.size === 0) return plan
  const kept = (e: { kind: string; id: string }) => !gone.has(`${e.kind}/${e.id}`)
  const edits = plan.edits.filter(kept)
  const baseline = plan.baseline.filter(kept)
  const lapsed = plan.lapsed?.filter(kept)
  const { lapsed: _lapsed, ...rest } = plan
  return {
    ...rest,
    edits,
    baseline,
    confirmations: plan.confirmations.filter(kept),
    ...(lapsed?.length ? { lapsed } : {}),
  }
}
