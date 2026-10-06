// The ShellSnapshot the Web app keeps for its shells. Before the runtime client wire reaches the
// browser the page knows only which session is open and how its connection stands; a snapshot says
// that and nothing more. It carries no conversation window, domain view or pending interaction, and
// no catalog revision, because this page has none of them to report.
import type { ShellSnapshot } from '@agnes/extension-api/client'

/** The app's connection states, as its top bar shows them. */
export type PageConnection = 'connecting' | 'connected' | 'reconnecting' | 'closed'

const CONNECTION: Readonly<Record<PageConnection, ShellSnapshot['connection']>> = {
  // Not connected yet is not a reconnection.
  connecting: 'offline',
  connected: 'connected',
  reconnecting: 'reconnecting',
  closed: 'offline',
}

export interface ShellSnapshotStore {
  /** The latest snapshot; the same object until something in it changes. */
  current(): ShellSnapshot
  /** Records the open session (null while none is) and the connection; listeners hear only a change. */
  set(next: { sessionId?: string | null; connection?: PageConnection }): void
  subscribe(listener: (snapshot: ShellSnapshot) => void): () => void
}

export function createShellSnapshotStore(): ShellSnapshotStore {
  let snapshot: ShellSnapshot = {
    sessionId: null,
    catalogRevision: 0,
    conversation: null,
    views: [],
    pending: [],
    connection: 'offline',
    cursor: null,
  }
  const listeners = new Set<(snapshot: ShellSnapshot) => void>()
  return {
    current: () => snapshot,
    set(next) {
      const sessionId = next.sessionId === undefined ? snapshot.sessionId : next.sessionId
      const connection = next.connection === undefined ? snapshot.connection : CONNECTION[next.connection]
      if (sessionId === snapshot.sessionId && connection === snapshot.connection) return
      snapshot = { ...snapshot, sessionId, connection }
      for (const listener of [...listeners]) listener(snapshot)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
