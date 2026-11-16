import type { WorkspaceEntry } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceSync, UNKNOWN_WORKSPACE_RETRY_MS } from '../src/workspace-sync.js'

const entry = (id: string): WorkspaceEntry => ({
  workspaceId: id.repeat(64),
  path: `/workspace/${id}`,
  name: id,
  lastUsedAt: null,
  sessionCount: 0,
  available: true,
})

/** `unread` stands for a page that has not read the list yet. */
function harness(server: WorkspaceEntry[], initial: WorkspaceEntry[] | 'unread' = [entry('a')]) {
  let rows = initial === 'unread' ? undefined : initial
  const clock = { now: 0 }
  const read = vi.fn(async () => ({ items: [...server] }))
  const apply = vi.fn((page: { items: WorkspaceEntry[] }) => {
    rows = page.items
  })
  const sync = createWorkspaceSync({ known: () => rows, read, apply, now: () => clock.now })
  return { sync, read, apply, rows: () => rows, clock, server }
}

describe('workspace sync', () => {
  it('reads the list once for a group of a workspace the page does not know, and never for known groups', async () => {
    const a = entry('a')
    const c = entry('c')
    const { sync, read, rows } = harness([a, c])
    await sync.reconcile([{ workspaceId: a.workspaceId }, {}])
    expect(read).not.toHaveBeenCalled()
    await sync.reconcile([{ workspaceId: a.workspaceId }, { workspaceId: c.workspaceId }])
    expect(read).toHaveBeenCalledOnce()
    expect(rows()).toEqual([a, c])
    await sync.reconcile([{ workspaceId: a.workspaceId }, { workspaceId: c.workspaceId }])
    expect(read).toHaveBeenCalledOnce()
  })

  it('reads nothing before the page first read the list', async () => {
    const { sync, read } = harness([entry('a')], 'unread')
    await sync.reconcile([{ workspaceId: entry('a').workspaceId }])
    expect(read).not.toHaveBeenCalled()
  })

  it('reads again for a workspace the list still lacks only after a while, and at once for one it failed to read', async () => {
    const late = entry('l')
    const { sync, read, rows, clock, server } = harness([entry('a')])
    await sync.reconcile([{ workspaceId: late.workspaceId }])
    clock.now = UNKNOWN_WORKSPACE_RETRY_MS - 1
    await sync.reconcile([{ workspaceId: late.workspaceId }])
    expect(read).toHaveBeenCalledOnce()
    // The workspace was registered meanwhile: after the wait the list is read for it again, and it is known.
    server.push(late)
    clock.now = UNKNOWN_WORKSPACE_RETRY_MS
    await sync.reconcile([{ workspaceId: late.workspaceId }])
    expect(read).toHaveBeenCalledTimes(2)
    expect(rows()).toEqual([entry('a'), late])
    clock.now = 10 * UNKNOWN_WORKSPACE_RETRY_MS
    await sync.reconcile([{ workspaceId: late.workspaceId }])
    expect(read).toHaveBeenCalledTimes(2)
    const failing = harness([entry('a'), entry('c')])
    failing.read.mockRejectedValueOnce(new Error('workspace list unavailable'))
    await failing.sync.reconcile([{ workspaceId: entry('c').workspaceId }])
    expect(failing.apply).not.toHaveBeenCalled()
    await failing.sync.reconcile([{ workspaceId: entry('c').workspaceId }])
    expect(failing.read).toHaveBeenCalledTimes(2)
    expect(failing.rows()).toEqual([entry('a'), entry('c')])
  })

  it('runs reads one after another', async () => {
    const { sync, read } = harness([entry('a'), entry('c'), entry('d')])
    let release: () => void = () => undefined
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ items: [entry('a'), entry('c')] })
        }),
    )
    const first = sync.reconcile([{ workspaceId: entry('c').workspaceId }])
    const second = sync.reconcile([{ workspaceId: entry('d').workspaceId }])
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The second waits for the first.
    expect(read).toHaveBeenCalledOnce()
    release()
    await Promise.all([first, second])
    expect(read).toHaveBeenCalledTimes(2)
  })
})
