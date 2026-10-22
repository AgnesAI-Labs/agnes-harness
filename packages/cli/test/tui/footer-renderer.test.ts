import { Terminal as Xterm } from '@xterm/headless'
import { afterEach, describe, expect, it } from 'vitest'
import { CURSOR_MARKER, Text, VStack } from '../../src/tui/component.js'
import {
  FooterRenderer,
  rewrapsFooter,
  type ScrollMode,
  scrollModeFor,
} from '../../src/tui/footer-renderer.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { emulate } from './harness.js'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// The conversation side of the split, reduced to what the renderer touches.
class Source {
  private queue: string[] = []
  finished: string[] = []
  push(...lines: string[]): void {
    this.queue.push(...lines)
  }
  takeSettled(_width: number, all = false): string[] {
    const out = this.queue
    this.queue = []
    return all ? [...out, ...this.finished] : out
  }
}

const live: FooterRenderer[] = []
afterEach(() => {
  for (const renderer of live.splice(0)) renderer.stop()
})

async function started(
  opts: { cols?: number; rows?: number; cursor?: { row: number; col: number }; mode?: ScrollMode } = {},
) {
  const { cols = 20, rows = 8, cursor = { row: 1, col: 1 }, mode } = opts
  const term = new FakeTerminal({ columns: cols, rows })
  term.cursor = cursor
  const source = new Source()
  const footer = new Text(`> ${CURSOR_MARKER}`)
  const status = new Text('status')
  const renderer = new FooterRenderer(term, new VStack([footer, status]), source, mode)
  live.push(renderer)
  renderer.start()
  await tick()
  return { term, source, footer, status, renderer, cols, rows }
}

const written = (screen: { scrollback: string[]; lines: string[] }): string[] =>
  [...screen.scrollback, ...screen.lines].filter((line) => line !== '' && line !== '> ' && line !== 'status')

