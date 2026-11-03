import type { RefinementPlan } from '@agnes/core-ledger/reduce/state'
import type { SessionImpl } from '../step/session.js'
import { unavailableReferences } from './references.js'
import { unavailableWorkflowRuns } from './workflow-runs.js'

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

/**
 * The edits (`kind/id`) that cannot be written now because the skill or role they are bound to cannot
 * be used, or the workflow run they name is gone or did not finish, with the reason a plan left with
 * none of its other edits is refused for: the reference's when one is unusable, else the first run's.
 */
export async function droppedEdits(
  s: SessionImpl,
  edits: RefinementPlan['edits'],
): Promise<{ keys: Set<string>; reason: string }> {
  const references = await unavailableReferences(s, edits)
  const runs = await unavailableWorkflowRuns(s, edits)
  const reason = references.length > 0 ? 'reference-unavailable' : (runs[0]?.reason ?? '')
  return { keys: new Set([...references, ...runs.map((run) => run.key)]), reason }
}
