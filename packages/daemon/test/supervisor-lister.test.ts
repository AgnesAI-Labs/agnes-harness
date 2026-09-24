import { describe, expect, it } from 'vitest'
import { MemorySessionWorkspaces } from '../src/storage/lister.js'
import { supervisorLister } from '../src/supervisor/supervisor.js'

// No live workers: every row comes from the durable workspace projection.
const idle = {
  keys: () => [],
  get: () => undefined,
  status: async () => ({ lastSeq: 0, preset: null }),
} as never

const event = (seq: number, type: string, ts: string) =>
  ({
    seq,
    ts,
    id: `id-${seq}`,
    type,
    data: type === 'session/start' ? { preset: 'standard' } : {},
    actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    origin: 'system',
    trust: 'trusted',
  }) as never

function seeded(): MemorySessionWorkspaces {
  const workspaces = new MemorySessionWorkspaces()
  const add = (key: string, created: string, chatted?: string) => {
    workspaces.put(key, '/w')
    workspaces.observe(key, event(1, 'session/start', created))
    if (chatted) workspaces.observe(key, event(2, 'user/message', chatted))
  }
  add('c-old-chatted-now', '2026-09-01T00:00:00.000Z', '2026-09-21T10:00:00.000Z')
  add('a-new-silent', '2026-09-21T09:00:00.000Z')
  add('b-tie', '2026-09-20T00:00:00.000Z')
  add('a-tie', '2026-09-20T00:00:00.000Z')
  add('z-chatted-long-ago', '2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z')
  // Bound but not yet projected: no creation time to rank by.
  workspaces.put('no-projection', '/w')
  return workspaces
}

const expected = [
  'c-old-chatted-now',
  'a-new-silent',
  'a-tie',
  'b-tie',
  'z-chatted-long-ago',
  'no-projection',
]

describe('supervisorLister', () => {
  it('orders by the latest user message, then creation time, ties and unprojected rows last', async () => {
    const page = await supervisorLister(idle, seeded()).list({ limit: 50 })
    expect(page.items.map((row) => row.sessionId)).toEqual(expected)
    expect(page.cursor).toBeUndefined()
  })

  it('pages through the recency order without repeating or skipping a row', async () => {
    const lister = supervisorLister(idle, seeded())
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await lister.list({ limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...page.items.map((row) => row.sessionId))
      cursor = page.cursor
    } while (cursor)
    expect(seen).toEqual(expected)
  })

  it('rejects a cursor it did not issue, including the old bare-key form', async () => {
    const lister = supervisorLister(idle, seeded())
    for (const cursor of ['a-tie', '[1,2]', '["only-one"]'])
      await expect(lister.list({ cursor })).rejects.toMatchObject({
        code: -32602,
        data: { code: 'INVALID_PARAMS' },
      })
  })

  it('applies the owner scope before ordering', async () => {
    const page = await supervisorLister(idle, seeded()).list({
      sessionIds: ['z-chatted-long-ago', 'a-new-silent'],
    })
    expect(page.items.map((row) => row.sessionId)).toEqual(['a-new-silent', 'z-chatted-long-ago'])
  })
})
