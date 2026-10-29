import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@agnes/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { schedulesCommand } from '../src/commands/schedules.js'
import { FakeEndpoint } from './fake-endpoint.js'

const clients: Array<Awaited<ReturnType<typeof createClient>>> = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
})

const view = (over: Record<string, unknown> = {}) => ({
  id: 'sched_0123456789abcdef',
  title: 'nightly\u001b[31m\nreport',
  prompt: 'summarise\nthe day',
  selector: { every_seconds: 60 },
  target: { kind: 'new-session', cwd: '/work' },
  status: 'active',
  nextRunAt: 1_800_000_000_000,
  revision: 1,
  runs: [{ at: 1_800_000_000_000, outcome: 'ran', reason: 'x\u001b[1m' }],
  ...over,
})

type Replies = Record<string, unknown | Error>
async function run(argv: string[], replies: Replies) {
  const endpoint = new FakeEndpoint()
  endpoint.on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
  for (const [method, reply] of Object.entries(replies))
    endpoint.on(`_agnes/v1/schedules.${method}`, () => {
      if (reply instanceof Error) throw reply
      return reply
    })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  clients.push(client)
  let out = ''
  let err = ''
  const exit = await schedulesCommand(parseArgs(argv), client, {
    stdout: { write: (t: string) => (out += t) } as never,
    stderr: { write: (t: string) => (err += t) } as never,
  }).catch((e: Error) => e)
  const calls = endpoint.calls.filter((c) => c.method.startsWith('_agnes/v1/schedules.'))
  return { exit, out, err, calls: calls.map((c) => [c.method.split('.')[1], c.params]) }
}

const sent = (r: { calls: unknown[][] }) => r.calls[0]?.[1] as { selector: unknown }

