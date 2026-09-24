import { type Cursor, validateAgainst } from '@agnes/protocol'
import { Cursor as CursorSchema } from '@agnes/protocol/gen/agnes-v1'
import { type JournalStore, type PendingCommand, randomId, snapshotPending } from './journal.js'
import { journalCommandId } from './journal-command-id.js'

export type JournalState = {
  clientId: string
  counters: Record<string, number>
  cursors: Record<string, Cursor>
  pending: Record<string, PendingCommand[]>
}
export const invalidJournal = () => new Error('invalid journal state')
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const own = <T>(map: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined
const put = <T>(map: Record<string, T>, key: string, value: T) => {
  Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true })
}
const command = (value: unknown): value is PendingCommand =>
  record(value) &&
  typeof value.commandId === 'string' &&
  !!value.commandId &&
  typeof value.method === 'string' &&
  !!value.method &&
  Object.hasOwn(value, 'params')

export function freshJournal(clientId: string = randomId()): JournalState {
  if (typeof clientId !== 'string' || !clientId) throw invalidJournal()
  return { clientId, counters: {}, cursors: {}, pending: {} }
}
export function decodeJournal(raw: string): JournalState {
  try {
    const state: unknown = JSON.parse(raw)
    if (
      !record(state) ||
      typeof state.clientId !== 'string' ||
      !state.clientId ||
      !record(state.counters) ||
      !record(state.cursors) ||
      !record(state.pending)
    )
      throw invalidJournal()
    if (
      !Object.values(state.counters).every(
        (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0,
      ) ||
      !Object.values(state.cursors).every((cursor) => validateAgainst(CursorSchema, cursor).ok) ||
      !Object.values(state.pending).every((commands) => Array.isArray(commands) && commands.every(command))
    )
      throw invalidJournal()
    return state as JournalState
  } catch {
    throw invalidJournal()
  }
}
/** A transaction owns the state snapshot and commits writes before returning its result. */
export type JournalTransaction = <T>(change: (state: JournalState) => T, write: boolean) => T
export function storedJournal(transact: JournalTransaction): JournalStore {
  return {
    async clientId() {
      return transact((s) => s.clientId, false)
    },
    async nextCommandId(sessionId) {
      const next = transact((s) => {
        const n = (own(s.counters, sessionId) ?? 0) + 1
        if (!Number.isSafeInteger(n)) throw invalidJournal()
        put(s.counters, sessionId, n)
        return { clientId: s.clientId, counter: n }
      }, true)
      return journalCommandId(next.clientId, sessionId, next.counter)
    },
    async cursor(sessionId) {
      return transact((s) => structuredClone(own(s.cursors, sessionId) ?? null), false)
    },
    async setCursor(sessionId, cursor) {
      if (!validateAgainst(CursorSchema, cursor).ok) throw invalidJournal()
      transact((s) => put(s.cursors, sessionId, structuredClone(cursor)), true)
    },
    async pending(sessionId) {
      return transact((s) => structuredClone(own(s.pending, sessionId) ?? []), false)
    },
    async markPending(sessionId, pending) {
      const saved = snapshotPending(pending)
      transact((s) => put(s.pending, sessionId, [...(own(s.pending, sessionId) ?? []), saved]), true)
    },
    async clearPending(sessionId, commandId) {
      transact(
        (s) =>
          put(
            s.pending,
            sessionId,
            (own(s.pending, sessionId) ?? []).filter((c) => c.commandId !== commandId),
          ),
        true,
      )
    },
  }
}
