import type { ManagedInputRow, ManagedSessionInputs } from './managed-session-inputs.js'

/** One warning per subject at most this often, however many passes hit it. */
export const OWNER_INPUT_WARN_INTERVAL_MS = 600_000

type RowRef = Pick<ManagedInputRow, 'owner' | 'sessionId' | 'key'>

/** A held input whose session gates could not be read on the last pass that tried. */
export interface UnreadableNote extends RowRef {
  since: number
}

const describe = (error: unknown) =>
  String((error as Error | null)?.message ?? error)
    .replace(/\s+/g, ' ')
    .slice(0, 200)

/**
 * What the owner input engine tells the operator and the owner about inputs it cannot move: a warning
 * per failed pass or per held input, rate-limited per subject, and the inputs held because their gates
 * could not be read. Process memory only: after a restart the next pass finds them again.
 */
export function ownerInputNotes(warn: (message: string) => void, clock: () => number) {
  const warned = new Map<string, number>()
  const unreadable = new Map<string, UnreadableNote>()
  const id = (row: RowRef) => `${row.owner}\0${row.sessionId}\0${row.key}`
  const once = (subject: string, message: () => string) => {
    const now = clock()
    const last = warned.get(subject)
    if (last !== undefined && now - last < OWNER_INPUT_WARN_INTERVAL_MS) return
    // Bounded: subjects whose interval passed are forgotten before a new one is remembered.
    if (warned.size >= 1024)
      for (const [key, at] of warned) if (now - at >= OWNER_INPUT_WARN_INTERVAL_MS) warned.delete(key)
    warned.set(subject, now)
    warn(message())
  }
  return {
    /** Work the engine swallowed so its caller still gets an answer; the next pass retries it. */
    failed(work: string, sessionId: string) {
      return (error: unknown) =>
        once(
          `${work}\0${sessionId}`,
          () => `Owner input ${work} for session ${sessionId} failed: ${describe(error)}`,
        )
    },
    /** These rows stay held: their session's gates could not be read. */
    unreadable(rows: readonly RowRef[], error: unknown) {
      for (const row of rows) {
        if (!unreadable.has(id(row)))
          unreadable.set(id(row), {
            owner: row.owner,
            sessionId: row.sessionId,
            key: row.key,
            since: clock(),
          })
        once(
          `unreadable\0${id(row)}`,
          () =>
            `Owner input ${row.key} of session ${row.sessionId} stays held: its gates could not be read (${describe(error)})`,
        )
      }
    },
    /** The session's gates were read again. */
    readable(sessionId: string) {
      for (const [key, note] of unreadable) if (note.sessionId === sessionId) unreadable.delete(key)
    },
    held(): UnreadableNote[] {
      return [...unreadable.values()]
    },
  }
}

export type OwnerInputNotes = ReturnType<typeof ownerInputNotes>

/** A `queued` row this much older than its last change is an admission its caller did not complete. */
export const ADMISSION_GRACE_MS = 60_000

/** One entry of the owner's list: why the input needs the owner, or why it is held without progress. */
export interface OwnerInputAttention {
  input: ManagedInputRow
  held?: 'gatesUnreadable' | 'admissionIncomplete'
}

/**
 * Every input the owner may have to look at, across sessions: those waiting on the owner's decision,
 * admissions their caller did not complete, and held inputs whose gates could not be read.
 */
export function ownerInputAttention(
  inputs: Pick<ManagedSessionInputs, 'get' | 'attention'>,
  notes: OwnerInputNotes,
  now: number,
  limit: number,
): OwnerInputAttention[] {
  const items: OwnerInputAttention[] = []
  for (const note of notes.held()) {
    const row = inputs.get(note.owner, note.sessionId, note.key)
    if (row?.state === 'enqueued' || row?.state === 'waitingQuestion')
      items.push({ input: row, held: 'gatesUnreadable' })
  }
  for (const row of inputs.attention(now - ADMISSION_GRACE_MS, limit))
    items.push(row.state === 'queued' ? { input: row, held: 'admissionIncomplete' } : { input: row })
  return items.slice(0, limit)
}
