import type { PageSessionMeta, SessionGroupsResult } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { createSidebarPagination } from '../src/sidebar-pagination.js'

const row = (id: number, group = 'a') => ({
  sessionId: `${group}${id}`,
  createdAt: '2026-10-16T00:00:00Z',
  lastSeq: 2,
  generation: 1,
  preset: 'standard',
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function setup(
  changed = () => {},
  isLeadingGroup?: (group: { groupId: string; workspaceId?: string }) => boolean,
) {
  let revision = 'v1',
    ready = true
  const groups = vi.fn(
    async (): Promise<SessionGroupsResult> => ({
      ready,
      items: ['a', 'b'].map((groupId) => ({
        groupId,
        workspaceId: groupId,
        total: 17,
        lastMessageAt: '2026-10-16T00:00:00Z',
        revision,
        ready,
      })),
    }),
  )
  const list = vi.fn(
    async (input: { sidebar: { groupId: string }; cursor?: string }): Promise<PageSessionMeta> => {
      const start = Number(input.cursor ?? 0)
      return {
        items: Array.from({ length: Math.min(5, 17 - start) }, (_, i) =>
          row(start + i, input.sidebar.groupId),
        ),
        total: 17,
        revision,
        ...(start + 5 < 17 ? { next: String(start + 5) } : {}),
      }
    },
  )
  const ui = createSidebarPagination({ groups, list }, changed, () => 'Failed', isLeadingGroup)
  return {
    ui,
    groups,
    list,
    revision: (value: string) => {
      revision = value
    },
    ready: (value: boolean) => {
      ready = value
    },
  }
}

it('opens only the latest group, pages 5/10/15/17 and collapses without fetching', async () => {
  const s = setup()
  await s.ui.refresh()
  expect(s.list).toHaveBeenCalledTimes(1)
  expect(s.ui.snapshot().groups.map((g) => [g.opened, g.items.length])).toEqual([
    [true, 5],
    [false, 0],
  ])
  const firstRow = s.ui.rows()[0]
  // Repeated background refreshes keep the loaded page without another page read.
  await s.ui.refresh()
  await s.ui.refresh()
  expect(s.list).toHaveBeenCalledTimes(1)
  expect(s.ui.rows()[0]).toBe(firstRow)
  expect(s.ui.snapshot().groups[0]?.loading).toBe(false)
  for (const length of [10, 15, 17]) {
    await s.ui.action('a', 'more')
    expect(s.ui.rows()).toHaveLength(length)
  }
  expect(s.ui.rows()[0]).toBe(firstRow)
  expect(s.ui.snapshot().groups[0]?.next).toBeUndefined()
  const calls = s.list.mock.calls.length
  await s.ui.action('a', 'collapse')
  expect(s.list).toHaveBeenCalledTimes(calls)
  expect(s.ui.rows()).toHaveLength(5)
  await s.ui.action('a', 'more')
  expect(s.ui.rows()).toHaveLength(10)
  await s.ui.action('b', 'toggle')
  expect(s.ui.snapshot().groups.map((g) => g.items.length)).toEqual([10, 5])
  await s.ui.action('a', 'toggle')
  expect(s.ui.snapshot().groups[0]?.items).toEqual([])
  await s.ui.action('a', 'toggle')
  expect(s.ui.snapshot().groups[0]?.items).toHaveLength(5)
})

it('shares a group request, rejects replies after collapse, and retains a failed continuation', async () => {
  const s = setup()
  await s.ui.refresh()
  const pending = deferred<PageSessionMeta>()
  s.list.mockImplementationOnce(() => pending.promise)
  const first = s.ui.action('a', 'more'),
    duplicate = s.ui.action('a', 'more')
  await Promise.resolve()
  expect(s.list).toHaveBeenCalledTimes(2)
  await s.ui.action('a', 'toggle')
  pending.resolve({ items: [row(5)], total: 17, revision: 'v1' })
  await Promise.all([first, duplicate])
  expect(s.ui.snapshot().groups[0]).toMatchObject({ opened: false, items: [], loading: false })
  await s.ui.action('a', 'toggle')
  s.list.mockRejectedValueOnce(new Error('offline'))
  await s.ui.action('a', 'more')
  expect(s.ui.snapshot().groups[0]).toMatchObject({ next: '5', error: 'Failed', loaded: true })
  expect(s.ui.rows()).toHaveLength(5)
  s.ui.patch({ ...row(0), title: 'Renamed', titleSource: 'user' })
  expect(s.ui.snapshot().groups[0]?.error).toBe('Failed')
  await s.ui.action('a', 'retry')
  expect(s.ui.rows()).toHaveLength(10)
  expect(s.ui.rows()[0]?.title).toBe('Renamed')
  expect(s.ui.snapshot().groups[0]?.error).toBeUndefined()
  expect(s.list).toHaveBeenLastCalledWith({ sidebar: { groupId: 'a' }, limit: 5, cursor: '5' })
})

it.each(['success', 'failure'] as const)('keeps a rename during refresh after a late %s', async (outcome) => {
  const s = setup()
  await s.ui.refresh()
  const before = s.ui.rows()
  const late = deferred<PageSessionMeta>()
  s.list.mockImplementationOnce(() => late.promise)
  const refresh = s.ui.refresh(true)
  await vi.waitFor(() => expect(s.list).toHaveBeenCalledTimes(2))
  const renamed = { ...row(0), title: 'Renamed', titleSource: 'user' as const }
  s.ui.patch(renamed)
  const afterSave = s.ui.refresh()
  if (outcome === 'success') late.resolve({ items: before, total: 17, revision: 'v1', next: '5' })
  else late.reject(new Error('old request failed'))
  await Promise.all([refresh, afterSave])
  expect(s.ui.snapshot().groups[0]).toMatchObject({
    items: [renamed, ...before.slice(1)],
    opened: true,
    loaded: true,
    loading: false,
    stale: false,
    next: '5',
    total: 17,
  })
  expect(s.ui.snapshot().groups[0]?.error).toBeUndefined()
  await s.ui.action('a', 'more')
  expect(s.ui.rows()).toHaveLength(10)
  expect(s.ui.rows()[0]).toEqual(renamed)
})

it.each(['more', 'reload'] as const)(
  'retains expanded pages and cursors when renamed during %s',
  async (action) => {
    const s = setup()
    await s.ui.refresh()
    await s.ui.action('a', 'more')
    const before = s.ui.rows()
    const late = deferred<PageSessionMeta>()
    s.list.mockImplementationOnce(() => late.promise)
    const pending = s.ui.action('a', action)
    await Promise.resolve()
    const renamed = { ...row(7), title: 'Renamed on page two', titleSource: 'user' as const }
    s.ui.patch(renamed)
    await s.ui.refresh()
    late.resolve({
      items: action === 'reload' ? before.slice(0, 5) : [row(10)],
      total: 17,
      revision: 'v1',
      next: action === 'reload' ? '5' : '11',
    })
    await pending
    expect(s.ui.snapshot().groups[0]).toMatchObject({
      items: before.map((item) => (item.sessionId === renamed.sessionId ? renamed : item)),
      opened: true,
      loading: false,
      stale: false,
      next: '10',
      total: 17,
    })
    await s.ui.action('a', 'more')
    expect(s.list).toHaveBeenLastCalledWith({ sidebar: { groupId: 'a' }, limit: 5, cursor: '10' })
    expect(s.ui.rows()).toHaveLength(15)
    expect(s.ui.rows()[7]).toEqual(renamed)
    await s.ui.action('a', 'collapse')
    expect(s.ui.rows()).toHaveLength(5)
    expect(s.ui.snapshot().groups[0]?.next).toBe('5')
  },
)

it('does not let an invalidated response finish a newer request or affect another group', async () => {
  const s = setup()
  await s.ui.refresh()
  await s.ui.action('b', 'toggle')
  const old = deferred<PageSessionMeta>(),
    other = deferred<PageSessionMeta>(),
    fresh = deferred<PageSessionMeta>()
  s.list.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => other.promise)
  const oldRequest = s.ui.action('a', 'reload'),
    otherRequest = s.ui.action('b', 'more')
  await Promise.resolve()
  s.ui.patch({ ...row(0), title: 'Renamed', titleSource: 'user' })
  s.list.mockImplementationOnce(() => fresh.promise)
  const freshRequest = s.ui.action('a', 'more')
  await Promise.resolve()
  old.resolve({ items: [row(0)], total: 17, revision: 'v1' })
  await oldRequest
  expect(s.ui.snapshot().groups.map((group) => group.loading)).toEqual([true, true])
  expect(s.ui.rows()[0]?.title).toBe('Renamed')
  // A row outside the loaded pages must not cancel either request.
  s.ui.patch({ ...row(16), title: 'Not loaded', titleSource: 'user' })
  other.resolve({ items: [row(5, 'b')], total: 17, revision: 'v1', next: '6' })
  fresh.resolve({ items: [row(5)], total: 17, revision: 'v1', next: '6' })
  await Promise.all([freshRequest, otherRequest])
  expect(s.ui.snapshot().groups.map((group) => [group.items.length, group.loading, group.next])).toEqual([
    [6, false, '6'],
    [6, false, '6'],
  ])
  expect(s.ui.rows()[0]?.title).toBe('Renamed')
})

it('retries a failed first-page refresh even when already loaded without a next cursor', async () => {
  const s = setup()
  const page = { items: [row(0), row(1)], total: 2, revision: 'v1' }
  s.list.mockResolvedValue(page)
  await s.ui.refresh()
  s.list.mockRejectedValueOnce(new Error('offline'))
  await s.ui.refresh(true)
  expect(s.ui.snapshot().groups[0]).toMatchObject({
    loaded: true,
    stale: false,
    error: 'Failed',
    items: page.items,
  })
  await s.ui.action('a', 'retry')
  expect(s.list).toHaveBeenLastCalledWith({ sidebar: { groupId: 'a' }, limit: 5 })
  expect(s.ui.snapshot().groups[0]?.error).toBeUndefined()
  expect(s.ui.rows()).toEqual(page.items)
})

it('rereads metadata on focus even when the paging revision is unchanged', async () => {
  const s = setup()
  await s.ui.refresh()
  s.list.mockResolvedValueOnce({
    items: [{ ...row(0), title: 'Renamed elsewhere', titleSource: 'user' }],
    total: 1,
    revision: 'v1',
  })
  await s.ui.refresh(true)
  expect(s.ui.rows()[0]?.title).toBe('Renamed elsewhere')
  expect(s.ui.snapshot()).toMatchObject({
    loading: false,
    groups: [expect.objectContaining({ loading: false }), expect.anything()],
  })
  // Archiving the remaining row publishes a new revision and refreshes the first page automatically.
  s.ui.invalidateSession('a0')
  s.revision('v2')
  s.list.mockResolvedValueOnce({ items: [], total: 0, revision: 'v2' })
  await s.ui.refresh()
  expect(s.ui.rows()).toEqual([])
  expect(s.ui.snapshot().groups[0]).toMatchObject({ stale: false, loading: false, total: 0 })
})

it('queues more during shared focus refreshes and appends with the refreshed cursor', async () => {
  const s = setup()
  await s.ui.refresh()
  const summary = deferred<SessionGroupsResult>(),
    page = deferred<PageSessionMeta>()
  const initialSummary = await s.groups()
  s.groups.mockClear()
  s.groups.mockImplementationOnce(() => summary.promise)
  s.list.mockImplementationOnce(() => page.promise)
  const focus = s.ui.refresh(true)
  const visible = s.ui.refresh(true)
  expect(visible).toBe(focus)
  expect(s.ui.snapshot().groups[0]?.loading).toBe(true)
  expect(s.ui.snapshot().groups[0]?.refreshing).toBe(true)
  const more = s.ui.action('a', 'more')
  await Promise.resolve()
  expect(s.list).toHaveBeenCalledTimes(1)
  summary.resolve(initialSummary)
  await vi.waitFor(() => expect(s.list).toHaveBeenCalledTimes(2))
  expect(s.ui.refresh(true)).toBe(focus)
  const moreDuringRows = s.ui.action('a', 'more')
  s.list.mockResolvedValueOnce({
    items: Array.from({ length: 5 }, (_, i) => row(i + 5)),
    total: 17,
    revision: 'v2',
    next: '10',
  })
  page.resolve({ items: s.ui.rows(), total: 17, revision: 'v2', next: 'fresh-cursor' })
  await Promise.all([focus, visible, more, moreDuringRows])
  expect(s.groups).toHaveBeenCalledTimes(1)
  expect(s.list).toHaveBeenCalledTimes(3)
  expect(s.list.mock.calls.slice(0, 2).every(([input]) => input.cursor === undefined)).toBe(true)
  expect(s.list).toHaveBeenLastCalledWith({ sidebar: { groupId: 'a' }, limit: 5, cursor: 'fresh-cursor' })
  expect(s.ui.rows()).toHaveLength(10)
  expect(s.ui.snapshot().groups[0]).toMatchObject({ loading: false, next: '10' })
})

it('keeps an actual append busy when a focus refresh starts during its response', async () => {
  const s = setup()
  await s.ui.refresh()
  const page = deferred<PageSessionMeta>(),
    summary = deferred<SessionGroupsResult>()
  const initial = await s.groups()
  s.list.mockImplementationOnce(() => page.promise)
  const more = s.ui.action('a', 'more')
  await Promise.resolve()
  s.groups.mockImplementationOnce(() => summary.promise)
  const refresh = s.ui.refresh(true)
  expect(s.ui.snapshot().groups[0]).toMatchObject({ loading: true, refreshing: false })
  page.resolve({
    items: Array.from({ length: 5 }, (_, i) => row(i + 5)),
    total: 17,
    revision: 'v1',
    next: '10',
  })
  summary.resolve(initial)
  await Promise.all([more, refresh])
  expect(s.ui.rows()).toHaveLength(10)
  expect(s.list).toHaveBeenCalledTimes(2)
})

it.each([
  ['more', 1],
  ['more', 2],
  ['collapse', 1],
  ['collapse', 2],
] as const)('preserves a late %s while rereading page %i of an expanded group', async (action, heldPage) => {
  const s = setup()
  await s.ui.refresh()
  await s.ui.action('a', 'more')
  expect(s.ui.rows()).toHaveLength(10)
  s.revision('v2')
  const first = { items: Array.from({ length: 5 }, (_, i) => row(i)), total: 17, revision: 'v2', next: '5' }
  const page = deferred<PageSessionMeta>()
  if (heldPage === 2) s.list.mockResolvedValueOnce(first)
  s.list.mockImplementationOnce(() => page.promise)
  const refresh = s.ui.refresh(true)
  await vi.waitFor(() => expect(s.list).toHaveBeenCalledTimes(heldPage + 2))
  expect(s.ui.snapshot().groups[0]?.refreshing).toBe(true)
  const intent = s.ui.action('a', action)
  page.resolve(
    heldPage === 1 ? first : { ...first, items: Array.from({ length: 5 }, (_, i) => row(i + 5)), next: '10' },
  )
  await Promise.all([refresh, intent])
  expect(s.ui.rows()).toHaveLength(action === 'more' ? 15 : 5)
  expect(s.ui.snapshot().groups[0]).toMatchObject({ loading: false, next: action === 'more' ? '15' : '5' })
})

it.each([
  [1, 0],
  [2, 0],
  [1, 100],
  [2, 100],
] as const)(
  'retains a patched row when staged page %i with offset %i is invalidated',
  async (heldPage, offset) => {
    const s = setup()
    await s.ui.refresh()
    await s.ui.action('a', 'more')
    s.revision('v2')
    s.list.mockImplementation(async (input) => {
      const start = Number(input.cursor ?? 0)
      return {
        items: Array.from({ length: Math.min(5, 17 - start) }, (_, i) => row(offset + start + i)),
        total: 17,
        revision: 'v2',
        ...(start + 5 < 17 ? { next: String(start + 5) } : {}),
      }
    })
    const first = {
      items: Array.from({ length: 5 }, (_, i) => row(offset + i)),
      total: 17,
      revision: 'v2',
      next: '5',
    }
    const page = deferred<PageSessionMeta>()
    if (heldPage === 2) s.list.mockResolvedValueOnce(first)
    s.list.mockImplementationOnce(() => page.promise)
    const refresh = s.ui.refresh(true)
    await vi.waitFor(() => expect(s.list).toHaveBeenCalledTimes(heldPage + 2))
    s.ui.patch({ ...row(0), title: 'Renamed during metadata refresh' })
    page.resolve(
      heldPage === 1
        ? first
        : { ...first, items: Array.from({ length: 5 }, (_, i) => row(offset + i + 5)), next: '10' },
    )
    await refresh
    expect(s.ui.rows()).toHaveLength(10)
    expect(s.ui.rows()[0]?.title).toBe('Renamed during metadata refresh')
    expect(s.ui.snapshot().groups[0]).toMatchObject({ next: '10', revision: 'v1', total: 17 })
    await s.ui.action('a', 'more')
    expect(s.ui.rows()).toHaveLength(15)
    expect(s.ui.snapshot().groups[0]?.next).toBe('15')
    expect(s.ui.rows().map((item) => item.sessionId)).toEqual(
      Array.from({ length: 15 }, (_, i) => `a${offset + i}`),
    )
  },
)

it.each(['collapse', 'toggle', 'reset', 'remove'] as const)(
  'cancels a queued more after %s during a focus refresh',
  async (action) => {
    const s = setup()
    await s.ui.refresh()
    const summary = deferred<SessionGroupsResult>()
    const initial = await s.groups()
    s.groups.mockImplementationOnce(() => summary.promise)
    const refresh = s.ui.refresh(true)
    const more = s.ui.action('a', 'more')
    if (action === 'reset') s.ui.reset()
    else if (action !== 'remove') await s.ui.action('a', action)
    summary.resolve(
      action === 'remove'
        ? { ...initial, items: initial.items.filter((group) => group.groupId !== 'a') }
        : initial,
    )
    await Promise.all([refresh, more])
    // Collapsing to the first page keeps the group open, so its metadata read still completes.
    expect(s.list).toHaveBeenCalledTimes(action === 'collapse' ? 2 : 1)
    expect(s.list.mock.calls.every(([input]) => input.cursor === undefined)).toBe(true)
    if (action === 'collapse') expect(s.ui.rows()).toHaveLength(5)
  },
)

it.each(['summary', 'page'] as const)(
  'does not append with an old cursor after a failed %s refresh',
  async (phase) => {
    const s = setup()
    await s.ui.refresh()
    const summary = deferred<SessionGroupsResult>()
    const initial = await s.groups()
    s.groups.mockImplementationOnce(() => summary.promise)
    if (phase === 'page') s.list.mockRejectedValueOnce(new Error('offline'))
    const refresh = s.ui.refresh(true)
    const more = s.ui.action('a', 'more')
    if (phase === 'summary') summary.reject(new Error('offline'))
    else summary.resolve(initial)
    await Promise.all([refresh, more])
    expect(s.list.mock.calls.every(([input]) => input.cursor === undefined)).toBe(true)
    expect(s.ui.rows()).toHaveLength(5)
  },
)

it('waits for changes received during a summary read and preserves a queued metadata refresh', async () => {
  const loading: boolean[] = []
  const s = setup(() => loading.push(s.ui.snapshot().groups[0]?.loading === true))
  await s.ui.refresh()
  loading.length = 0
  const late = deferred<SessionGroupsResult>()
  s.groups.mockImplementationOnce(() => late.promise)
  const pending = s.ui.refresh()
  await Promise.resolve()
  s.ui.invalidateSession('a0')
  const metadata = s.ui.refresh(true)
  s.list.mockResolvedValueOnce({ items: [row(99)], total: 1, revision: 'v2' })
  s.revision('v2')
  late.resolve({ items: [], ready: true })
  await Promise.all([pending, metadata])
  expect(s.ui.rows()).toEqual([row(99)])
  expect(s.ui.snapshot().loading).toBe(false)
  expect(s.ui.snapshot().groups[0]).toMatchObject({ loading: false, stale: false, revision: 'v2' })
  expect(loading.at(-1)).toBe(false)
  expect(loading.slice(0, -1).every(Boolean)).toBe(true)
})

it('opens the created session group without rereading a freshly loaded first page', async () => {
  const s = setup()
  await s.ui.refresh()
  s.ui.invalidateSession('a99')
  s.list.mockResolvedValueOnce({ items: [row(99)], total: 1, revision: 'v2' })
  s.revision('v2')
  await s.ui.created('a')
  expect(s.ui.rows()).toEqual([row(99)])
  expect(s.list).toHaveBeenCalledTimes(2)
  await s.ui.created('b')
  expect(s.ui.snapshot().groups[1]).toMatchObject({ opened: true, loaded: true, loading: false })
})

it('keeps the pages a user had open when a created session rereads the first page', async () => {
  const s = setup()
  await s.ui.refresh()
  await s.ui.action('a', 'more')
  expect(s.ui.rows()).toHaveLength(10)
  s.revision('v2')
  await s.ui.created('a')
  // The new session refreshes the group's rows; the pages that were already open come back.
  expect(s.ui.rows()).toHaveLength(10)
  expect(s.ui.snapshot().groups[0]).toMatchObject({
    opened: true,
    stale: false,
    next: '10',
    revision: 'v2',
  })
})

it('keeps the pages a user had open when a message rereads the group', async () => {
  const s = setup()
  await s.ui.refresh()
  await s.ui.action('a', 'more')
  await s.ui.action('a', 'more')
  expect(s.ui.rows()).toHaveLength(15)
  // 发消息会让该组失效：列表刷新重读首页后，用户展开的页数要补回来，不能折回收起状态。
  s.ui.invalidateSession('a0')
  s.revision('v2')
  await s.ui.refresh()
  expect(s.ui.rows()).toHaveLength(15)
  expect(s.ui.snapshot().groups[0]).toMatchObject({
    opened: true,
    stale: false,
    revision: 'v2',
    next: '15',
  })
})

it('recovers from a stale cursor and restores the pages requested by the more action', async () => {
  const s = setup()
  await s.ui.refresh()
  await s.ui.action('a', 'more')
  s.list.mockRejectedValueOnce({ data: { code: 'SESSION_SIDEBAR_CURSOR_STALE' } })
  await s.ui.action('a', 'more')
  expect(s.ui.rows()).toHaveLength(15)
  expect(s.ui.snapshot().groups[0]).toMatchObject({ stale: false, loading: false })
  expect(s.list.mock.calls.slice(-3).map(([input]) => input.cursor)).toEqual([undefined, '5', '10'])
})

it('fences in-flight pages on reconnect and local messages without replacing manual selection', async () => {
  const s = setup()
  await s.ui.refresh()
  const late = deferred<PageSessionMeta>()
  s.list.mockImplementationOnce(() => late.promise)
  const loading = s.ui.action('a', 'more')
  await Promise.resolve()
  s.ui.invalidateSession('a0')
  late.resolve({ items: [row(5)], total: 17, revision: 'v1' })
  await loading
  expect(s.ui.rows()).toHaveLength(5)
  const afterReset = deferred<SessionGroupsResult>()
  s.groups.mockImplementationOnce(() => afterReset.promise)
  const refresh = s.ui.refresh()
  await Promise.resolve()
  s.ui.reset()
  afterReset.resolve({ items: [], ready: true })
  await refresh
  expect(s.ui.snapshot().groups).toHaveLength(2)
  await s.ui.action('b', 'toggle')
  await s.ui.refresh()
  expect(s.ui.snapshot().groups[1]?.opened).toBe(true)
})

it('waits for all summaries before default expansion and does not override a manual choice', async () => {
  const s = setup()
  s.ready(false)
  await s.ui.refresh()
  expect(s.list).not.toHaveBeenCalled()
  await s.ui.action('b', 'toggle')
  s.ready(true)
  await s.ui.refresh()
  expect(s.ui.snapshot().groups.map((g) => g.opened)).toEqual([false, true])
  expect(s.list).toHaveBeenCalledTimes(1)
  const second = setup()
  second.ready(false)
  await second.ui.refresh()
  second.ready(true)
  await second.ui.refresh()
  expect(second.ui.snapshot().groups.map((g) => g.opened)).toEqual([true, false])
})

it('shows the pinned area open without taking the default expansion from the first workspace', async () => {
  const s = setup()
  const summary = s.groups.getMockImplementation()!
  s.groups.mockImplementation(async () => {
    const result = await summary()
    return { ...result, items: [{ ...result.items[0]!, groupId: 'pinned', total: 2 }, ...result.items] }
  })
  await s.ui.refresh()
  expect(s.ui.snapshot().groups.map((g) => [g.groupId, g.opened, g.items.length])).toEqual([
    ['pinned', true, 5],
    ['a', true, 5],
    ['b', false, 0],
  ])
  expect(s.list.mock.calls.map(([input]) => input.sidebar.groupId).sort()).toEqual(['a', 'pinned'])
  // A pin changes the revision of both groups; one refresh rereads each of them.
  s.revision('v2')
  await s.ui.refresh()
  expect(
    s.list.mock.calls
      .map(([input]) => input.sidebar.groupId)
      .slice(2)
      .sort(),
  ).toEqual(['a', 'pinned'])
})

it('never expands the chats group by default, only the first workspace', async () => {
  const groups = vi.fn(
    async (): Promise<SessionGroupsResult> => ({
      ready: true,
      items: [
        {
          groupId: 'chats',
          workspaceId: 'chats',
          total: 3,
          lastMessageAt: null,
          revision: 'v1',
          ready: true,
        },
        { groupId: 'a', workspaceId: 'a', total: 17, lastMessageAt: null, revision: 'v1', ready: true },
      ],
    }),
  )
  const list = vi.fn(
    async (input: { sidebar: { groupId: string } }): Promise<PageSessionMeta> => ({
      items: [row(0, input.sidebar.groupId)],
      total: 1,
      revision: 'v1',
    }),
  )
  const ui = createSidebarPagination(
    { groups, list },
    () => {},
    () => 'Failed',
    (group) => group.workspaceId === 'chats',
  )
  await ui.refresh()
  expect(ui.snapshot().groups.map((group) => [group.groupId, group.opened])).toEqual([
    ['chats', false],
    ['a', true],
  ])
})

it('rereads an expanded group off-screen and commits the pages in one render', async () => {
  const lengths: number[] = []
  let observe = () => {}
  const s = setup(() => observe())
  observe = () => lengths.push(s.ui.snapshot().groups[0]?.items.length ?? 0)
  await s.ui.refresh()
  await s.ui.action('a', 'more')
  await s.ui.action('a', 'more')
  expect(s.ui.rows()).toHaveLength(15)
  // A new session lands in the group: the summary revision changes and every row moves down one.
  s.revision('v2')
  s.list.mockImplementation(
    async (input: { sidebar: { groupId: string }; cursor?: string }): Promise<PageSessionMeta> => {
      const start = Number(input.cursor ?? 0)
      return {
        items: Array.from({ length: Math.min(5, 17 - start) }, (_, i) =>
          row(100 + start + i, input.sidebar.groupId),
        ),
        total: 17,
        revision: 'v2',
        ...(start + 5 < 17 ? { next: String(start + 5) } : {}),
      }
    },
  )
  lengths.length = 0
  await s.ui.refresh()
  // The one-page intermediate state never renders: no render shows fewer rows than before.
  expect(lengths.filter((length) => length < 15)).toEqual([])
  expect(s.ui.rows()).toHaveLength(15)
  expect(s.ui.rows()[0]?.sessionId).toBe('a100')
  expect(s.ui.snapshot().groups[0]).toMatchObject({ total: 17, next: '15', opened: true })
})

it.each([14, 9, 0])('removes archived rows when a reread group shrinks to %i rows', async (remaining) => {
  const lengths: number[] = []
  let observe = () => {}
  const s = setup(() => observe())
  observe = () => lengths.push(s.ui.snapshot().groups[0]?.items.length ?? 0)
  let total = 15
  s.list.mockImplementation(
    async (input: { sidebar: { groupId: string }; cursor?: string }): Promise<PageSessionMeta> => {
      const start = Number(input.cursor ?? 0)
      return {
        items: Array.from({ length: Math.max(0, Math.min(5, total - start)) }, (_, i) =>
          row(start + i, input.sidebar.groupId),
        ),
        total,
        revision: 'v1',
        ...(start + 5 < total ? { next: String(start + 5) } : {}),
      }
    },
  )
  await s.ui.refresh()
  await s.ui.action('a', 'more')
  await s.ui.action('a', 'more')
  expect(s.ui.rows()).toHaveLength(15)
  // Archive changes may remove one row, an entire page, or the entire group.
  total = remaining
  s.revision('v2')
  lengths.length = 0
  await s.ui.refresh()
  expect(lengths.filter((length) => length === 5)).toEqual([])
  expect(s.ui.rows()).toHaveLength(remaining)
  expect(lengths.at(-1)).toBe(remaining)
})
