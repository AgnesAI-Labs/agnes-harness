import { describe, expect, it, vi } from 'vitest'
import { PagerOverlay } from '../src/pager-overlay.js'
import { FakeTerminal } from '../src/terminal.js'
import { TuiTheme } from '../src/theme.js'
import type { PagerBlock } from '../src/views/timeline.js'

const block = (text: string): PagerBlock => ({ rows: [text], text })
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const PGUP = '\x1b[5~'
const PGDN = '\x1b[6~'
const HOME = '\x1b[H'
const END = '\x1b[F'

function pager(init: { blocks: PagerBlock[]; earlier?: PagerBlock[]; height?: number }) {
  let blocks = init.blocks
  let more = init.earlier
  const loadEarlier = vi.fn(async () => {
    if (!more) return false
    blocks = [...more, ...blocks]
    more = undefined
    return true
  })
  const changed = vi.fn()
  const copy = vi.fn()
  const p = new PagerOverlay({
    theme: new TuiTheme('mono'),
    term: new FakeTerminal({ columns: 100, rows: init.height ?? 6 }),
    locale: 'en',
    timeline: {
      blocks: () => blocks,
      get earlier() {
        return more !== undefined
      },
    },
    loadEarlier,
    mouse: { copy, overlay: () => {} },
    changed,
  })
  // The body: every row but the status line.
  const body = (): string[] => p.render(100).slice(0, -1)
  const status = (): string => p.render(100).at(-1) ?? ''
  return { p, body, status, copy, loadEarlier, changed }
}

const many = (n: number): PagerBlock[] => Array.from({ length: n }, (_, i) => block(`m${i}`))