describe.each(['region', 'full'] as const)('FooterRenderer, %s scrolling', (mode) => {
  it('pins the footer to the bottom and writes each settled line once, in order, into scrollback', async () => {
    const t = await started({ mode })
    const lines = Array.from({ length: 14 }, (_, i) => `line ${i}`)
    // Arrives in uneven batches across frames, as turns finish one at a time.
    for (const batch of [lines.slice(0, 3), lines.slice(3, 4), lines.slice(4, 11), lines.slice(11)]) {
      t.source.push(...batch)
      t.renderer.renderNow()
    }
    const screen = await emulate(t.term, t.cols, t.rows)
    expect(screen.lines.slice(-2)).toEqual(['> ', 'status'])
    expect(written(screen)).toEqual(lines)
    expect(screen.scrollback.length).toBeGreaterThan(0)
  })

  it('never claims the alternate screen, mouse reporting or the scrollback', async () => {
    const t = await started({ mode })
    t.source.push('hello')
    t.renderer.renderNow()
    t.renderer.stop()
    const all = t.term.writes.join('')
    for (const forbidden of ['\x1b[?1049', '\x1b[?1002', '\x1b[?1006', '\x1b[3J', '\x1b[2J', '\x1bc'])
      expect(all).not.toContain(forbidden)
  })

  it('writes controls in settled text as printable characters, keeping colour', async () => {
    const t = await started({ mode, cols: 30 })
    t.source.push('\x1b[2Jwipe\x1b]52;c;AAAA\x07 \x1b[31mred\x1b[0m')
    t.renderer.renderNow()
    const screen = await emulate(t.term, t.cols, t.rows)
    expect(written(screen)).toEqual(['[2Jwipe]52;c;AAAA red'])
    expect(t.term.writes.join('')).toContain('\x1b[31mred')
  })

  it('moves the footer when it grows and returns the rows when it shrinks, without losing a line', async () => {
    const t = await started({ mode })
    const lines = Array.from({ length: 10 }, (_, i) => `row ${i}`)
    t.source.push(...lines.slice(0, 6))
    t.renderer.renderNow()
    t.footer.set(`> ${CURSOR_MARKER}\nmenu a\nmenu b\nmenu c`)
    t.source.push(...lines.slice(6, 8))
    t.renderer.renderNow()
    let screen = await emulate(t.term, t.cols, t.rows)
    expect(screen.lines.slice(-5)).toEqual(['> ', 'menu a', 'menu b', 'menu c', 'status'])
    t.footer.set(`> ${CURSOR_MARKER}`)
    t.source.push(...lines.slice(8))
    t.renderer.renderNow()
    screen = await emulate(t.term, t.cols, t.rows)
    expect(screen.lines.slice(-2)).toEqual(['> ', 'status'])
    expect(written(screen)).toEqual(lines)
  })

  it('writes through a footer that leaves the conversation one or two rows, losing nothing', async () => {
    const t = await started({ mode })
    const tall = [`> ${CURSOR_MARKER}`, ...Array.from({ length: 5 }, (_, i) => `menu ${i}`)].join('\n')
    t.footer.set(tall)
    const lines = Array.from({ length: 12 }, (_, i) => `row ${i}`)
    for (const batch of [lines.slice(0, 2), lines.slice(2, 9), lines.slice(9)]) {
      t.source.push(...batch)
      t.renderer.renderNow()
    }
    const screen = await emulate(t.term, t.cols, t.rows)
    expect(screen.lines.slice(-7)).toEqual(['> ', 'menu 0', 'menu 1', 'menu 2', 'menu 3', 'menu 4', 'status'])
    expect(written(screen).filter((line) => line.startsWith('row '))).toEqual(lines)
  })

  it('starts under the shell prompt and scrolls only once the screen is full', async () => {
    const t = await started({ mode, cursor: { row: 3, col: 1 } })
    t.source.push('first', 'second')
    t.renderer.renderNow()
    const seed = 'sh$ ls\r\nfile\r\n'
    const screen = await emulate(t.term, t.cols, t.rows, { seed })
    expect(screen.scrollback).toEqual([])
    expect(screen.lines.slice(0, 4)).toEqual(['sh$ ls', 'file', 'first', 'second'])
    expect(screen.lines.slice(-2)).toEqual(['> ', 'status'])
  })

  it('keeps long lines whole in the order written and counts their wrapped rows', async () => {
    const t = await started({ mode })
    const long = 'x'.repeat(45)
    t.source.push('a', long, 'b')
    for (let i = 0; i < 6; i++) t.source.push(`n${i}`)
    t.renderer.renderNow()
    const screen = await emulate(t.term, t.cols, t.rows)
    expect(written(screen)).toEqual([
      'a',
      'x'.repeat(20),
      'x'.repeat(20),
      'x'.repeat(5),
      'b',
      'n0',
      'n1',
      'n2',
      'n3',
      'n4',
      'n5',
    ])
    expect(screen.lines.slice(-2)).toEqual(['> ', 'status'])
  })

  it('leaves the conversation in place at exit with the cursor on the row below it', async () => {
    const t = await started({ mode })
    t.source.push('one', 'two')
    t.renderer.renderNow()
    t.source.finished = ['still running']
    t.renderer.stop()
    const screen = await emulate(t.term, t.cols, t.rows)
    expect(written(screen)).toEqual(['one', 'two', 'still running'])
    expect(screen.lines).not.toContain('> ')
    expect(screen.lines).not.toContain('status')
    expect(screen.cursor).toEqual({ row: 3, col: 0 })
    expect(t.term.raw).toBe(false)
  })
})

describe('FooterRenderer', () => {
  it('draws nothing and takes no settled text until the shell cursor is known, then paints at once', async () => {
    const term = new FakeTerminal({ columns: 20, rows: 6 })
    const source = new Source()
    const renderer = new FooterRenderer(term, new VStack([new Text('status')]), source)
    live.push(renderer)
    renderer.start()
    renderer.renderNow()
    expect(term.writes.filter((w) => w.includes('status'))).toEqual([])
    await tick()
    expect(term.writes.some((w) => w.includes('status'))).toBe(true)
    renderer.stop()
  })

  it('hands the terminal back for a child process and takes the screen again afterwards', async () => {
    const t = await started()
    t.source.push('kept')
    t.renderer.renderNow()
    const back = t.renderer.suspend()
    expect(t.term.raw).toBe(false)
    back()
    await tick()
    expect(t.term.raw).toBe(true)
    t.renderer.renderNow()
    const screen = await emulate(t.term, t.cols, t.rows)
    expect(written(screen)).toEqual(['kept'])
  })
})

