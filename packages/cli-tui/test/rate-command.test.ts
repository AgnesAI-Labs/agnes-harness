import { describe, expect, it } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { rateSlash } from '../src/rate-command.js'

const turn = (n: number, over: Record<string, unknown> = {}) => ({
  id: `t${n}`,
  turn: n,
  status: 'completed',
  inherited: false,
  finalAssistantId: `a${n}`,
  ...over,
})
const assistant = (n: number, over: Record<string, unknown> = {}) => ({
  kind: 'assistant',
  id: `a${n}`,
  seq: n * 10,
  streaming: false,
  text: `reply ${n}`,
  ...over,
})

function harness(
  timeline: { turns: unknown[]; nodes: unknown[] },
  answers: { list?: unknown; fail?: unknown } = {},
) {
  const calls: Array<[string, Record<string, unknown>]> = []
  const app = {
    locale: 'en',
    session: {
      id: 'sess-1',
      projectUIOpening: async () => ({ timeline }),
      client: {
        call: async (method: string, params: Record<string, unknown>) => {
          calls.push([method, params])
          if (answers.fail && params.action === 'put') throw answers.fail
          return params.action === 'list' ? (answers.list ?? { items: [] }) : { items: [] }
        },
      },
    },
  } as unknown as TuiApp
  return { app, calls }
}

describe('/rate', () => {
  it('rates the newest settled reply through admin.feedback, as the Web thumbs do', async () => {
    const { app, calls } = harness({
      turns: [turn(1), turn(2), turn(3, { status: 'running' })],
      nodes: [assistant(1), assistant(2), assistant(3, { streaming: true })],
    })
    const r = await rateSlash(app, '/rate down it ignored my instruction')
    expect(calls).toEqual([
      ['_agnes/v1/admin.feedback', { action: 'list', sessionId: 'sess-1' }],
      [
        '_agnes/v1/admin.feedback',
        {
          action: 'put',
          sessionId: 'sess-1',
          target: { messageSeq: 20, turn: 2 },
          expectedRevision: null,
          rating: 'down',
          category: '',
          note: 'it ignored my instruction',
        },
      ],
    ])
    expect(r.text).toContain('turn 2')
  })

  it('rating the same reply again updates its feedback item instead of adding one', async () => {
    const existing = { id: 'fb-1', revision: 3, target: { messageSeq: 10, turn: 1 } }
    const other = { id: 'fb-0', revision: 1, target: { messageSeq: 99, turn: 9 } }
    const { app, calls } = harness(
      { turns: [turn(1)], nodes: [assistant(1)] },
      { list: { items: [other, existing] } },
    )
    await rateSlash(app, '/rate up')
    expect(calls[1]?.[1]).toMatchObject({
      action: 'put',
      id: 'fb-1',
      expectedRevision: 3,
      rating: 'up',
      note: '',
    })
  })

  it('skips replies that are inherited, still running or without an answer', async () => {
    const { app, calls } = harness({
      turns: [
        turn(1, { inherited: true }),
        turn(2, { status: 'waiting' }),
        turn(3, { finalAssistantId: undefined }),
      ],
      nodes: [assistant(1), assistant(2)],
    })
    expect((await rateSlash(app, '/rate up')).text).toMatch(/no finished reply/i)
    expect(calls).toEqual([])
  })

  it.each([['/rate'], ['/rate sideways'], ['/rate up' + ' x'.repeat(2100)]])(
    'refuses %s without calling the daemon',
    async (line) => {
      const { app, calls } = harness({ turns: [turn(1)], nodes: [assistant(1)] })
      const r = await rateSlash(app, line)
      expect(r.text).toMatch(/usage|longer than/)
      expect(calls).toEqual([])
    },
  )

  it('reports a daemon without ratings, and rethrows any other failure', async () => {
    const timeline = { turns: [turn(1)], nodes: [assistant(1)] }
    const missing = harness(timeline, { fail: { data: { code: 'METHOD_NOT_FOUND' } } })
    expect((await rateSlash(missing.app, '/rate up')).text).toMatch(/does not support ratings/)
    const broken = harness(timeline, { fail: new Error('connection lost') })
    await expect(rateSlash(broken.app, '/rate up')).rejects.toThrow('connection lost')
  })
})
