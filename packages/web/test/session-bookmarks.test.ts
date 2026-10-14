import type { PageSessionMeta, SessionPreferences } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createSessionBookmarks } from '../src/app/session-bookmarks.js'

type Row = PageSessionMeta['items'][number]
const row = (sessionId: string, bookmarks?: string[]): Row => ({
  sessionId,
  createdAt: '2026-10-14T00:00:00.000Z',
  lastSeq: 1,
  generation: 1,
  preset: 'default',
  ...(bookmarks ? { bookmarks } : {}),
})

describe('session bookmarks', () => {
  it('reads the listed session and keeps one empty list for a session without bookmarks', () => {
    const rows = [row('s1', ['u1']), row('s2')]
    const store = createSessionBookmarks({ rows: () => rows, save: vi.fn(), changed: vi.fn() })
    expect(store.read('s1')?.bookmarks).toEqual(['u1'])
    expect(store.read('s2')?.bookmarks).toEqual([])
    expect(store.read('s2')?.bookmarks).toBe(store.read('s2')?.bookmarks)
  })

  it('saves the whole list for the session and shows what the daemon kept', async () => {
    const rows = [row('s1', ['u1'])]
    const save = vi.fn(
      async (_id: string, list: readonly string[]): Promise<SessionPreferences> => ({
        archived: false,
        bookmarks: [...list],
      }),
    )
    const changed = vi.fn()
    const store = createSessionBookmarks({ rows: () => rows, save, changed })
    await store.read('s1')?.setBookmarks(['u1', 'u3'])
    expect(save).toHaveBeenCalledWith('s1', ['u1', 'u3'])
    expect(rows[0]?.bookmarks).toEqual(['u1', 'u3'])
    expect(store.read('s1')?.bookmarks).toEqual(['u1', 'u3'])
    expect(changed).toHaveBeenCalledTimes(1)

    await store.read('s9')?.setBookmarks(['u7'])
    expect(store.read('s9')?.bookmarks).toEqual(['u7'])
  })

  it('keeps the old list when saving fails and drops the control on a daemon without the method', async () => {
    const rows = [row('s1', ['u1'])]
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(Object.assign(new Error('nope'), { code: -32601 }))
    const store = createSessionBookmarks({ rows: () => rows, save, changed: vi.fn() })
    await expect(store.read('s1')?.setBookmarks([])).rejects.toThrow('offline')
    expect(store.read('s1')?.bookmarks).toEqual(['u1'])
    await expect(store.read('s1')?.setBookmarks([])).rejects.toThrow('nope')
    expect(store.read('s1')).toBeUndefined()
  })
})
