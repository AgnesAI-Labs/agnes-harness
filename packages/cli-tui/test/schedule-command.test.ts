import { describe, expect, it } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { scheduleSlash } from '../src/schedule-commands.js'

const view = (id: string) => ({
  id,
  title: 'check the build',
  prompt: 'check the build',
  selector: { every_seconds: 300 },
  target: { kind: 'session', sessionKey: 'key-1' },
  status: 'active',
  nextRunAt: 1_800_000_000_000,
  revision: 1,
  runs: [],
})

function harness(answers: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = []
  const session = {
    id: 'sess-1',
    client: {
      session: { runtime: async () => ({ sessionKey: 'key-1' }) },
      call: async (method: string, params: unknown) => {
        calls.push([method, params])
        return answers[method]
      },
    },
  }
  const app = { locale: 'en', session } as unknown as TuiApp
  return { app, calls }
}

describe('/loop and /schedule', () => {
  it('shows a card with interval, prompt and session, and creates only after confirm', async () => {
    const { app, calls } = harness({ '_agnes/v1/schedules.upsert': view('sched_0123456789abcdef') })
    const card = await scheduleSlash(app, '/loop', '/loop 5m check the build')
    expect(card.text).toContain('every 5m')
    expect(card.text).toContain('check the build')
    expect(card.text).toContain('sess-1')
    expect(calls).toEqual([])
    const done = await scheduleSlash(app, '/loop', '/loop confirm')
    expect(calls).toEqual([
      [
        '_agnes/v1/schedules.upsert',
        {
          title: 'check the build',
          prompt: 'check the build',
          selector: { every_seconds: 300 },
          target: { kind: 'session', sessionKey: 'key-1' },
        },
      ],
    ])
    expect(done.text).toContain('sched_0123456789abcdef')
    expect((await scheduleSlash(app, '/schedule', '/schedule confirm')).text).toMatch(/nothing to confirm/i)
  })

  it('cancel drops the card; a refusal is shown with its code', async () => {
    const { app, calls } = harness({ '_agnes/v1/schedules.upsert': { updated: false, code: 'quota' } })
    await scheduleSlash(app, '/loop', '/loop 1h ping')
    await scheduleSlash(app, '/loop', '/loop cancel')
    expect((await scheduleSlash(app, '/loop', '/loop confirm')).text).toMatch(/nothing to confirm/i)
    await scheduleSlash(app, '/loop', '/loop 1h ping')
    expect((await scheduleSlash(app, '/loop', '/loop confirm')).text).toContain('quota')
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['/loop', '/loop 10s ping', /not a valid interval/i],
    ['/loop', '/loop soon ping', /not a valid interval/i],
    ['/loop', '/loop 5m', /usage: \/loop/],
    ['/loop', '/loop', /usage: \/loop/],
    ['/schedule', '/schedule every 400d ping', /not a valid interval/i],
    ['/schedule', '/schedule daily 25:00 ping', /usage: \/schedule/],
    ['/schedule', '/schedule weekly mon ping', /usage: \/schedule/],
  ] as const)('%s: %s proposes nothing', async (cmd, line, text) => {
    const { app, calls } = harness()
    expect((await scheduleSlash(app, cmd, line)).text).toMatch(text)
    expect((await scheduleSlash(app, '/schedule', '/schedule confirm')).text).toMatch(/nothing to confirm/i)
    expect(calls).toEqual([])
  })

  it('daily builds the daily selector in the local zone', async () => {
    const { app, calls } = harness({ '_agnes/v1/schedules.upsert': view('sched_aaaaaaaaaaaaaaaa') })
    await scheduleSlash(app, '/schedule', '/schedule daily 09:30 write the standup')
    await scheduleSlash(app, '/schedule', '/schedule confirm')
    const [, params] = calls[0] as [string, { selector: { daily: { time: string; timeZone: string } } }]
    const { selector } = params
    expect(selector.daily.time).toBe('09:30')
    expect(selector.daily.timeZone).toBeTruthy()
  })

  it("lists this session's schedules and deletes one by number or id", async () => {
    const { app, calls } = harness({
      '_agnes/v1/schedules.list': {
        schedules: [view('sched_1111111111111111'), view('sched_2222222222222222')],
      },
      '_agnes/v1/schedules.archive': { deleted: true },
    })
    const listed = await scheduleSlash(app, '/schedule', '/schedule')
    expect(listed.text).toContain('1. sched_1111111111111111')
    expect(listed.text).toContain('2. sched_2222222222222222')
    expect(calls[0]).toEqual(['_agnes/v1/schedules.list', { scope: 'session', sessionKey: 'key-1' }])
    await scheduleSlash(app, '/schedule', '/schedule delete 2')
    expect(calls.at(-1)).toEqual(['_agnes/v1/schedules.archive', { id: 'sched_2222222222222222' }])
    expect((await scheduleSlash(app, '/schedule', '/schedule delete 9')).text).toMatch(/no schedule 9/i)
  })
})
