import { describe, expect, it, vi } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { runSlash } from '../src/commands.js'
import { tt } from '../src/locale-extended.js'
import { treeChoices } from '../src/session-tree.js'

const row = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  sessionId,
  createdAt: '2026-10-01T00:00:00Z',
  lastSeq: 3,
  generation: 1,
  preset: 'standard',
  cwd: '/w/a',
  ...extra,
})
const titles = (rows: { title?: string }[]) => rows.map((r) => r.title)

describe('treeChoices', () => {
  it('nests forks under their parent, marks the open session and roots a child whose parent is missing', () => {
    const choices = treeChoices(
      [
        row('root', { title: 'Root', lastMessageAt: '2026-10-03T00:00:00Z' }),
        row('kid', { title: 'Kid', parent: 'root', forkAt: 9 }),
        row('grand', { title: 'Grand', parent: 'kid', forkAt: 4 }),
        row('orphan', { title: 'Orphan', parent: 'gone', forkAt: 2 }),
        row('self', { title: 'Self', parent: 'self', forkAt: 2 }),
      ],
      'grand',
      () => undefined,
      'en',
    )
    expect(choices.map((c) => c.sessionId)).toEqual(['root', 'kid', 'grand', 'self', 'orphan'])
    expect(titles(choices)).toEqual([
      'Root',
      '└ Kid (fork @9)',
      '│ └ ● Grand (fork @4)',
      'Self (fork @2)',
      'Orphan (fork @2)',
    ])
    // A choice only resumes: it is not a rewind row.
    expect(choices.every((c) => c.forkAt === undefined && c.draft === undefined)).toBe(true)
  })

  it('shows the turn when the parent timeline answers and @seq otherwise', () => {
    const items = [row('p', { lastMessageAt: '2026-10-03T00:00:00Z' }), row('a', { parent: 'p', forkAt: 5 })]
    expect(
      titles(treeChoices(items, 'p', (p, at) => (p === 'p' && at === 5 ? 2 : undefined), 'en'))[1],
    ).toContain(tt('tree.forkTurn', 'en', { turn: 2 }))
    expect(titles(treeChoices(items, 'p', () => undefined, 'en'))[1]).toContain('fork @5')
  })

  it('stays flat when the daemon sends no lineage, and survives a parent cycle', () => {
    expect(
      titles(
        treeChoices([row('a', { title: 'A' }), row('b', { title: 'B' })], 'x', () => undefined, 'en'),
      ).sort(),
    ).toEqual(['A', 'B'])
    const cycle = treeChoices(
      [row('a', { parent: 'b', forkAt: 1 }), row('b', { parent: 'a', forkAt: 1 })],
      'x',
      () => undefined,
      'en',
    )
    expect(cycle.map((c) => c.sessionId).sort()).toEqual(['a', 'b'])
  })
})

describe('/tree', () => {
  it('pages the list, keeps this workspace, and names the turn only for forks of the open session', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        items: [row('cur', { title: 'Open' }), row('far', { cwd: '/w/other' })],
        next: 'c1',
      })
      .mockResolvedValueOnce({ items: [row('kid', { title: 'Kid', parent: 'cur', forkAt: 6 })] })
    const projectUIOpening = vi.fn(async () => ({ timeline: { turns: [{ turn: 2, endSeq: 6 }] } }))
    const app = {
      cwd: '/w/a',
      locale: 'en',
      refuseSwitch: () => false,
      o: {},
      session: { id: 'cur', client: { session: { list } }, projectUIOpening },
    } as unknown as TuiApp
    const result = await runSlash(app, '/tree')
    expect(result.sessionPickerTitle).toBe('picker.treeTitle')
    expect(titles(result.sessionChoices ?? [])).toEqual(['● Open', '└ Kid (fork of turn 2)'])
    expect(list.mock.calls.map(([o]) => o)).toEqual([{ limit: 500 }, { limit: 500, cursor: 'c1' }])
  })

  it('stops paging at 2000 sessions and refuses a cursor that does not advance', async () => {
    const page = (n: number) => ({
      items: Array.from({ length: 500 }, (_, i) => row(`s${n}-${i}`)),
      next: `c${n}`,
    })
    const list = vi.fn(async (o: { cursor?: string }) => page(Number(o.cursor?.slice(1) ?? 0) + 1))
    const app = {
      cwd: '/w/a',
      locale: 'en',
      o: {},
      session: { id: 'cur', client: { session: { list } } },
    } as unknown as TuiApp
    expect((await runSlash(app, '/tree')).sessionChoices).toHaveLength(2000)
    expect(list).toHaveBeenCalledTimes(4)
    const stuck = vi.fn(async () => ({ items: [row('a')], next: 'same' }))
    await expect(
      runSlash(
        { ...app, session: { id: 'cur', client: { session: { list: stuck } } } } as unknown as TuiApp,
        '/tree',
      ),
    ).rejects.toThrow('did not advance')
  })
})
