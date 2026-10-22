import { describe, expect, it } from 'vitest'
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
    expect(titles()).toEqual(['agh · pr]0;xo j', '… agh · pr]0;xo j', '! agh · pr]0;xo j', 'agh · pr]0;xo j'])
  })
})