// A FakeTerminal wired to one live emulator, so a resize reaches the emulator the way it reaches a real
// terminal: it reflows what it holds, and the footer is drawn again on top of that.
class LiveTerminal extends FakeTerminal {
  answers = true
  readonly xterm: Xterm
  private pending: Promise<void> = Promise.resolve()
  constructor(columns: number, rows: number) {
    super({ columns, rows })
    this.xterm = new Xterm({ cols: columns, rows, scrollback: 500, allowProposedApi: true })
  }
  override write(s: string): void {
    super.write(s)
    this.pending = this.pending.then(() => new Promise<void>((resolve) => this.xterm.write(s, resolve)))
  }
  // The emulator answers as a real terminal would, once everything written so far has been drawn.
  override async queryCursor(): Promise<{ row: number; col: number } | undefined> {
    await this.pending
    if (!this.answers) return undefined
    const { cursorY, cursorX } = this.xterm.buffer.active
    return { row: cursorY + 1, col: cursorX + 1 }
  }
  override resize(columns: number, rows: number): void {
    this.pending = this.pending.then(() => this.xterm.resize(columns, rows))
    super.resize(columns, rows)
  }
  async everything(): Promise<{ lines: string[]; screen: string[] }> {
    await this.pending
    const buffer = this.xterm.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
    return { lines, screen: lines.slice(buffer.baseY) }
  }
}

describe('FooterRenderer resize and growth', () => {
  it.each(['region', 'full'] as const)(
    'keeps the footer on the bottom row and loses no written line across width and height changes (%s)',
    async (mode) => {
      const term = new LiveTerminal(30, 10)
      term.cursor = { row: 1, col: 1 }
      const source = new Source()
      const footer = new Text(`> ${CURSOR_MARKER}`)
      const renderer = new FooterRenderer(term, new VStack([footer, new Text('status')]), source, mode)
      live.push(renderer)
      renderer.start()
      await tick()
      const all: string[] = []
      const send = (n: number): void => {
        const batch = Array.from({ length: n }, (_, i) => `msg ${all.length + i}`)
        all.push(...batch)
        source.push(...batch)
        renderer.renderNow()
      }
      send(14)
      for (const [columns, rows, more] of [
        [12, 10, 3],
        [40, 10, 2],
        [40, 6, 4],
        [25, 14, 2],
        [25, 14, 5],
      ] as const) {
        term.resize(columns, rows)
        await tick()
        send(more)
        const { screen } = await term.everything()
        expect(screen.at(-1)).toBe('status')
        expect(screen.at(-2)).toBe('> ')
      }
      const { lines } = await term.everything()
      expect(lines.filter((line) => /^msg \d+$/.test(line))).toEqual(all)
      const writes = term.writes.join('')
      expect(writes).not.toContain('\x1b[3J')
      expect(writes).not.toContain('\x1b[2J')
    },
  )

  it('re-lays the footer when its own lines wrap at a narrower width, without touching the rows above', async () => {
    const term = new LiveTerminal(30, 8)
    term.cursor = { row: 1, col: 1 }
    const source = new Source()
    const renderer = new FooterRenderer(
      term,
      new VStack([
        new Text('status line that is quite wide', { wrap: false }),
        new Text(`> ${CURSOR_MARKER}`),
      ]),
      source,
    )
    live.push(renderer)
    renderer.start()
    await tick()
    source.push('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h')
    renderer.renderNow()
    term.resize(12, 8)
    await tick()
    renderer.renderNow()
    const { lines, screen } = await term.everything()
    expect(screen.at(-1)).toBe('> ')
    expect(lines.filter((line) => line.length === 1 && line >= 'a' && line <= 'h')).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
    ])
  })

  it.each(['region', 'full'] as const)('wraps wide characters and keeps a link whole (%s)', async (mode) => {
    const t = await started({ mode, cols: 10, rows: 8 })
    const link = `https://example.com/${'a'.repeat(30)}`
    t.source.push('你好世界你好世界你好', link, '😀😀😀😀😀😀', 'end')
    t.renderer.renderNow()
    const screen = await emulate(t.term, t.cols, t.rows)
    const text = [...screen.scrollback, ...screen.lines].filter(
      (line) => line !== '' && line !== '> ' && line !== 'status',
    )
    expect(text.slice(0, 2)).toEqual(
      ['你好世界你好', '世界你好'].length === 2 ? ['你好世界你', '好世界你好'] : [],
    )
    expect(text.slice(2, 7).join('')).toBe(link)
    expect(text.slice(7)).toEqual(['😀😀😀😀😀', '😀', 'end'])
  })
})

