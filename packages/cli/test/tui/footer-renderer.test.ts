import { afterEach, describe, expect, it } from 'vitest'
import { CURSOR_MARKER, Text, VStack } from '../../src/tui/component.js'
import { FooterRenderer, type ScrollMode } from '../../src/tui/footer-renderer.js'
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
