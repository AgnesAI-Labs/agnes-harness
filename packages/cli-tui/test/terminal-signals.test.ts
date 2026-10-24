import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { runSlash } from '../src/commands.js'
import { NotifyPreference, notification, supportsOsc9 } from '../src/notify.js'
import { TerminalSignals } from '../src/terminal-signals.js'

function rig(cwd = '/work/proj') {
  const writes: string[] = []
  const state = { busy: false, asks: 0 }
  const cards = new Map<string, { pending: boolean }>()
  const signals = new TerminalSignals(
    { write: (s) => writes.push(s) },
    cwd,
    () => state.busy,
    {
      get count() {
        return state.asks
      },
    },
    cards,
  )
  const bells = () => writes.filter((w) => w === '\x07').length
  const titles = () => writes.filter((w) => w.startsWith('\x1b]2;')).map((w) => w.slice(4, -1))
  return { writes, state, cards, signals, bells, titles }
}

afterEach(() => vi.useRealTimers())

describe('TerminalSignals', () => {
  it('saves the title on start and restores it on stop, once each', () => {
    const { writes, signals } = rig()
    signals.start()
    signals.start()
    signals.stop()
    signals.stop()
    expect(writes.filter((w) => w === '\x1b[22;0t')).toHaveLength(1)
    expect(writes.at(-1)).toBe('\x1b[23;0t')
    expect(writes.indexOf('\x1b[22;0t')).toBeLessThan(writes.indexOf('\x1b]2;agh · proj\x07'))
  })

  it('rings once per turn end and once per new approval, and only while unfocused', () => {
    vi.useFakeTimers()
    const { state, cards, signals, bells } = rig()
    signals.start()
    state.busy = true
    signals.sync()
    state.busy = false
    signals.sync()
    expect(bells()).toBe(0)
    expect(signals.focus('\x1b[O')).toBe(true)
    state.busy = true
    signals.sync()
    state.busy = false
    signals.sync()
    signals.sync()
    expect(bells()).toBe(1)
    cards.set('a1', { pending: true })
    signals.sync()
    signals.sync()
    vi.advanceTimersByTime(5000)
    state.asks = 1
    signals.sync()
    expect(bells()).toBe(3)
    expect(signals.focus('\x1b[I')).toBe(true)
    state.asks = 2
    signals.sync()
    expect(bells()).toBe(3)
    expect(signals.focus('x')).toBe(false)
  })

  it('prefixes the title while busy or waiting, and strips control characters from the name', () => {
    const { state, cards, signals, titles } = rig('/work/pr\x1b]0;x\x07o\nj')
    signals.start()
    state.busy = true
    signals.sync()
    cards.set('a1', { pending: true })
    signals.sync()
    state.busy = false
    cards.clear()
    signals.sync()
    expect(titles()).toEqual(['agh · pr]0;xo j', '● agh · pr]0;xo j', '! agh · pr]0;xo j', 'agh · pr]0;xo j'])
  })
})

