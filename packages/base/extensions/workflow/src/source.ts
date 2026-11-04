import type { WorkflowRunDefinition, WorkflowRunReader, WorkflowRunSource } from '@agnes/extension-api'
import type { State } from './state.js'

type Obj = Record<string, unknown>
const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * One run record read as the finished definition it stands for: `undefined` when the record is not
 * shaped like a run, `'not-completed'` unless the run and every member of every stage is `completed`.
 */
export function finishedRun(
  runId: string,
  record: unknown,
): WorkflowRunDefinition | 'not-completed' | undefined {
  if (
    !isObj(record) ||
    record.id !== runId ||
    typeof record.name !== 'string' ||
    !Array.isArray(record.stages)
  )
    return undefined
  const stages: { name: string; members: { name: string; task: string }[] }[] = []
  let finished = record.status === 'completed' && record.stages.length > 0
  for (const stage of record.stages) {
    if (!isObj(stage) || typeof stage.name !== 'string' || !Array.isArray(stage.members)) return undefined
    const members: { name: string; task: string }[] = []
    if (stage.members.length === 0) finished = false
    for (const member of stage.members) {
      if (!isObj(member) || typeof member.name !== 'string' || typeof member.task !== 'string')
        return undefined
      if (member.status !== 'completed') finished = false
      members.push({ name: member.name, task: member.task })
    }
    stages.push({ name: stage.name, members })
  }
  return finished ? { runId, name: record.name, stages } : 'not-completed'
}

/** The workflow runs of a session as its `runs` projection records them. */
export const workflowRunSource: WorkflowRunSource = Object.freeze({
  projection: 'runs',
  reader: (state: unknown): WorkflowRunReader => {
    const runs = isObj(state) ? (state as Partial<State>).runs : undefined
    return Object.freeze({
      finished: (runId: string) =>
        isObj(runs) && Object.hasOwn(runs, runId) ? finishedRun(runId, runs[runId]) : undefined,
    })
  },
})
