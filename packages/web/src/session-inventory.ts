import type { PageSessionMeta } from '@agnes/protocol'

type Row = PageSessionMeta['items'][number]

/** Which sessions the sidebar lists: everything live, everything, or only the archived ones. */
export type SessionListMode = 'active' | 'all' | 'archived'

export type SessionInventoryView = Readonly<{
  mode: SessionListMode
  /** Compatibility field for hosts and plugins written against the old two-state filter. */
  filter: 'unarchived' | 'archived'
  /** The rows the current mode shows, in server order and unfiltered by any search. */
  rows: readonly Row[]
  /** Whether the whole session list has been read at least once. The default path never reads it. */
  loaded: boolean
  status: 'idle' | 'loading' | 'error'
  /** What went wrong reading the list, in the server's own words. */
  error?: string
  restoring: readonly string[]
}>

export type SessionInventoryApi = Readonly<{
  list(params: { limit: number; cursor?: string }): Promise<{ items: Row[]; next?: string }>
  restore(sessionId: string): Promise<unknown>
  /** Re-read the sidebar's own paged projection after a session changes group. */
  changed(): Promise<unknown>
  /** Surface a failed restore even while the inventory is hidden. */
  error?(failure: unknown): void
}>

const MODE_KEY = 'agnes.sidebar.filter.v1'
const MODES: readonly SessionListMode[] = ['active', 'all', 'archived']

/**
 * The mode a host's snapshot is showing: its own `mode`, or the two-state filter an older host
 * still reports. Every reader derives the filter from this one function.
 */
export function currentMode(view: {
  filter: 'unarchived' | 'archived'
  mode?: SessionListMode | undefined
}): SessionListMode {
  return view.mode ?? (view.filter === 'archived' ? 'archived' : 'active')
}

/** Hosts that implement `setMode` can show the flat list and 「All conversations」; older ones cannot. */
export function supportsModes(history: { setMode?: unknown }): boolean {
  return typeof history.setMode === 'function'
}

function readMode(defaultMode: SessionListMode): SessionListMode {
  try {
    const saved = localStorage.getItem(MODE_KEY)
    return MODES.find((mode) => mode === saved) ?? defaultMode
  } catch {
    // Private windows and disabled storage fall back to the default instead of failing.
    return defaultMode
  }
}

function saveMode(mode: SessionListMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    /* the in-memory choice keeps working */
  }
}

const shows = (mode: SessionListMode, row: Row): boolean =>
  mode === 'all' ? true : mode === 'archived' ? !!row.archived : !row.archived

/**
 * The sidebar's session filter and, for the views that need it, the whole session list.
 *
 * The default view (hide archived, grouped by workspace) is served by the host's paged
 * projection and never reads this list. Flattening the list, mixing archived rows in, or showing
 * only archived rows needs the full order, so those modes read every page once and then keep the
 * result until something invalidates it.
 */
export function createSessionInventory(initialMode?: SessionListMode) {
  let mode: SessionListMode = initialMode ?? readMode('active')
  let rows: Row[] = []
  let loaded = false
  let pending = false
  let error: string | undefined
  let restoring: string[] = []
  let epoch = 0
  let api: SessionInventoryApi | undefined
  const listeners = new Set<() => void>()
  let view: SessionInventoryView = build()

  function build(): SessionInventoryView {
    return Object.freeze({
      mode,
      filter: mode === 'archived' ? ('archived' as const) : ('unarchived' as const),
      rows: rows.filter((row) => shows(mode, row)),
      loaded,
      status: pending ? 'loading' : error ? 'error' : 'idle',
      ...(error ? { error } : {}),
      restoring,
    })
  }

  function publish(): void {
    view = build()
    for (const listener of listeners) listener()
  }

  /** Drop an in-flight read without letting it write back: its rows predate the mutation. */
  function cancelRead(): void {
    epoch += 1
    pending = false
  }

  const message = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure))

  async function reload(): Promise<void> {
    if (!api) return
    const source = api
    const version = ++epoch
    pending = true
    error = undefined
    publish()
    try {
      const next: Row[] = []
      let cursor: string | undefined
      do {
        const page = await source.list({ limit: 500, ...(cursor ? { cursor } : {}) })
        if (version !== epoch) return
        next.push(...page.items)
        // A cursor that does not advance would read the same page forever.
        if (page.next !== undefined && page.next === cursor) break
        cursor = page.next
      } while (cursor !== undefined)
      rows = next
      loaded = true
      pending = false
    } catch (failure) {
      if (version !== epoch) return
      pending = false
      error = message(failure)
    }
    publish()
  }

  function setMode(next: SessionListMode): void {
    if (next === mode) return
    mode = next
    saveMode(next)
    // A read error belongs to the list that was showing; the next one starts clean.
    error = undefined
    publish()
    if (next !== 'active' && !loaded) void reload()
  }

  return {
    bind(next: SessionInventoryApi): void {
      api = next
      // A remembered non-default mode needs its list before the first render shows anything.
      if (mode !== 'active' && !loaded) void reload()
    },
    getSnapshot: (): SessionInventoryView => view,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /**
     * Read the whole list once, on demand: the flat list and the non-default filters need it.
     * A failed read waits for the retry button instead of looping through the render effect.
     */
    async ensureLoaded(): Promise<void> {
      if (loaded || pending || error || !api) return
      await reload()
    },
    reload,
    setMode,
    /** The old two-state entry point; kept for hosts and plugins that still call it. */
    show(filter: 'unarchived' | 'archived'): void {
      setMode(filter === 'archived' ? 'archived' : 'active')
    },
    /** Mark the cached list stale; whoever is showing it reads again. */
    invalidate(): void {
      if (!loaded) return
      loaded = false
      publish()
    },
    /** Replace one row after a rename or another single-row change. */
    patch(row: Row): void {
      if (!rows.some((entry) => entry.sessionId === row.sessionId)) return
      rows = rows.map((entry) => (entry.sessionId === row.sessionId ? row : entry))
      publish()
    },
    async restore(sessionId: string): Promise<void> {
      if (!api || restoring.includes(sessionId)) return
      const source = api
      restoring = [...restoring, sessionId]
      publish()
      try {
        await source.restore(sessionId)
        // A read begun before the restore may still carry the row as archived.
        cancelRead()
        rows = rows.map((row) => (row.sessionId === sessionId ? { ...row, archived: false } : row))
        error = undefined
        publish()
        await source.changed()
      } catch (failure) {
        // The failure belongs to the row's own action: the row stays and the app notice says why.
        source.error?.(failure)
      } finally {
        restoring = restoring.filter((id) => id !== sessionId)
        publish()
      }
    },
    /** Test cleanup: default mode, no cache, and no stored choice. */
    reset(): void {
      cancelRead()
      mode = 'active'
      rows = []
      loaded = false
      error = undefined
      restoring = []
      try {
        localStorage.removeItem(MODE_KEY)
      } catch {
        /* nothing stored to remove */
      }
      publish()
    },
  }
}

/** One per page: the heading, the view menu and the list all read the same filter and rows. */
export const sessionInventory = createSessionInventory()
