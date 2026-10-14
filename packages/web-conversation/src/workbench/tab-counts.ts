import type { Session } from '@agnes/sdk/browser'
import type { UiExtensionContext, WorkbenchPanelCount } from '@agnes/web-client'
import { panelContext } from './context.js'

export type SessionCount = WorkbenchPanelCount & {
  /** A panel that has just read the same fact shares it, so the tab never lags the open panel. */
  set(sessionId: string, count: number): void
}

/**
 * A tab count read through an existing session RPC. Reading it asks once per session and ledger
 * watermark, so the dock keeps it current without polling; a failed read keeps the last value.
 */
export function sessionCount(read: (session: Session) => Promise<number>): SessionCount {
  const listeners = new Set<() => void>()
  let value: { sessionId: string; count: number } | undefined
  let asked = ''
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const set = (sessionId: string, count: number) => {
    if (value?.sessionId === sessionId && value.count === count) return
    value = { sessionId, count }
    notify()
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    read(context: UiExtensionContext) {
      const { session, timeline } = panelContext(context) ?? {}
      if (!session) return undefined
      const key = `${session.id}:${timeline?.upto ?? 0}`
      if (key !== asked) {
        asked = key
        void Promise.resolve()
          .then(() => read(session))
          .then((count) => {
            if (asked === key) set(session.id, count)
          })
          .catch(() => undefined)
      }
      return value?.sessionId === session.id ? value.count : undefined
    },
    set,
  }
}

export const changesCount = sessionCount(
  async (session) => (await session.workspaceChanges({ scope: 'session' })).files.length,
)
export const terminalCount = sessionCount(async (session) => (await session.jobsRead()).jobs.length)