describe('schedules command', () => {
  it('list reads all schedules by default, narrows by --session, and prints one inert line each', async () => {
    const all = await run(['schedules'], { list: { schedules: [view()] } })
    expect(all.calls).toEqual([['list', { scope: 'all' }]])
    expect(all.out).toBe(
      'sched_0123456789abcdef\tactive\tevery_seconds 60\t2027-01-15T08:00:00.000Z\tran\tnightly[31m report\n',
    )
    const one = await run(['schedules', 'list', '--session', 's1', '--archived', '--json'], {
      list: { schedules: [] },
    })
    expect(one.calls).toEqual([['list', { scope: 'session', sessionKey: 's1', includeArchived: true }]])
    expect(one.out).toBe(`${JSON.stringify({ schedules: [] })}\n`)
    expect((await run(['schedules', 'list'], { list: { schedules: [] } })).out).toBe('no schedules\n')
  })

  it('show finds one schedule with its run records, and exits 1 for an unknown id', async () => {
    const r = await run(['schedules', 'show', 'sched_0123456789abcdef'], { list: { schedules: [view()] } })
    expect(r.calls).toEqual([['list', { scope: 'all', includeArchived: true }]])
    expect(r.out).toContain('prompt     summarise the day')
    expect(r.out).toContain('2027-01-15T08:00:00.000Z\tran\tx[1m')
    const missing = await run(['schedules', 'show', 'sched_ffffffffffffffff'], {
      list: { schedules: [view()] },
    })
    expect(missing.exit).toBe(1)
    expect(missing.err).toBe('no schedule sched_ffffffffffffffff\n')
  })

  it('add sends the selector the flag names, a derived title and the new-session target', async () => {
    const reply = { list: { schedules: [] }, upsert: view() }
    const cwd = join(tmpdir(), 'agnes-schedule-测试')
    const every = await run(
      ['schedules', 'add', '--prompt', 'ping the team', '--every', '30m', '--cwd', cwd],
      reply,
    )
    expect(every.calls).toEqual([
      [
        'upsert',
        {
          title: 'ping the team',
          prompt: 'ping the team',
          selector: { every_seconds: 1800 },
          target: { kind: 'new-session', cwd },
        },
      ],
    ])
    const weekly = await run(
      [
        'schedules',
        'add',
        '--prompt',
        'p',
        '--title',
        'T',
        '--weekly',
        'mon,sun@09:30',
        '--tz',
        'Asia/Shanghai',
        '--session',
        's1',
        '--unattended',
        'refuse',
      ],
      reply,
    )
    expect(weekly.calls[0]?.[1]).toEqual({
      title: 'T',
      prompt: 'p',
      selector: { weekly: { time: '09:30', timeZone: 'Asia/Shanghai', weekdays: [0, 1] } },
      target: { kind: 'session', sessionKey: 's1', unattendedApproval: 'refuse' },
    })
    const cron = await run(
      ['schedules', 'add', '--prompt', 'p', '--cron', '0 9 * * 1-5', '--tz', 'UTC', '--cwd', '/w'],
      reply,
    )
    expect(sent(cron).selector).toEqual({
      cron: { expr: '0 9 * * 1-5', timeZone: 'UTC' },
    })
    const at = await run(
      ['schedules', 'add', '--prompt', 'p', '--at', '2030-01-01T00:00:00Z', '--cwd', '/w'],
      reply,
    )
    expect(sent(at).selector).toEqual({ at: '2030-01-01T00:00:00.000Z' })
    const daily = await run(
      ['schedules', 'add', '--prompt', 'p', '--daily', '08:00', '--tz', 'UTC', '--cwd', '/w', '--json'],
      reply,
    )
    expect(daily.out).toBe(`${JSON.stringify(view())}\n`)
  })

  it('add rejects bad or conflicting flags before any request', async () => {
    for (const argv of [
      ['schedules', 'add', '--every', '30m'],
      ['schedules', 'add', '--prompt', 'p'],
      ['schedules', 'add', '--prompt', 'p', '--every', '30m', '--cron', '* * * * *'],
      ['schedules', 'add', '--prompt', 'p', '--every', '10s'],
      ['schedules', 'add', '--prompt', 'p', '--every', '30m', '--tz', 'UTC'],
      ['schedules', 'add', '--prompt', 'p', '--at', 'tomorrow-ish'],
      ['schedules', 'add', '--prompt', 'p', '--daily', '25:00'],
      ['schedules', 'add', '--prompt', 'p', '--weekly', 'mon'],
      ['schedules', 'add', '--prompt', 'p', '--every', '1h', '--session', 's', '--new-session'],
      ['schedules', 'add', '--prompt', 'p', '--every', '1h', '--session', 's', '--cwd', '/w'],
      ['schedules', 'pause'],
      ['schedules', 'x'],
    ]) {
      const r = await run(argv, { list: { schedules: [] }, upsert: view() })
      expect(r.exit, argv.join(' ')).toMatchObject({ name: 'UsageError' })
      expect(r.calls).toEqual([])
    }
  })

  it('edit reads the current schedule and changes only what is given', async () => {
    const reply = {
      list: { schedules: [view({ target: { kind: 'new-session', cwd: '/work', preset: 'strict' } })] },
      upsert: view(),
    }
    const r = await run(
      [
        'schedules',
        'edit',
        'sched_0123456789abcdef',
        '--daily',
        '07:15',
        '--tz',
        'UTC',
        '--unattended',
        'notify',
      ],
      reply,
    )
    expect(r.calls[1]).toEqual([
      'upsert',
      {
        id: 'sched_0123456789abcdef',
        title: view().title,
        prompt: view().prompt,
        selector: { daily: { time: '07:15', timeZone: 'UTC' } },
        target: { kind: 'new-session', cwd: '/work', preset: 'strict', unattendedApproval: 'notify' },
      },
    ])
    const none = await run(['schedules', 'edit', 'sched_ffffffffffffffff', '--every', '1h'], reply)
    expect(none.exit).toBe(1)
    expect(none.calls.map((c) => c[0])).toEqual(['list'])
  })

  it('pause, resume and run send schedules.control; archive sends schedules.archive', async () => {
    for (const action of ['pause', 'resume', 'run']) {
      const r = await run(['schedules', action, 'sched_0123456789abcdef'], {
        control: view({ status: 'paused' }),
      })
      expect(r.calls).toEqual([['control', { id: 'sched_0123456789abcdef', action }]])
      expect(r.out).toContain('paused')
    }
    const gone = await run(['schedules', 'archive', 'sched_0123456789abcdef'], { archive: { deleted: true } })
    expect(gone.calls).toEqual([['archive', { id: 'sched_0123456789abcdef' }]])
    expect(gone.out).toBe('archived sched_0123456789abcdef\n')
    const absent = await run(['schedules', 'archive', 'sched_0123456789abcdef'], {
      archive: { deleted: false },
    })
    expect(absent.exit).toBe(1)
  })

  it('a daemon refusal prints its code and exits 1; --json still carries it', async () => {
    const refused = { updated: false, code: 'schedule_unavailable' }
    const r = await run(['schedules', 'run', 'sched_0123456789abcdef'], { control: refused })
    expect(r.exit).toBe(1)
    expect(r.err).toBe('refused: schedule_unavailable\n')
    const j = await run(['schedules', 'pause', 'sched_0123456789abcdef', '--json'], { control: refused })
    expect(j.exit).toBe(1)
    expect(j.out).toBe(`${JSON.stringify(refused)}\n`)
    const add = await run(['schedules', 'add', '--prompt', 'p', '--every', '1h', '--cwd', '/w'], {
      upsert: refused,
    })
    expect(add.exit).toBe(1)
    expect(add.err).toBe('refused: schedule_unavailable\n')
  })
})
