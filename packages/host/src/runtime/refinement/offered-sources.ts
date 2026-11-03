import type { Kernel, ProjectionRegistry, RefinementWorkflowRuns, SessionImpl, TaskScope } from '@agnes/core'
import { scanAll } from '@agnes/core'
import type { TaskScopeSource } from '@agnes/extension-api'
import type { WorkflowRunSource } from '@agnes/host-extensions/assemble/packages'
import type { JsonValue } from '@agnes/protocol'
import { createWorkflowRuns } from './workflow-runs.js'

type ProjectedSession = Pick<SessionImpl, 'key' | 'lastSeq' | 'scan' | 'diag'>

/**
 * One projection's state for a session as of its last committed row, folded the way an extension's
 * own read folds it: only the rows after the registry's cached line when that line still stands,
 * else every row. Undefined when the projection is not registered or cannot be folded; a fold that
 * fails is recorded as a `projection-failed` diagnostic, as an extension's own read records it.
 */
export async function readProjection(
  registry: ProjectionRegistry,
  session: ProjectedSession,
  key: string,
): Promise<JsonValue | undefined> {
  const asOfSeq = session.lastSeq
  const scan = (fromSeq?: number) =>
    scanAll((q) => session.scan(q), { ...(fromSeq === undefined ? {} : { fromSeq }), toSeq: asOfSeq })
  const failures = registry.failures().length
  const after = registry.cacheLine(session.key, key)?.seq
  const resumed =
    after === undefined
      ? undefined
      : registry.snapshotOneAfter(
          session.key,
          key,
          after,
          after < asOfSeq ? await scan(after + 1) : [],
          asOfSeq,
        )
  const unit = resumed ?? registry.snapshotOne(session.key, key, await scan(), asOfSeq)
  if (registry.failures().length > failures) await session.diag('projection-failed', { key, asOfSeq })
  return 'error' in unit ? undefined : (unit.state as JsonValue)
}

/**
 * What the plugins that own a session's task and its workflow runs offer, and Core's reads of them.
 * Each offer is one of the plugin's projections and a reader of its state, under the registry key
 * `<owner>/<projection>`; the host folds that projection for the one session asked about. Nothing is
 * read until a plugin has offered, and a withdrawn offer reads as nothing.
 */
export function offeredSources(o: {
  kernel(): Pick<Kernel, 'projections'> | undefined
  session(key: string, lane: string): SessionImpl | undefined
}) {
  let tasks: { key: string; source: TaskScopeSource } | undefined
  let runs: { key: string; source: WorkflowRunSource } | undefined
  const fold = async (at: { key: string; lane: string }, offered: { key: string } | undefined) => {
    const session = o.session(at.key, at.lane)
    const kernel = o.kernel()
    if (!offered || !session || !kernel) return undefined
    return readProjection(kernel.projections, session, offered.key)
  }
  const workflowRuns: RefinementWorkflowRuns = createWorkflowRuns({
    state: async (at) => {
      const offered = runs
      const state = offered && (await fold(at, offered))
      return offered && state !== undefined ? { source: offered.source, state } : undefined
    },
  })
  // A session's current task: the offering plugin's projection, folded for the session, as its reader
  // reports it (null: no goal). Undefined when it cannot be read now: nothing offered (the plugin is
  // off or being reloaded), the session is not open here, or the projection cannot be folded.
  const taskScope = async (at: { key: string; lane: string }): Promise<TaskScope | null | undefined> => {
    const offered = tasks
    const state = await fold(at, offered)
    return offered === undefined || state === undefined ? undefined : offered.source.reader(state).current()
  }
  return {
    taskScope,
    workflowRuns,
    /** The plugin that owns tasks offers its task scope; the returned function withdraws the offer. */
    provideTaskScope(owner: string, source: TaskScopeSource): () => void {
      const offered = { key: `${owner}/${source.projection}`, source }
      tasks = offered
      return () => {
        if (tasks === offered) tasks = undefined
      }
    },
    /** The plugin that runs workflows offers its run records; the returned function withdraws the offer. */
    provideWorkflowRuns(owner: string, source: WorkflowRunSource): () => void {
      const offered = { key: `${owner}/${source.projection}`, source }
      runs = offered
      return () => {
        if (runs === offered) runs = undefined
      }
    },
  }
}