describe('desktop notifications', () => {
  const ITERM = { TERM_PROGRAM: 'iTerm.app' }
  const setup = (env: NodeJS.ProcessEnv, mode?: string, cwd = '/work/proj') => {
    vi.useFakeTimers()
    const writes: string[] = []
    const preference = new NotifyPreference(undefined, mode ? { ...env, AGH_NOTIFY: mode } : env, () => 'en')
    const signals = new TerminalSignals(
      { write: (s) => writes.push(s) },
      cwd,
      () => false,
      { count: 0 },
      new Map(),
      preference,
    )
    signals.start()
    writes.length = 0
    return { writes, signals, preference }
  }

  it.each([
    ['iTerm2', { TERM_PROGRAM: 'iTerm.app' }, true],
    ['iTerm2 under tmux', { TERM_PROGRAM: 'tmux', LC_TERMINAL: 'iTerm2' }, true],
    ['Ghostty', { TERM_PROGRAM: 'ghostty' }, true],
    ['WezTerm', { TERM_PROGRAM: 'WezTerm' }, true],
    ['kitty', { TERM: 'xterm-kitty' }, true],
    ['Warp', { TERM_PROGRAM: 'WarpTerminal' }, true],
    ['Windows Terminal', { WT_SESSION: 'x', TERM_PROGRAM: 'WezTerm' }, false],
    ['ConEmu', { ConEmuPID: '1' }, false],
    ['Apple Terminal', { TERM_PROGRAM: 'Apple_Terminal' }, false],
    ['nothing', {}, false],
  ])('%s: OSC 9 is %s', (_name, env, osc9) => expect(supportsOsc9(env)).toBe(osc9))

  it('posts OSC 9 on a verified terminal and a bell elsewhere, only while unfocused', () => {
    const iterm = setup(ITERM)
    iterm.signals.event('done')
    expect(iterm.writes).toEqual([])
    iterm.signals.focus('\x1b[O')
    iterm.signals.event('done')
    expect(iterm.writes).toEqual(['\x1b]9;agh · done · proj\x07'])
    const plain = setup({})
    plain.signals.focus('\x1b[O')
    plain.signals.event('approval')
    expect(plain.writes).toEqual(['\x07'])
  })

  it('wraps the notification for tmux passthrough', () => {
    const { writes, signals } = setup({ ...ITERM, TMUX: '/tmp/tmux-1/default,1,0' })
    signals.focus('\x1b[O')
    signals.event('error')
    expect(writes).toEqual(['\x1bPtmux;\x1b\x1b]9;agh · error · proj\x07\x1b\\'])
  })

  it('counts a repeated event once inside the window, and each event on its own', () => {
    const { writes, signals } = setup(ITERM)
    signals.focus('\x1b[O')
    signals.event('done')
    signals.event('done')
    signals.event('agent')
    expect(writes).toHaveLength(2)
    vi.advanceTimersByTime(3001)
    signals.event('done')
    expect(writes).toHaveLength(3)
  })

  it('names a finished delegated subagent once, and says nothing for one already finished', () => {
    const { writes, signals } = setup(ITERM)
    signals.focus('\x1b[O')
    const node = (status: string) => [{ kind: 'tool', id: 't1', delegatedTask: { status } }]
    signals.watch(node('completed'))
    signals.watch(node('running'))
    signals.watch(node('completed'))
    signals.watch(node('completed'))
    expect(writes).toEqual(['\x1b]9;agh · subagent finished · proj\x07'])
  })

  it('sends only the fixed prefix, the event and a cleaned, cut title', () => {
    const text = notification('on', ITERM, 'done', `pr\x1b]0;x\x07o\nj${'z'.repeat(80)}`, 'en')
    expect(text.startsWith('\x1b]9;agh · done · pr]0;xo j')).toBe(true)
    expect(text.endsWith('…\x07')).toBe(true)
    expect([...text.slice(1, -1)].filter((c) => c.charCodeAt(0) < 32)).toEqual([])
    expect(notification('on', ITERM, 'approval', 'p', 'zh-CN')).toBe('\x1b]9;agh · 等待审批 · p\x07')
  })

  it('honours the mode: bell always rings, off is silent, AGH_NOTIFY wins over the saved choice', () => {
    const bell = setup(ITERM, 'bell')
    bell.signals.focus('\x1b[O')
    bell.signals.event('done')
    expect(bell.writes).toEqual(['\x07'])
    const off = setup(ITERM, 'off')
    off.signals.focus('\x1b[O')
    off.signals.event('done')
    expect(off.writes).toEqual([])
    const saved = new NotifyPreference(undefined, { AGH_NOTIFY: 'off' }, () => 'en')
    saved.set('on')
    expect(saved.mode).toBe('off')
    expect(saved.saved).toBe('on')
    expect(new NotifyPreference(undefined, { AGH_NOTIFY: 'nonsense' }, () => 'en').mode).toBe('on')
  })

  it('/notify shows, sets and remembers the mode, names an AGH_NOTIFY override, and refuses nonsense', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agh-notify-')), 'tui-notify.json')
    const make = (env: NodeJS.ProcessEnv) => {
      const notify = new NotifyPreference(path, env, () => 'en')
      return { notify, app: { locale: 'en', notify, session: {} } as unknown as TuiApp }
    }
    const first = make({})
    expect((await runSlash(first.app, '/notify')).text).toBe('Notifications: on')
    expect((await runSlash(first.app, '/notify bell')).text).toBe('Notifications: bell')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ notify: 'bell' })
    expect(make({}).notify.mode).toBe('bell')
    expect((await runSlash(make({ AGH_NOTIFY: 'off' }).app, '/notify')).text).toContain(
      'AGH_NOTIFY=off is set and wins',
    )
    expect((await runSlash(first.app, '/notify loud')).text).toBe('usage: /notify [on|bell|off]')
    expect((await runSlash(first.app, '/notify on off')).text).toBe('usage: /notify [on|bell|off]')
  })
})
