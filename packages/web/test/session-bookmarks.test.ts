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
    // Once to show the change, once when the saved list arrives.
    expect(changed).toHaveBeenCalledTimes(2)

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

  describe('one save at a time per session', () => {
    /** A save the test answers by hand, recording each list sent. */
    function manualSave() {
      const sent: string[][] = []
      const answers: { ok: (value: SessionPreferences) => void; fail: (error: unknown) => void }[] = []
      const save = vi.fn(
        (_id: string, list: readonly string[]) =>
          new Promise<SessionPreferences>((ok, fail) => {
            sent.push([...list])
            answers.push({ ok, fail })
          }),
      )
      const answer = async (index: number, error?: unknown) => {
        const reply = answers[index]
        if (!reply) throw new Error(`no request ${index}`)
        if (error) reply.fail(error)
        else reply.ok({ archived: false, bookmarks: sent[index] ?? [] })
        await new Promise((done) => setTimeout(done, 0))
      }
      return { save, sent, answer }
    }
    const flush = () => new Promise((done) => setTimeout(done, 0))

    it('keeps every bookmark when an earlier response lands between toggles (add A, add B, A answers, add C)', async () => {
      const rows = [row('s1')]
      const { save, sent, answer } = manualSave()
      const store = createSessionBookmarks({ rows: () => rows, save, changed: vi.fn() })
      const toggle = (id: string) => {
        const shown = store.read('s1')?.bookmarks ?? []
        return store.read('s1')?.setBookmarks([...shown, id])
      }
      const a = toggle('A')
      await flush()
      const b = toggle('B')
      await flush()
      // B waits for A instead of racing it.
      expect(sent).toEqual([['A']])
      await answer(0)
      // A's response does not replace the newer list on screen.
      expect(store.read('s1')?.bookmarks).toEqual(['A', 'B'])
      const c = toggle('C')
      expect(store.read('s1')?.bookmarks).toEqual(['A', 'B', 'C'])
      await answer(1)
      expect(store.read('s1')?.bookmarks).toEqual(['A', 'B', 'C'])
      await answer(2)
      await Promise.all([a, b, c])
      expect(sent).toEqual([['A'], ['A', 'B'], ['A', 'B', 'C']])
      expect(rows[0]?.bookmarks).toEqual(['A', 'B', 'C'])
      expect(store.read('s1')?.bookmarks).toEqual(['A', 'B', 'C'])
    })

    it('sends only the newest list for changes queued behind a running save', async () => {
      const rows = [row('s1')]
      const { save, sent, answer } = manualSave()
      const store = createSessionBookmarks({ rows: () => rows, save, changed: vi.fn() })
      const first = store.read('s1')?.setBookmarks(['A'])
      await flush()
      const second = store.read('s1')?.setBookmarks(['A', 'B'])
      const third = store.read('s1')?.setBookmarks(['A', 'B', 'C'])
      await answer(0)
      await answer(1)
      await Promise.all([first, second, third])
      expect(sent).toEqual([['A'], ['A', 'B', 'C']])
      expect(rows[0]?.bookmarks).toEqual(['A', 'B', 'C'])
    })

    it('a failed older save does not roll back a newer change, which is still saved', async () => {
      const rows = [row('s1', ['X'])]
      const { save, sent, answer } = manualSave()
      const store = createSessionBookmarks({ rows: () => rows, save, changed: vi.fn() })
      const first = store.read('s1')?.setBookmarks(['X', 'A'])
      await flush()
      const second = store.read('s1')?.setBookmarks(['X', 'A', 'B'])
      await answer(0, new Error('offline'))
      await expect(first).rejects.toThrow('offline')
      expect(store.read('s1')?.bookmarks).toEqual(['X', 'A', 'B'])
      await answer(1)
      await second
      expect(sent).toEqual([
        ['X', 'A'],
        ['X', 'A', 'B'],
      ])
      expect(store.read('s1')?.bookmarks).toEqual(['X', 'A', 'B'])
    })

    it('a failed newest save puts the last saved list back and fails every change it carried', async () => {
      const rows = [row('s1', ['X'])]
      const { save, sent, answer } = manualSave()
      const store = createSessionBookmarks({ rows: () => rows, save, changed: vi.fn() })
      const first = store.read('s1')?.setBookmarks(['X', 'A'])
      await flush()
      const second = store.read('s1')?.setBookmarks(['X', 'A', 'B'])
      const third = store.read('s1')?.setBookmarks(['X', 'A', 'B', 'C'])
      await answer(0)
      await first
      await answer(1, new Error('offline'))
      await expect(second).rejects.toThrow('offline')
      await expect(third).rejects.toThrow('offline')
      expect(sent).toEqual([
        ['X', 'A'],
        ['X', 'A', 'B', 'C'],
      ])
      expect(store.read('s1')?.bookmarks).toEqual(['X', 'A'])
      // A later change starts from the saved list and saves normally.
      const fourth = store.read('s1')?.setBookmarks(['X', 'A', 'D'])
      await flush()
      await answer(2)
      await fourth
      expect(rows[0]?.bookmarks).toEqual(['X', 'A', 'D'])
    })

    it('keeps sessions apart', async () => {
      const rows = [row('s1'), row('s2')]
      const { save, sent, answer } = manualSave()
      const store = createSessionBookmarks({ rows: () => rows, save, changed: vi.fn() })
      const one = store.read('s1')?.setBookmarks(['A'])
      const two = store.read('s2')?.setBookmarks(['B'])
      await flush()
      expect(sent).toEqual([['A'], ['B']])
      await answer(0)
      await answer(1)
      await Promise.all([one, two])
      expect(rows.map((item) => item.bookmarks)).toEqual([['A'], ['B']])
    })
  })
})
