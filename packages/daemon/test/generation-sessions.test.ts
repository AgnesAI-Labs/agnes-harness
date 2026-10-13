import { type PluginGenerationStatus, validatePackageAdminCall } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { describeGenerationSessions } from '../src/supervisor/generation-sessions.js'

const id = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`
const status: PluginGenerationStatus = {
  currentGenerationId: id('b'),
  generations: [
    {
      id: id('a'),
      state: 'draining',
      boundSessions: 3,
      openSessions: 2,
      live: true,
      packages: [],
      sessions: [
        { key: 'busy', open: true },
        { key: 'quiet', open: true },
        { key: 'closed', open: false },
      ],
    },
    { id: id('b'), state: 'active', boundSessions: 0, openSessions: 0, live: true, packages: [] },
  ],
  plugins: [],
}
const row = (sessionId: string, title?: string) => ({
  sessionId,
  createdAt: '',
  lastSeq: 1,
  generation: 1,
  preset: null,
  ...(title ? { title } : {}),
})

it('names each held session and says which are mid-turn, following the lister across pages', async () => {
  const queries: unknown[] = []
  const described = await describeGenerationSessions(status, {
    lister: {
      async list(query) {
        queries.push(query)
        return query.cursor
          ? { items: [row('closed', 'Quarterly report'), row('quiet')] }
          : { items: [row('busy', 'Refund policy')], cursor: 'next' }
      },
    },
    running: (key) => key === 'busy',
  })
  expect(queries).toEqual([
    { sessionIds: ['busy', 'quiet', 'closed'], limit: 256 },
    { sessionIds: ['busy', 'quiet', 'closed'], limit: 256, cursor: 'next' },
  ])
  expect(described.generations[0]?.sessions).toEqual([
    { key: 'busy', open: true, title: 'Refund policy', run: 'running' },
    // An untitled session keeps its key; a session that is not open is idle.
    { key: 'quiet', open: true, run: 'idle' },
    { key: 'closed', open: false, title: 'Quarterly report', run: 'idle' },
  ])
  expect(described.generations[1]).toEqual(status.generations[1])
  expect(validatePackageAdminCall('_agnes/v1/plugins.generations', 'result', described).ok).toBe(true)
})

it('keeps the list usable by key when titles cannot be read, and asks nothing when no session is held', async () => {
  const unreadable = await describeGenerationSessions(status, {
    lister: {
      async list() {
        throw new Error('ledger unavailable')
      },
    },
    running: () => false,
  })
  expect(unreadable.generations[0]?.sessions).toEqual([
    { key: 'busy', open: true, run: 'idle' },
    { key: 'quiet', open: true, run: 'idle' },
    { key: 'closed', open: false, run: 'idle' },
  ])
  let asked = 0
  const empty = {
    ...status,
    generations: [status.generations[1] as PluginGenerationStatus['generations'][number]],
  }
  await describeGenerationSessions(empty, {
    lister: {
      async list() {
        asked++
        return { items: [] }
      },
    },
    running: () => false,
  })
  expect(asked).toBe(0)
})
