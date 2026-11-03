import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import type { SessionImpl } from '../step/session.js'

/** The longest `runId` a skill edit may carry; the workflow tool's own bound. */
export const MAX_WORKFLOW_RUN_ID = 128
/** How long one host read of a run record may take before the run counts as unavailable. */
export const WORKFLOW_RUN_LOOKUP_MS = 5_000

/**
 * A finished workflow run as the host reads it from the session's own record: the definition the run
 * was started with (names and tasks, in order), nothing the members answered.
 */
export type WorkflowRunView = {
  runId: string
  name: string
  stages: { name: string; members: { name: string; task: string }[] }[]
}

/**
 * How the host answers which `workflow` runs of a session may become a skill: `read` gives the run's
 * definition when the run is in that session's own record, completed, with every member completed;
 * `not-found` when the session has no such run (or its record cannot be read now); `not-completed`
 * when the run exists but a stage or member did not finish, or it still runs.
 */
export type RefinementWorkflowRuns = {
  read(
    session: { key: string; lane: string },
    runId: string,
  ): Promise<WorkflowRunView | 'not-found' | 'not-completed'>
}

/** Why an edit that names a workflow run is dropped. */
export type WorkflowRunProblem = 'workflow-run-unavailable' | 'workflow-run-not-completed'

// No whitespace or control characters: a run id is an identifier, never text.
const PLAIN = /^[^\s\p{Cc}]+$/u

/** Whether `value` is well formed as the id of a workflow run. */
export const isWorkflowRunId = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= MAX_WORKFLOW_RUN_ID && PLAIN.test(value)

type Bound = { op: string; kind: HarnessEntry['kind']; id: string; workflowRun?: string }

/** `read`, or `not-found` when it throws or does not answer within the lookup bound. */
async function bounded(
  port: RefinementWorkflowRuns,
  at: { key: string; lane: string },
  runId: string,
): Promise<Awaited<ReturnType<RefinementWorkflowRuns['read']>>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'not-found'>((resolve) => {
    timer = setTimeout(() => resolve('not-found'), WORKFLOW_RUN_LOOKUP_MS)
    ;(timer as { unref?: () => void }).unref?.()
  })
  try {
    const answer = await Promise.race([Promise.resolve().then(() => port.read(at, runId)), late])
    return answer === 'not-completed' || (answer !== null && typeof answer === 'object')
      ? answer
      : 'not-found'
  } catch {
    return 'not-found'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The skill upserts among `edits` that name a workflow run this session cannot turn into a skill now,
 * as `kind/id` with the reason: the run is not in this session's record (or nothing can read it), or it
 * did not finish with every member completed. Each run is read at most once however many edits name it.
 */
export async function unavailableWorkflowRuns(
  s: SessionImpl,
  edits: readonly Bound[],
): Promise<{ key: string; reason: WorkflowRunProblem }[]> {
  const port = s.d.refinement?.workflowRuns
  const at = { key: s.key, lane: s.lane }
  const read = new Map<string, ReturnType<typeof bounded>>()
  const out: { key: string; reason: WorkflowRunProblem }[] = []
  for (const edit of edits) {
    if (edit.op !== 'upsert' || edit.workflowRun === undefined) continue
    const key = `${edit.kind}/${edit.id}`
    if (!port || edit.kind !== 'skill') {
      out.push({ key, reason: 'workflow-run-unavailable' })
      continue
    }
    const pending = read.get(edit.workflowRun) ?? bounded(port, at, edit.workflowRun)
    read.set(edit.workflowRun, pending)
    const found = await pending
    if (found === 'not-found') out.push({ key, reason: 'workflow-run-unavailable' })
    else if (found === 'not-completed') out.push({ key, reason: 'workflow-run-not-completed' })
  }
  return out
}
