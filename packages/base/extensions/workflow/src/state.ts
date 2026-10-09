import type { ChildStatus, ProjectionDef } from '@agnes/extension-api'

export type Member = {
  name: string
  task: string
  status: string
  childKey: string
  /** Child-authored report; never authoritative execution evidence. */
  text: string
  receipt?: NonNullable<ChildStatus['receipt']>
  isolation?: 'shared' | 'worktree'
  worktree?: string
}
export type Stage = { name: string; members: Member[] }
export type Run = {
  id: string
  name: string
  toolUseId: string
  status: string
  error: string
  stages: Stage[]
}
export type State = { runs: Record<string, Run>; views: Record<string, string> }

/** Snapshots are session-ledger data. A missing ending remains interruption evidence. */
export const workflowProjection: ProjectionDef<State> = {
  name: 'runs',
  stateVersion: 1,
  stateSchema: {
    type: 'object',
    required: ['runs', 'views'],
    additionalProperties: false,
    properties: {
      views: { type: 'object', additionalProperties: { type: 'string' } },
      runs: { type: 'object', additionalProperties: { type: 'object' } },
    },
  },
  init: () => ({ runs: {}, views: {} }),
  apply(state, event) {
    if (event.type === 'x/agnes/workflow/view') {
      const data = event.data as { toolUseId: string; runId: string }
      const views = { ...state.views, [data.toolUseId]: data.runId }
      if (Object.keys(views).length > 128) delete views[Object.keys(views)[0]!]
      return { runs: { ...state.runs }, views }
    }
    if (event.type !== 'x/agnes/workflow/run') return state as State
    const run = event.data as Run
    const runs = { ...state.runs, [run.id]: run }
    for (const old of Object.values(runs)) {
      if (new TextEncoder().encode(JSON.stringify(runs)).byteLength < 180000) break
      if (old.id !== run.id && ['completed', 'failed', 'cancelled'].includes(old.status)) delete runs[old.id]
    }
    return { runs, views: { ...state.views } }
  },
}
