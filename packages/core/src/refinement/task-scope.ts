import { isChildSession } from '../step/child-session.js'
import type { SessionImpl } from '../step/session.js'

/**
 * The session's current task as the plugin that owns tasks (the goal plugin) reports it. Core has no
 * goal of its own: this is all it learns of one, read through the host's task-scope reader.
 */
export type TaskScope = Readonly<{
  id: string
  revision: number
  phase: 'active' | 'paused' | 'blocked' | 'complete'
}>

const PHASES = new Set(['active', 'paused', 'blocked', 'complete'])

/** A reader's answer as Core takes it: anything that is not a well-formed task reads as none. */
function checked(value: unknown): TaskScope | null {
  const v = value as Partial<Record<keyof TaskScope, unknown>> | null
  if (!v || typeof v !== 'object') return null
  if (typeof v.id !== 'string' || v.id.length === 0 || v.id.length > 256) return null
  if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 0) return null
  if (!PHASES.has(String(v.phase))) return null
  return Object.freeze({ id: v.id, revision: v.revision as number, phase: v.phase as TaskScope['phase'] })
}

/** The current task as Core reads it, and whether it could be read at all. */
export type TaskScopeRead = { scope: TaskScope | null; readable: boolean }

/**
 * The task a refinement entry of this session can be bound to now: the current goal unless it is
 * complete. Readable with no task when the session has no goal, when no reader is wired at all, and
 * always in a child session, where task-level entries are never active. Unreadable when the reader
 * throws or answers `undefined` (the goal plugin is being reloaded or is off, its projection cannot
 * be folded): nothing may then be concluded about task-level entries, and the next read decides.
 * An answer that is not a well-formed task reads as no task.
 */
export async function readTaskScope(s: SessionImpl): Promise<TaskScopeRead> {
  const read = s.d.refinement?.taskScope
  if (!read || isChildSession(s)) return { scope: null, readable: true }
  try {
    const answer = await read({ key: s.key, lane: s.lane })
    if (answer === undefined) return { scope: null, readable: false }
    const scope = checked(answer)
    return { scope: scope && scope.phase !== 'complete' ? scope : null, readable: true }
  } catch {
    return { scope: null, readable: false }
  }
}

/** The task to bind a new lesson to now; none when there is no goal or it cannot be read. */
export async function currentTaskScope(s: SessionImpl): Promise<TaskScope | null> {
  return (await readTaskScope(s)).scope
}

/**
 * Whether a task-level entry learned under `bound` still holds while `now` is the current task: the
 * same goal, not complete. A new revision of the same goal (paused, resumed, edited, budget changed)
 * is the same task; completing, clearing or replacing the goal ends it.
 */
export const sameTask = (bound: { id: string } | undefined, now: TaskScope | null): boolean =>
  !!bound && !!now && now.phase !== 'complete' && now.id === bound.id
