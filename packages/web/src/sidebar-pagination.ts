import type { PageSessionMeta, SessionGroupsResult, SessionSidebarListParams } from '@agnes/protocol'
import type { SidebarGroupState, SidebarPaging } from '@agnes/web-units/shell'

type Group = SidebarGroupState & {
  generation: number
  firstNext?: string | undefined
  pageRevision?: string | undefined
  pending?: Promise<void> | undefined
  retryAppend?: boolean
}
type Port = {
  groups(): Promise<SessionGroupsResult>
  list(input: SessionSidebarListParams): Promise<PageSessionMeta>
}

/** Per-page state only. It does not own the selected conversation or cache unloaded sessions. */
export function createSidebarPagination(
  port: Port,
  changed: () => void,
  errorText: (error: unknown) => string,
  /**
   * Groups that render as their own sidebar section (currently the managed chats workspace). They
   * never take the automatic first expansion; the caller maps them from workspace metadata.
   */
  isLeadingGroup: (group: Pick<SidebarGroupState, 'groupId' | 'workspaceId'>) => boolean = () => false,
) {
  let groups: Group[] = [],
    ready = false,
    loading = false,
    error: string | undefined
  let epoch = 0,
    mutations = 0,
    initialised = false,
    touched = false,
    refreshRows = false,
    refreshingMetadata = false,
    refreshing: Promise<void> | undefined
  const snapshot = (): SidebarPaging => ({
    groups: groups.map(
      ({ generation: _g, firstNext: _f, pageRevision: _r, pending: _p, retryAppend: _a, ...view }) => ({
        ...view,
        // Waiting for the summary is part of an open group's background refresh too.
        loading: view.loading || (loading && view.opened),
      }),
    ),
    ready,
    loading,
    ...(error ? { error } : {}),
  })
  const rows = () => groups.flatMap((group) => group.items)
  const failCode = (value: unknown): string | undefined => (value as { data?: { code?: string } })?.data?.code
  const load = (group: Group, append = false): Promise<void> => {
    // A summary read may replace the cursor even before a page request starts.
    if (append && refreshing) return refreshing
    if (group.pending) return group.pending
    if (!group.opened || !group.ready || (append && (!group.next || group.stale))) return Promise.resolve()
    const generation = ++group.generation,
      connection = epoch,
      cursor = append ? group.next : undefined
    group.loading = true
    delete group.error
    delete group.retryAppend
    changed()
    const current = () =>
      epoch === connection && group.generation === generation && groups.includes(group) && group.opened
    const pending = Promise.resolve().then(async () => {
      try {
        const page = await port.list({
          sidebar: { groupId: group.groupId },
          limit: 5,
          ...(cursor ? { cursor } : {}),
        })
        if (!current()) return
        if (page.total === undefined || page.revision === undefined || page.items.length > 5)
          throw new Error('SESSION_SIDEBAR_UNAVAILABLE')
        if (append && page.revision !== group.pageRevision) {
          group.stale = true
          return
        }
        const old = new Map(group.items.map((row) => [row.sessionId, row]))
        const incoming = page.items.map((row) => {
          const previous = old.get(row.sessionId)
          return previous && JSON.stringify(previous) === JSON.stringify(row) ? previous : row
        })
        if (append && incoming.some((row) => old.has(row.sessionId))) {
          group.stale = true
          return
        }
        group.items = append ? [...group.items, ...incoming] : incoming
        group.total = page.total
        group.revision = page.revision
        group.pageRevision = page.revision
        group.next = page.next
        group.loaded = true
        group.stale = false
        if (!append) group.firstNext = page.next
      } catch (failure) {
        if (!current()) return
        group.retryAppend = append
        if (failCode(failure) === 'SESSION_SIDEBAR_CURSOR_STALE') group.stale = true
        else group.error = errorText(failure)
      } finally {
        if (current()) {
          group.loading = false
          group.pending = undefined
          changed()
        }
      }
    })
    group.pending = pending
    return pending
  }
  const invalidate = (group: Group) => {
    delete group.retryAppend
    delete group.error
    group.generation++
    group.pending = undefined
    group.loading = false
  }
  const refresh = (metadata = false): Promise<void> => {
    if (refreshing) {
      // Focus and visibility can request the same metadata already being read.
      refreshRows ||= metadata && !refreshingMetadata
      return refreshing
    }
    refreshRows ||= metadata
    const connection = epoch,
      mutation = mutations,
      readRows = refreshRows
    refreshRows = false
    refreshingMetadata = readRows
    loading = true
    error = undefined
    changed()
    const pending = Promise.resolve().then(async () => {
      try {
        const summary = await port.groups()
        if (connection !== epoch || mutation !== mutations) return
        const old = new Map(groups.map((group) => [group.groupId, group]))
        const reload: Group[] = []
        groups = summary.items.map((item) => {
          const group = old.get(item.groupId) ?? {
            ...item,
            items: [],
            // The pinned area at the top is shown open; workspace groups start collapsed.
            opened: item.groupId === 'pinned',
            loaded: false,
            loading: false,
            generation: 0,
          }
          if (group.stale || group.revision !== item.revision) {
            invalidate(group)
            group.stale = true
            // 列表变了就替用户重读首页：展开的多页列表收回到首页，不再让人点「重新加载」。
            if (group.opened && item.ready) reload.push(group)
          }
          // Counts alongside retained multi-page rows belong to that page's snapshot.
          const total = group.stale && group.items.length > 5 ? group.total : item.total
          delete group.initializationError
          Object.assign(group, item, { total })
          // Revisions cover paging, not every metadata edit; focus/reconnect explicitly reread rows.
          if (
            group.opened &&
            group.ready &&
            !group.pending &&
            (!group.loaded || readRows) &&
            group.items.length <= 5
          )
            reload.push(group)
          return group
        })
        ready = summary.ready
        if (!initialised && ready) {
          initialised = true
          if (!touched) {
            // The first workspace opens by default; 置顶 and 临时会话 never do.
            const first = groups.find(
              (group) => group.groupId !== 'pinned' && !isLeadingGroup(group) && group.total > 0,
            )
            if (first) {
              first.opened = true
              reload.push(first)
            }
          }
        }
        changed()
        await Promise.all([...new Set(reload)].map((group) => load(group)))
      } catch (failure) {
        if (connection === epoch) error = errorText(failure)
      } finally {
        if (connection === epoch) {
          loading = false
          refreshing = undefined
          if (mutation !== mutations || refreshRows) await refresh(readRows)
          else changed()
        }
      }
    })
    refreshing = pending
    return pending
  }
  return {
    snapshot,
    rows,
    refresh,
    patch(row: PageSessionMeta['items'][number]) {
      for (const group of groups) {
        if (!group.items.some((previous) => previous.sessionId === row.sessionId)) continue
        // Fence older replies without discarding loaded pages, cursors or an idle retry state.
        if (group.pending) invalidate(group)
        group.items = group.items.map((previous) => (previous.sessionId === row.sessionId ? row : previous))
      }
      changed()
    },
    async created(workspaceId: string) {
      touched = true
      // Rows are the expansion: a refresh caused by the new session re-reads only the first page, so
      // remember how many pages the user had open before it runs and load the rest back afterwards.
      const depth = Math.max(
        1,
        Math.ceil((groups.find((group) => group.groupId === workspaceId)?.items.length ?? 0) / 5),
      )
      await refresh()
      const group = groups.find((item) => item.groupId === workspaceId)
      if (!group) return
      group.opened = true
      if (!group.loaded || group.stale || group.error) {
        invalidate(group)
        await load(group)
      }
      const pagesShown = Math.max(1, Math.ceil(group.items.length / 5))
      for (let page = pagesShown; page < depth && group.next && !group.stale && !group.error; page++)
        await load(group, true)
    },
    reset() {
      epoch++
      refreshing = undefined
      refreshRows = false
      loading = false
      for (const group of groups) {
        invalidate(group)
        group.stale = group.loaded
      }
    },
    async action(id: string, action: 'toggle' | 'more' | 'collapse' | 'reload' | 'retry'): Promise<void> {
      const group = groups.find((item) => item.groupId === id)
      if (!group) return
      touched = true
      if (action === 'toggle') {
        group.opened = !group.opened
        if (!group.opened) {
          invalidate(group)
          group.items = []
          group.loaded = false
          group.stale = false
          delete group.next
          delete group.firstNext
          delete group.pageRevision
          delete group.error
          changed()
          return
        }
        changed()
        await load(group)
        return
      }
      if (action === 'collapse') {
        invalidate(group)
        group.items = group.items.slice(0, 5)
        group.next = group.firstNext
        changed()
        if (group.stale) await load(group)
      } else if (action === 'reload') {
        invalidate(group)
        await load(group)
      } else {
        await load(group, action === 'more' || (!group.stale && group.retryAppend === true))
        // 追加页遇到过期游标时同样自动重读首页，不把「请重新加载」抛给用户。
        if (group.stale && group.opened) await load(group)
      }
    },
    /** A locally persisted message must fence a page already in flight before the summary arrives. */
    invalidateSession(
      id: string,
      cwd?: string,
      workspaces: readonly { path: string; workspaceId?: string }[] = [],
    ) {
      mutations++
      const groupId = workspaces.find((row) => row.path === cwd)?.workspaceId ?? 'unassigned'
      for (const group of groups)
        if (group.groupId === groupId || group.items.some((row) => row.sessionId === id)) {
          invalidate(group)
          group.stale = true
        }
    },
  }
}
