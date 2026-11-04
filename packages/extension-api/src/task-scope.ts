import type { JsonValue } from '@agnes/protocol'

/** Where a session's current task stands. */
export type TaskScopePhase = 'active' | 'paused' | 'blocked' | 'complete'

/**
 * A session's current task as the plugin that owns tasks sees it: an id that stays the same for the
 * life of the task, a revision that moves with every change to it, and its phase.
 */
export type TaskScope = Readonly<{ id: string; revision: number; phase: TaskScopePhase }>

/**
 * A read-only view of one session's current task; `null` when the session has none. Reading it never
 * changes anything, is synchronous and cheap, and does not throw.
 *
 * The Host uses it to bind what a session learns for one task (task-level refinement entries) to that
 * task, and to let it lapse when the task is completed, cleared or replaced by another one. A new
 * revision of the same task (paused, resumed, edited) is still the same task.
 */
export interface TaskScopeReader {
  current(): TaskScope | null
}

/**
 * How the plugin that owns tasks offers a `TaskScopeReader`: one of its own projections and the reader
 * of that projection's state. The Host folds the projection for a session and asks the reader what the
 * session's task is; a projection that cannot be read is read as no task. The Host grants offering a
 * source to the plugin that owns tasks only.
 */
export interface TaskScopeSource<S extends JsonValue = JsonValue> {
  /** The projection's name, as the plugin registered it. */
  readonly projection: string
  reader(state: Readonly<S>): TaskScopeReader
}
