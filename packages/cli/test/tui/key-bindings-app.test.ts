import { createClient } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/tui/app.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { scriptedEndpoint } from '../fake-endpoint.js'

// The app-level keys, driven through the terminal: what each one reaches. (Ctrl-C, Ctrl-D, Ctrl-O,
// F1, PgUp/PgDn, Ctrl-End and Alt-Up are also exercised end to end in app.test.ts.)
type Inside = {
  editor: { text: string }
  hintActions: Array<{ id: string; label: string }>
  cards: { toggleLatest(): void }
  dispatchAction(id: string): void
  scrollTimeline(delta: number): void
  submitBlocks(blocks: unknown, draft?: string, steer?: boolean): Promise<void>
}

async function openApp() {
  const ep = scriptedEndpoint().on('_agnes/v1/session.projectUI', (params) => ({
    sessionId: (params as { sessionId: string }).sessionId,
    upto: 0,
    generation: 1,
    opState: null,
    turns: [],
    nodes: [],
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      context: { tokens: 0, window: 128_000, autoCompact: true },
      model: { route: 'deepseek', id: 'deepseek-v4-flash', thinking: 'off' },
    },
  }))
  const client = createClient({ transport: { kind: 'inproc', endpoint: ep } })
  const session = await client.session.new({ cwd: '/tmp' })
  const term = new FakeTerminal({ columns: 80, rows: 24 })
  const app = new TuiApp({ session, term, header: 'Agnes' })
  await app.start()
  const inside = app as unknown as Inside
  return {
    app,
    term,
    inside,
    close: async () => {
      await app.stop()
      await client.close()
    },
  }
}

it('F1 to F4 run the hint actions in order, Ctrl-O toggles the latest card, PgUp and PgDn scroll a page', async () => {
  const { term, inside, close } = await openApp()
  try {
    const dispatched: string[] = []
    const scrolled: number[] = []
    const toggled = vi.fn()
    inside.dispatchAction = (id) => void dispatched.push(id)
    inside.scrollTimeline = (rows) => void scrolled.push(rows)
    inside.cards.toggleLatest = toggled
    inside.hintActions = [1, 2, 3, 4].map((n) => ({ id: `act${n}`, label: `A${n}` }))
    for (const key of ['\x1bOP', '\x1bOQ', '\x1bOR', '\x1bOS']) term.feed(key)
    expect(dispatched).toEqual(['act1', 'act2', 'act3', 'act4'])
    term.feed('\x0f')
    expect(toggled).toHaveBeenCalledTimes(1)
    term.feed('\x1b[5~')
    term.feed('\x1b[6~')
    expect(scrolled).toHaveLength(2)
    expect(scrolled[0]).toBeLessThan(0)
    expect(scrolled[1]).toBe(-(scrolled[0] as number))
  } finally {
    await close()
  }
})

it('Alt-Enter steers the draft into a running turn, and types a newline when idle', async () => {
  const { app, term, inside, close } = await openApp()
  try {
    const steered: Array<[string, boolean | undefined]> = []
    inside.submitBlocks = async (_blocks, draft, steer) => void steered.push([draft as string, steer])
    term.feed('hello')
    term.feed('\x1b\r')
    expect(steered).toEqual([])
    expect(inside.editor.text).toBe('hello\n')
    app.setDraft('')
    vi.spyOn(app, 'busy', 'get').mockReturnValue(true)
    term.feed('later')
    term.feed('\x1b\r')
    expect(steered).toEqual([['later', true]])
  } finally {
    await close()
  }
})
