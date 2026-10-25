import type { UITimeline } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { cleanNote, HeadsUpWatcher, headsUpSlash } from '../src/heads-up.js'

type Answer = { enabled?: boolean; busy?: boolean; text?: string }
function harness(answers: Array<Answer | Error>) {
  const calls: Array<Record<string, unknown>> = []
  const notices: Array<[string | undefined, string | undefined]> = []
  const queue = [...answers]
  const app = {
    locale: 'en',
    profile: 'local-dev',
    session: {
      id: 'sess-1',
      client: {
        call: async (method: string, params: Record<string, unknown>) => {
          calls.push({ method, ...params })
          const next = queue.length > 1 ? queue.shift() : queue[0]
          if (next instanceof Error) throw next
          return { output: next ?? {} }
        },
      },
    },
    statusBar: { setNotice: (text?: string, tone?: string) => notices.push([text, tone]) },
    renderer: { requestRender: vi.fn() },
  } as unknown as TuiApp
  return { app, calls, notices }
}
const running = (turn: number) => ({ opState: { turn, phase: 'x' } }) as unknown as UITimeline
const idle = { opState: null } as unknown as UITimeline

describe('/heads-up', () => {
  it('switches the extension per session and states what is sent when turned on', async () => {
    const { app, calls } = harness([{ enabled: true }])
    const on = await headsUpSlash(app, '/heads-up on')
    expect(calls).toEqual([
      {
        method: '_agnes/v1/clientModules.callService',
        profile: 'local-dev',
        rowId: 'web:builtin:agnes/heads-up',
        sessionId: 'sess-1',
        service: 'headsup.set',
        input: { enabled: true },
      },
    ])
    expect(on.text).toMatch(/verifier model, or the fast model/)
    const off = harness([{ enabled: false }])
    expect((await headsUpSlash(off.app, '/heads-up off')).text).toBe('Heads-up is off for this session')
    expect((await headsUpSlash(off.app, '/heads-up')).text).toBe('Heads-up is off for this session')
    expect((await headsUpSlash(off.app, '/heads-up maybe')).text).toBe('Usage: /heads-up [on|off]')
    const gone = harness([Object.assign(new Error('no'), { data: { code: 'CAPABILITY_DENIED' } })])
    expect((await headsUpSlash(gone.app, '/heads-up on')).text).toMatch(/not available/)
    const stale = harness([{ enabled: false }])
    expect((await headsUpSlash(stale.app, '/heads-up on')).text).toMatch(/not available/)
  })
})

describe('HeadsUpWatcher', () => {
  it('shows a cleaned note after the turn ends, reading until the review settles', async () => {
    const h = harness([
      { enabled: true, busy: true },
      { enabled: true, busy: true, text: 'Deleted\u0007 build/‮ dir' },
      { enabled: true, busy: false, text: 'Deleted build/ dir' },
    ])
    const sleep = vi.fn(async () => undefined)
    const watcher = new HeadsUpWatcher(() => h.app, sleep)
    watcher.onTimeline(running(3))
    expect(h.calls).toHaveLength(0)
    watcher.onTimeline(idle)
    await vi.waitFor(() => expect(h.calls).toHaveLength(3))
    expect(h.calls[0]).toMatchObject({ service: 'headsup.read', input: { turn: 3 } })
    await vi.waitFor(() => expect(h.notices).toHaveLength(1))
    expect(h.notices[0]).toEqual(['Heads-up: Deleted build/ dir', 'warning'])
  })

  it('stays quiet when off, on errors, and when a new turn starts first', async () => {
    const off = harness([{ enabled: false }])
    const w1 = new HeadsUpWatcher(
      () => off.app,
      async () => undefined,
    )
    w1.onTimeline(running(1))
    w1.onTimeline(idle)
    await vi.waitFor(() => expect(off.calls).toHaveLength(1))
    expect(off.notices).toEqual([])
    const bad = harness([new Error('boom')])
    const w2 = new HeadsUpWatcher(
      () => bad.app,
      async () => undefined,
    )
    w2.onTimeline(running(1))
    w2.onTimeline(idle)
    await vi.waitFor(() => expect(bad.calls).toHaveLength(1))
    expect(bad.notices).toEqual([])
    const slow = harness([{ enabled: true, busy: true }])
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const w3 = new HeadsUpWatcher(
      () => slow.app,
      () => gate,
    )
    w3.onTimeline(running(1))
    w3.onTimeline(idle)
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1))
    w3.onTimeline(running(2))
    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(slow.calls).toHaveLength(1)
  })

  it('strips control characters and caps the note', () => {
    expect(cleanNote('a\u001b[31mb\n\nc')).toBe('a [31mb c')
    expect(Array.from(cleanNote('x'.repeat(900)))).toHaveLength(300)
  })
})
