import type { PageSessionMeta } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { createArchivedSessions } from '../src/archived-sessions.js'

type Row = PageSessionMeta['items'][number]
const row = (sessionId: string, archived: boolean): Row => ({ sessionId, archived, title: sessionId }) as Row

it('reads every page only when the archived filter is chosen, keeping archived sessions', async () => {
  const sessions = createArchivedSessions()
  const list = vi
    .fn()
    .mockResolvedValueOnce({ items: [row('a', true), row('b', false)], next: 'p2' })
    .mockResolvedValueOnce({ items: [row('c', true)] })
  sessions.bind({ list, restore: vi.fn(), changed: vi.fn() })
  expect(list).not.toHaveBeenCalled()
  const changed = vi.fn()
  sessions.subscribe(changed)
  sessions.show('archived')
  expect(sessions.getSnapshot()).toMatchObject({ filter: 'archived', status: 'loading' })
  await vi.waitFor(() => expect(sessions.getSnapshot().status).toBe('idle'))
  expect(list).toHaveBeenNthCalledWith(1, { limit: 500 })
  expect(list).toHaveBeenNthCalledWith(2, { limit: 500, cursor: 'p2' })
  expect(sessions.getSnapshot().rows.map((item) => item.sessionId)).toEqual(['a', 'c'])
  expect(changed).toHaveBeenCalled()
  sessions.show('unarchived')
  expect(sessions.getSnapshot().filter).toBe('unarchived')
})

it('restores a session, drops its row and refreshes the unarchived list', async () => {
  const sessions = createArchivedSessions()
  const restore = vi.fn().mockResolvedValue(undefined)
  const changed = vi.fn().mockResolvedValue(undefined)
  sessions.bind({ list: async () => ({ items: [row('a', true), row('c', true)] }), restore, changed })
  await sessions.reload()
  await sessions.restore('a')
  expect(restore).toHaveBeenCalledWith('a')
  expect(changed).toHaveBeenCalledTimes(1)
  expect(sessions.getSnapshot()).toMatchObject({ restoring: [], rows: [{ sessionId: 'c' }] })
  expect(sessions.getSnapshot().error).toBeUndefined()
})

it('keeps the row and says why when restoring or reading fails', async () => {
  const sessions = createArchivedSessions()
  const list = vi.fn().mockResolvedValueOnce({ items: [row('a', true)] })
  const error = vi.fn()
  sessions.bind({
    list,
    restore: vi.fn().mockRejectedValue(new Error('daemon offline')),
    changed: vi.fn(),
    error,
  })
  await sessions.reload()
  await sessions.restore('a')
  expect(sessions.getSnapshot()).toMatchObject({
    rows: [{ sessionId: 'a' }],
    restoring: [],
    error: 'daemon offline',
  })
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'daemon offline' }))
  list.mockRejectedValueOnce(new Error('list failed'))
  await sessions.reload()
  expect(sessions.getSnapshot()).toMatchObject({ status: 'error', error: 'list failed' })
})

it('does not resurrect a restored session from an older in-flight archive listing', async () => {
  const sessions = createArchivedSessions()
  let resolve!: (page: { items: Row[] }) => void
  const list = vi
    .fn()
    .mockResolvedValueOnce({ items: [row('a', true), row('b', true)] })
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    .mockResolvedValue({ items: [row('b', true)] })
  sessions.bind({ list, restore: async () => undefined, changed: async () => undefined })
  sessions.show('archived')
  await vi.waitFor(() => expect(sessions.getSnapshot().status).toBe('idle'))
  const oldRead = sessions.reload()
  await sessions.restore('a')
  resolve({ items: [row('a', true), row('b', true)] })
  await oldRead
  expect(sessions.getSnapshot()).toMatchObject({ status: 'idle', rows: [{ sessionId: 'b' }] })
})