describe('PagerOverlay', () => {
  it('renders nothing until opened, fills the screen, and opens at the newest output', () => {
    const { p, body } = pager({ blocks: many(10) })
    expect(p.render(100)).toEqual([])
    p.show()
    const rows = p.render(100)
    expect(rows).toHaveLength(6)
    // 10 blocks with a blank row between them is 19 rows; the last five show.
    expect(body().filter(Boolean)).toContain('m9')
    expect(rows.at(-1)).toContain('Ctrl-T/Esc close')
    expect(rows.at(-1)).toContain('15-19/19')
  })

  it('scrolls by line, page, Home and End and stops at both ends', () => {
    const { p, body } = pager({ blocks: many(10) })
    p.show()
    p.render(100)
    p.handleInput(END)
    p.handleInput(DOWN)
    expect(body().at(-1)).toBe('m9')
    p.handleInput(UP)
    expect(body().at(-1)).toBe('')
    p.handleInput(HOME)
    expect(body()[0]).toBe('m0')
    p.handleInput(PGDN)
    p.render(100)
    expect(body()[0]).toBe('m2')
    p.handleInput(PGUP)
    expect(body()[0]).toBe('m0')
    p.handleInput(END)
    expect(body().at(-1)).toBe('m9')
  })

  it('closes on Esc or Ctrl-T and takes every key while open', () => {
    const { p } = pager({ blocks: many(2) })
    expect(p.handleInput('x')).toBe(false)
    p.show()
    expect(p.handleInput('x')).toBe(true)
    expect(p.open).toBe(true)
    p.handleInput('\x14')
    expect(p.open).toBe(false)
    p.show()
    p.handleInput('\x1b')
    expect(p.open).toBe(false)
  })

  it('reads older history on demand from the top, keeping the view in place', async () => {
    const { p, body, loadEarlier, changed } = pager({
      blocks: many(10),
      earlier: [block('old0'), block('old1')],
    })
    p.show()
    p.render(100)
    expect(loadEarlier).not.toHaveBeenCalled()
    p.handleInput(HOME)
    expect(body()[0]).toContain('Earlier history')
    expect(loadEarlier).not.toHaveBeenCalled()
    p.handleInput(UP)
    await vi.waitFor(() => expect(loadEarlier).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(changed.mock.calls.length).toBeGreaterThan(2))
    // The view did not jump to the top of what arrived; the older entries are above it.
    expect(body().join('\n')).not.toContain('old0')
    p.handleInput(HOME)
    expect(body()[0]).toBe('old0')
    p.handleInput(UP)
    expect(loadEarlier).toHaveBeenCalledTimes(1)
  })

  describe('search', () => {
    const type = (p: PagerOverlay, text: string) => {
      p.handleInput('/')
      for (const ch of text) p.handleInput(ch)
      p.handleInput('\r')
    }
    const words = (): PagerBlock[] => [
      block('Alpha one'),
      block('beta'),
      block('alpha two'),
      block('gamma'),
      block('ALPHA three'),
    ]

    it('jumps to the first hit, counts them, and steps with n and N around both ends', () => {
      const { p, status } = pager({ blocks: words(), height: 4 })
      p.show()
      p.render(100)
      type(p, 'alpha')
      expect(status()).toContain('/alpha  1/3')
      p.handleInput('n')
      expect(status()).toContain('2/3')
      p.handleInput('n')
      p.handleInput('n')
      expect(status()).toContain('1/3')
      p.handleInput('N')
      expect(status()).toContain('3/3')
    })

    it('brings the current hit into view and marks the hits', () => {
      const { p, body } = pager({ blocks: words(), height: 4 })
      p.show()
      p.render(100)
      type(p, 'gamma')
      expect(body().join('\n')).toContain('\x1b[7;4mgamma\x1b[27;24m')
      p.handleInput('N')
      type(p, 'alpha')
      expect(body().join('\n')).toContain('\x1b[7;4mAlpha\x1b[27;24m')
      expect(body().some((l) => l.includes('\x1b[7malpha\x1b[27m'))).toBe(false)
    })

    it('reads the query as plain text, never as a pattern', () => {
      const { p, status } = pager({ blocks: [block('a.c'), block('abc'), block('(x')] })
      p.show()
      p.render(100)
      type(p, 'a.c')
      expect(status()).toContain('1/1')
      type(p, '(x')
      expect(status()).toContain('1/1')
      type(p, '.*')
      expect(status()).toContain('0/0')
    })

    it('matches the text a row shows, not its colour codes', () => {
      const red = { rows: ['\x1b[31mhel\x1b[0mlo \x1b[1mWorld\x1b[22m'], text: 'hello World' }
      const { p, status, body } = pager({ blocks: [red] })
      p.show()
      p.render(100)
      type(p, 'hello w')
      expect(status()).toContain('1/1')
      expect(body().join('')).toContain('\x1b[7;4m')
      type(p, '31m')
      expect(status()).toContain('0/0')
    })

    it('copies the whole message holding the current hit, and nothing when there is none', () => {
      const long = { rows: ['first row', 'the needle row'], text: 'first row\nthe needle row (source)' }
      const { p, copy } = pager({ blocks: [block('other'), long] })
      p.show()
      p.render(100)
      p.handleInput('c')
      expect(copy).not.toHaveBeenCalled()
      type(p, 'needle')
      p.handleInput('c')
      expect(copy).toHaveBeenCalledExactlyOnceWith('first row\nthe needle row (source)')
    })

    it('leaves the old search alone on Esc while typing, and a typed n is text, not a step', () => {
      const { p, status } = pager({ blocks: words() })
      p.show()
      p.render(100)
      type(p, 'beta')
      p.handleInput('/')
      p.handleInput('n')
      expect(status()).toContain('/n▏')
      p.handleInput('\x1b')
      expect(p.open).toBe(true)
      expect(status()).toContain('/beta  1/1')
      p.handleInput('\x1b')
      expect(p.open).toBe(false)
    })

    it('searches older history once it has been read, and the hit keeps its place', async () => {
      const { p, status, loadEarlier } = pager({
        blocks: [block('new needle')],
        earlier: [block('old needle')],
        height: 4,
      })
      p.show()
      p.render(100)
      type(p, 'needle')
      expect(status()).toContain('1/1')
      p.handleInput('\x1b[H')
      p.handleInput('\x1b[A')
      await vi.waitFor(() => expect(loadEarlier).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(status()).toContain('/needle  2/2'))
    })
  })
})
