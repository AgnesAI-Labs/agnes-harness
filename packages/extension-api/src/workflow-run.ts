/**
 * A finished workflow run's definition as the Host reads it to turn the run into a skill: the run's
 * name and, per stage, the names and tasks of its members in order. Nothing the members answered.
 */
export type WorkflowRunDefinition = Readonly<{
  runId: string
  name: string
  stages: readonly Readonly<{
    name: string
    members: readonly Readonly<{ name: string; task: string }>[]
  }>[]
}>

/**
 * A read-only view of one session's workflow runs. `finished` gives a run's definition when the run
 * and every member of every stage completed, `'not-completed'` when the run exists but did not finish
 * that way (still running, failed, cancelled or interrupted), and `undefined` when the session has no
 * such run. Reading it never changes anything and does not throw.
 */
export interface WorkflowRunReader {
  finished(runId: string): WorkflowRunDefinition | 'not-completed' | undefined
}

/**
 * How the plugin that runs workflows offers its run records: its `runs` projection and a reader of
 * that projection's state. The Host folds the projection for one session and asks the reader, so a run
 * of another session is never found; a projection that cannot be read is read as no run. The Host
 * grants offering a source to the plugin that runs workflows only.
 */
export interface WorkflowRunSource {
  /** The projection's name, as the plugin registered it. */
  readonly projection: string
  reader(state: unknown): WorkflowRunReader
}

/** The longest id of a workflow run: the workflow tool's own bound. */
export const MAX_WORKFLOW_RUN_ID = 128

// An id is an identifier, never text: no whitespace or control characters.
const PLAIN_RUN_ID = /^[^\s\p{Cc}]+$/u

/** Whether `value` is well formed as the id of a workflow run. */
export const isWorkflowRunId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= MAX_WORKFLOW_RUN_ID &&
  PLAIN_RUN_ID.test(value)
