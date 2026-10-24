import { describe, expect, it } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { backgroundSessions, bgSlash } from '../src/bg-command.js'
import { exitSummaryLines } from '../src/exit-summary.js'
import { TerminalSignals } from '../src/terminal-signals.js'

type Outcome = { reason: string } | Error

/** A TUI whose daemon makes fake sessions; each one's turn ends when the test settles it. */
function harness(over: { hereYolo?: boolean; newYolo?: boolean } = {}) {
  const made: Array<{ params: unknown; session: ReturnType<typeof fakeSession> }> = []
  const notices: Array<[string | undefined, string | undefined]> = []
  const writes: string[] = []
  const term = { write: (s: string) => writes.push(s) }
  const signals = new TerminalSignals(term, '/work/proj', () => false, { count: 0 }, new Map())
  signals.start()
  signals.focus('\x1b[O')
  function fakeSession(id: string) {
    let settle!: (outcome: Outcome) => void
    const turn = new Promise<{ reason: string }>((resolve, reject) => {
      settle = (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome))
    })
    const state = { yolo: over.newYolo ?? false, prompts: [] as string[], yoloSet: [] as boolean[] }
    return {
      id,
      state,
      settle,
      projectUIOpening: async () => ({ timeline: { yolo: state.yolo } }),
      setYolo: async (on: boolean) => {
        state.yoloSet.push(on)
        state.yolo = on
      },
      prompt: (text: string) => {
        state.prompts.push(text)
        return turn
      },
    }
  }
  const app = {
    locale: 'en',
    cwd: '/work/proj',
    profile: 'default',
    composerSelectionPath: undefined,
    statusBar: { setNotice: (text?: string, tone?: string) => notices.push([text, tone]) },
    renderer: { requestRender: () => {} },
    o: { term },
    session: {
      id: 'main',
      projectUIOpening: async () => ({ timeline: { yolo: over.hereYolo ?? false } }),
      client: {
        session: {
          new: async (params: unknown) => {
            const session = fakeSession(`bg-${made.length + 1}`)
            made.push({ params, session })
            return session
          },
        },
      },
    },
  } as unknown as TuiApp
  return { app, made, notices, writes }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('/bg', () => {
  it('starts a session the way /new does, sends the prompt and leaves this session open', async () => {
    const { app, made } = harness()
    const r = await bgSlash(app, '/bg  run the\n tests ')
    expect(r.switchSession).toBeUndefined()
    expect(r.text).toMatch(/Background session 1 started \(bg-1\): run the tests/)
    expect(made[0]?.params).toMatchObject({ cwd: '/work/proj', sessionKey: expect.any(String) })
    expect(made[0]?.session.state.prompts).toEqual(['run the\n tests'])
    expect(backgroundSessions(app)).toEqual([{ id: 'bg-1', state: 'running' }])
  })

  it('never gives the background session more access than this one has', async () => {
    const wider = harness({ newYolo: true })
    await bgSlash(wider.app, '/bg a')
    expect(wider.made[0]?.session.state.yoloSet).toEqual([false])
    const same = harness({ newYolo: true, hereYolo: true })
    await bgSlash(same.app, '/bg a')
    expect(same.made[0]?.session.state.yoloSet).toEqual([])
  })

  it('says in the status bar and through the notify channel when one finishes, and drops it from the running list', async () => {
    const { app, made, notices, writes } = harness()
    await bgSlash(app, '/bg build it')
    made[0]?.session.settle({ reason: 'completed' })
    await flush()
    expect(notices.at(-1)).toEqual(['Background session 1: finished · build it', 'success'])
    expect(writes.filter((w) => w === '\x07')).toHaveLength(1)
    expect(backgroundSessions(app)).toEqual([])
  })

  it('waits on an approval rather than approving, and reports failures', async () => {
    const { app, made, notices } = harness()
    await bgSlash(app, '/bg one')
    await bgSlash(app, '/bg two')
    made[0]?.session.settle({ reason: 'parked' })
    made[1]?.session.settle(new Error('boom'))
    await flush()
    expect(notices.map(([text]) => text)).toEqual([
      'Background session 1: waiting for approval · one',
      'Background session 2: failed · two',
    ])
    expect(backgroundSessions(app)).toEqual([{ id: 'bg-1', state: 'waiting' }])
    expect(made[0]?.session).not.toHaveProperty('onPermissionRequest')
  })

  it('lists them with their state and offers them to the session picker', async () => {
    const { app, made } = harness()
    expect((await bgSlash(app, '/bg')).text).toMatch(/No background sessions/)
    await bgSlash(app, '/bg one')
    await bgSlash(app, '/bg two')
    made[1]?.session.settle({ reason: 'completed' })
    await flush()
    const r = await bgSlash(app, '/bg')
    expect(r.text).toBe('1. running  bg-1  one\n2. finished  bg-2  two')
    expect(r.sessionChoices?.map((c) => c.sessionId)).toEqual(['bg-1', 'bg-2'])
  })

  it('refuses an oversized prompt and a sixth running session before creating anything', async () => {
    const { app, made } = harness()
    expect((await bgSlash(app, `/bg ${'x'.repeat(16001)}`)).text).toMatch(/longer than 16000/)
    for (let i = 0; i < 5; i++) await bgSlash(app, `/bg job ${i}`)
    expect((await bgSlash(app, '/bg one more')).text).toMatch(/Already 5 background sessions/)
    expect(made).toHaveLength(5)
  })

  it('lists the ones still going in the exit summary', async () => {
    const { app, made } = harness()
    await bgSlash(app, '/bg one')
    await bgSlash(app, '/bg two')
    made[1]?.session.settle({ reason: 'parked' })
    await flush()
    const lines = exitSummaryLines(
      { elapsedMs: 5_000, approvals: 0, queued: 0, background: backgroundSessions(app) },
      'en',
    )
    expect(lines).toEqual([
      'This run lasted 5s',
      'Background sessions keep running: bg-1 (running), bg-2 (waiting for approval)',
    ])
  })
})
