// Client-side durable notebook. Two jobs: hand out the identity the daemon dedups
// writes by (clientId + a monotonic commandId per session), and remember how far a
// session's event stream has been read so a reconnect resumes instead of replaying.
// This file holds the in-memory store only; the node file store and the browser
// localStorage store plug into the same interface.
import { type Cursor, jcs } from '@agnes/protocol'
import { journalCommandId } from './journal-command-id.js'

export type PendingCommand = {
  commandId: string
  method: string
  params: unknown
  /** Absent means replayable. Unknown outcomes require explicit checking with the same identity. */
  state?: 'needs-confirmation'
}

export function upsertPending(commands: PendingCommand[], command: PendingCommand): PendingCommand[] {
  const saved = snapshotPending(command)
  const existing = commands.find((entry) => entry.commandId === saved.commandId)
  if (existing && (existing.method !== saved.method || jcs(existing.params) !== jcs(saved.params)))
    throw new Error('journal command identity conflict')
  if (existing?.state) saved.state = existing.state
  return [...commands.filter((entry) => entry.commandId !== saved.commandId), saved]
}

/** The exact JSON value to resend, without invoking getters/toJSON or silently dropping fields. */
export function snapshotPending(value: PendingCommand): PendingCommand {
  try {
    const copy: unknown = JSON.parse(jcs(value))
    if (
      copy === null ||
      typeof copy !== 'object' ||
      Array.isArray(copy) ||
      !('commandId' in copy) ||
      typeof copy.commandId !== 'string' ||
      !copy.commandId ||
      !('method' in copy) ||
      typeof copy.method !== 'string' ||
      !copy.method ||
      !Object.hasOwn(copy, 'params') ||
      ('state' in copy && copy.state !== 'needs-confirmation')
    )
      throw new Error('invalid journal state')
    return copy as PendingCommand
  } catch {
    throw new Error('invalid journal state')
  }
}

export interface JournalStore {
  clientId(): Promise<string>
  nextCommandId(sessionId: string): Promise<string>
  cursor(sessionId: string): Promise<Cursor | null>
  setCursor(sessionId: string, c: Cursor): Promise<void>
  /** All unresolved commands; automatic replay excludes needs-confirmation entries. */
  pending(sessionId: string): Promise<PendingCommand[]>
  /** Atomically insert or update the same identity and payload; preserve needs-confirmation. */
  markPending(sessionId: string, cmd: PendingCommand): Promise<void>
  clearPending(sessionId: string, commandId: string): Promise<void>
}

// Web Crypto rather than node:crypto: this module ships in the browser build too.
export function randomId(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function memoryJournal(clientId: string = randomId()): JournalStore {
  const counters = new Map<string, number>()
  const cursors = new Map<string, Cursor>()
  const pending = new Map<string, PendingCommand[]>()
  return {
    async clientId() {
      return clientId
    },
    async nextCommandId(sessionId) {
      const n = (counters.get(sessionId) ?? 0) + 1
      if (!Number.isSafeInteger(n)) throw new Error('invalid journal state')
      counters.set(sessionId, n)
      return journalCommandId(clientId, sessionId, n)
    },
    async cursor(sessionId) {
      return structuredClone(cursors.get(sessionId) ?? null)
    },
    async setCursor(sessionId, c) {
      cursors.set(sessionId, structuredClone(c))
    },
    // A copy, not the live array: a caller iterating pending while the client clears
    // acknowledged commands would otherwise skip entries.
    async pending(sessionId) {
      return structuredClone(pending.get(sessionId) ?? [])
    },
    async markPending(sessionId, cmd) {
      pending.set(sessionId, upsertPending(pending.get(sessionId) ?? [], cmd))
    },
    async clearPending(sessionId, commandId) {
      pending.set(
        sessionId,
        (pending.get(sessionId) ?? []).filter((c) => c.commandId !== commandId),
      )
    },
  }
}
