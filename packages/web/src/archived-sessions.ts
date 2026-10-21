import type { PageSessionMeta } from '@agnes/protocol'

type Row = PageSessionMeta['items'][number]
export type SessionFilter = 'unarchived' | 'archived'
export type ArchivedSessionsView = Readonly<{
  filter: SessionFilter
  rows: readonly Row[]
  status: 'idle' | 'loading' | 'error'
  /** What went wrong reading the list, in the server's own words. */
  error?: string
  restoring: readonly string[]
}>
export type ArchivedSessionsApi = Readonly<{
  list(params: { limit: number; cursor?: string }): Promise<{ items: Row[]; next?: string }>
  restore(sessionId: string): Promise<unknown>
  /** Re-read the sidebar's own session list after a session returns to it. */
  changed(): Promise<unknown>
  /** Surface a failed undo even while the archived list is hidden. */
  error?(failure: unknown): void
}>

/**
 * The sidebar's session filter and the archived sessions it lists. The sidebar keeps showing
 * unarchived sessions until someone asks for the archived ones; only then is the whole list read.
 */
export function createArchivedSessions() {
  let view: ArchivedSessionsView = { filter: 'unarchived', rows: [], status: 'idle', restoring: [] }
  let api: ArchivedSessionsApi | undefined
  let epoch = 0
  const listeners = new Set<() => void>()
  const set = (next: Partial<ArchivedSessionsView>) => {
    view = { ...view, ...next }
    for (const listener of listeners) listener()
  }
  const message = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure))
  async function reload(): Promise<void> {
    if (!api) return
    const source = api
    const version = ++epoch
    const { error: _cleared, ...rest } = view
    view = rest
    set({ status: 'loading' })
    try {
      const rows: Row[] = []
      let cursor: string | undefined
      do {
        const page = await source.list({ limit: 500, ...(cursor ? { cursor } : {}) })
        if (version !== epoch) return
        rows.push(...page.items.filter((row) => row.archived))
        // A cursor that does not advance would read the same page forever.
        if (page.next !== undefined && page.next === cursor) break
        cursor = page.next
      } while (cursor !== undefined)
      set({ rows, status: 'idle' })
    } catch (failure) {
      if (version === epoch) set({ status: 'error', error: message(failure) })
    }
  }
  return {
    bind(next: ArchivedSessionsApi): void {
      api = next
    },
    getSnapshot: (): ArchivedSessionsView => view,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    show(filter: SessionFilter): void {
      if (filter === view.filter) return
      set({ filter })
      if (filter === 'archived') void reload()
      else {
        epoch += 1
        // Leaving the view drops a read error with it: the list it belongs to is no longer shown.
        const { error: _cleared, ...rest } = view
        view = rest
        set({ status: 'idle' })
      }
    },
    reload,
    async restore(sessionId: string): Promise<void> {
      if (!api || view.restoring.includes(sessionId)) return
      const source = api
      set({ restoring: [...view.restoring, sessionId] })
      try {
        await source.restore(sessionId)
        // A list begun before the mutation may still contain the restored session.
        epoch += 1
        const { error: _cleared, ...rest } = view
        view = rest
        set({ rows: view.rows.filter((row) => row.sessionId !== sessionId), status: 'idle' })
        await source.changed()
      } catch (failure) {
        // The failure belongs to the row's own action: the row stays and the app notice says why.
        source.error?.(failure)
      } finally {
        set({ restoring: view.restoring.filter((id) => id !== sessionId) })
      }
    },
  }
}

/** One per page: the sidebar heading, its archived row and the archived list read the same view. */
export const archivedSessions = createArchivedSessions()