describe('FooterRenderer resize without a cursor report', () => {
  it('assumes the footer stayed on the bottom rows and keeps every written line', async () => {
    const term = new LiveTerminal(30, 10)
    term.cursor = { row: 1, col: 1 }
    const source = new Source()
    const renderer = new FooterRenderer(
      term,
      new VStack([new Text(`> ${CURSOR_MARKER}`), new Text('status')]),
      source,
    )
    live.push(renderer)
    renderer.start()
    await tick()
    term.answers = false
    const all = Array.from({ length: 16 }, (_, i) => `msg ${i}`)
    source.push(...all)
    renderer.renderNow()
    for (const [columns, rows] of [
      [18, 10],
      [44, 10],
      [30, 10],
    ] as const) {
      term.resize(columns, rows)
      await tick()
      renderer.renderNow()
    }
    const { lines, screen } = await term.everything()
    expect(screen.slice(-2)).toEqual(['> ', 'status'])
    expect(lines.filter((line) => /^msg \d+$/.test(line))).toEqual(all)
  })

  it('answers only for the newest of several quick resizes', async () => {
    const term = new LiveTerminal(30, 10)
    term.cursor = { row: 1, col: 1 }
    const source = new Source()
    const renderer = new FooterRenderer(
      term,
      new VStack([new Text(`> ${CURSOR_MARKER}`), new Text('status')]),
      source,
    )
    live.push(renderer)
    renderer.start()
    await tick()
    const all = Array.from({ length: 12 }, (_, i) => `msg ${i}`)
    source.push(...all)
    renderer.renderNow()
    term.resize(20, 10)
    term.resize(26, 12)
    term.resize(34, 9)
    await tick()
    await tick()
    renderer.renderNow()
    const { lines, screen } = await term.everything()
    expect(screen.slice(-2)).toEqual(['> ', 'status'])
    expect(lines.filter((line) => /^msg \d+$/.test(line))).toEqual(all)
  })
})

it('takes the standard margin path unless the terminal is known to mishandle it or the user says otherwise', () => {
  expect(scrollModeFor({})).toBe('region')
  expect(scrollModeFor({ TMUX: '/tmp/tmux-1/default,1,0', TERM: 'screen-256color' })).toBe('region')
  expect(scrollModeFor({ ZELLIJ: '0' })).toBe('full')
  expect(scrollModeFor({ ZELLIJ: '0', AGH_SPLIT_FOOTER_SCROLL: 'region' })).toBe('region')
  expect(scrollModeFor({ AGH_SPLIT_FOOTER_SCROLL: 'full' })).toBe('full')
  expect(scrollModeFor({ AGH_SPLIT_FOOTER_SCROLL: 'bogus' })).toBe('region')
})

describe('FooterRenderer finds its first row after a resize from the cursor', () => {
  // The footer is three rows, the first as wide as the screen, the cursor in the second. Once the terminal
  // is 12 wide it answers that the cursor is on row 9: whether the wide row took three rows or still one
  // decides where the footer starts, and erasing from too high a row would take conversation with it.
  it.each([
    [true, 6],
    [false, 8],
  ])('rewrapping terminal: %s, erases from row %i', async (rewraps, top) => {
    const term = new FakeTerminal({ columns: 30, rows: 10 })
    term.cursor = { row: 1, col: 1 }
    const rows = new VStack([
      new Text('x'.repeat(28), { wrap: false }),
      new Text(`> ${CURSOR_MARKER}`),
      new Text('status'),
    ])
    const renderer = new FooterRenderer(term, rows, new Source(), 'region', rewraps)
    live.push(renderer)
    renderer.start()
    await tick()
    const before = term.writes.length
    term.cursor = { row: 9, col: 3 }
    term.resize(12, 10)
    await tick()
    expect(term.writes.slice(before).join('')).toContain(`\x1b[${top};1H\x1b[J`)
  })

  it('treats only Zellij as a terminal that cuts old rows off instead of wrapping them', () => {
    expect(rewrapsFooter({})).toBe(true)
    expect(rewrapsFooter({ TMUX: '/tmp/tmux-1/default,1,0' })).toBe(true)
    expect(rewrapsFooter({ ZELLIJ: '0' })).toBe(false)
  })
})
