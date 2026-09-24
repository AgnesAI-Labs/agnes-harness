import type { UINode } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { CURSOR_MARKER, Text, VStack } from '../../src/tui/component.js'
import { Renderer } from '../../src/tui/renderer.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { Timeline } from '../../src/tui/views/timeline.js'
import { ToolCard } from '../../src/tui/views/tool-card.js'
import { emulate, screenOf } from './harness.js'

describe('Renderer differential output', () => {
  // Replaying only the second frame onto a seeded screen shows both halves of the claim at once: the
  // changed row is addressed at the row it belongs to, and the unchanged row is not rewritten -- its
  // seed survives. Searching the escape stream for a substring would show neither.
  it('writes only changed lines on the second frame, at the row they belong to', async () => {
    const term = new FakeTerminal({ columns: 10, rows: 5 })
    const a = new Text('aaa')
    const b = new Text('bbb')
    const r = new Renderer(term, new VStack([a, b]))
    r.start()
    const first = term.writes.length
    b.set('ccc')
    r.renderNow()
    const seed = [1, 2, 3].map((row) => `\x1b[${row};1HZZZ`).join('')
    const screen = await emulate(term, 10, 5, { from: first, seed })
    expect(screen.lines.slice(0, 3)).toEqual(['ZZZ', 'ccc', 'ZZZ'])
  })

  it('positions the hardware cursor at CURSOR_MARKER', async () => {
    const term = new FakeTerminal({ columns: 10, rows: 3 })
    const r = new Renderer(term, new VStack([new Text('x'), new Text(`ab${CURSOR_MARKER}`, { wrap: false })]))
    r.start()
    const joined = term.writes.join('')
    expect(joined).not.toContain('\x00')
    expect((await screenOf(term, 10, 3))[1]).toBe('ab')
    const screen = await emulate(term, 10, 3)
    expect(screen.cursor).toEqual({ row: 1, col: 2 })
    expect(screen.cursorHidden).toBe(false)
  })

  it('re-renders everything on resize', async () => {
    const term = new FakeTerminal({ columns: 10, rows: 3 })
    const t = new Text('hello world foo')
    const r = new Renderer(term, new VStack([t]))
    r.start()
    expect((await emulate(term, 10, 3)).lines).toEqual(['hello', 'world foo', ''])
    const before = r.lastFrame.length
    term.resize(5, 3)
    expect(r.lastFrame.length).toBeGreaterThan(before)
    expect((await emulate(term, 5, 3)).lines).toEqual(['hello', 'world', 'foo'])
  })
})

// Every assertion below reads the screen a real emulator produced from the renderer's own bytes. A
// comparison against an expected escape string would only prove the renderer is consistent with the
// test author's idea of it.
describe('Renderer as a terminal actually draws it', () => {
  it('clears stale visible frames when a new renderer starts', async () => {
    const term = new FakeTerminal({ columns: 12, rows: 3 })
    new Renderer(term, new VStack([new Text('fresh')])).start()
    const screen = await emulate(term, 12, 3, { seed: 'STALE\r\nQueued: old' })
    expect(screen.lines).toEqual(['fresh', '', ''])
  })

  it('leaves no trace of a longer previous line after a shorter one replaces it', async () => {
    const term = new FakeTerminal({ columns: 12, rows: 3 })
    const t = new Text('OLD LONG LINE', { wrap: false })
    const r = new Renderer(term, new VStack([t]))
    r.start()
    expect((await emulate(term, 12, 3)).lines[0]).toBe('OLD LONG LIN')
    t.set('new')
    r.renderNow()
    expect((await emulate(term, 12, 3)).lines[0]).toBe('new')
  })

  it('drops a removed trailing line from the screen', async () => {
    const term = new FakeTerminal({ columns: 12, rows: 4 })
    const a = new Text('first')
    const b = new Text('second')
    const stack = new VStack([a, b])
    const r = new Renderer(term, stack)
    r.start()
    expect((await emulate(term, 12, 4)).lines.slice(0, 3)).toEqual(['first', 'second', ''])
    stack.remove(b)
    r.renderNow()
    expect((await emulate(term, 12, 4)).lines.slice(0, 3)).toEqual(['first', '', ''])
  })

  it('puts the cursor on the column the marker sits in, counting wide characters as two', async () => {
    const term = new FakeTerminal({ columns: 12, rows: 3 })
    const r = new Renderer(
      term,
      new VStack([new Text('head'), new Text(`中文a${CURSOR_MARKER}b`, { wrap: false })]),
    )
    r.start()
    const screen = await emulate(term, 12, 3)
    expect(screen.lines[1]).toBe('中文ab')
    expect(screen.cursor).toEqual({ row: 1, col: 5 })
    expect(screen.cursorHidden).toBe(false)
  })

  it('hides the cursor when no component asked for one', async () => {
    const term = new FakeTerminal({ columns: 12, rows: 3 })
    new Renderer(term, new VStack([new Text('only text')])).start()
    expect((await emulate(term, 12, 3)).cursorHidden).toBe(true)
  })

  it('a line exactly the terminal width does not push the next line down', async () => {
    const term = new FakeTerminal({ columns: 8, rows: 4 })
    const r = new Renderer(term, new VStack([new Text('abcdefgh', { wrap: false }), new Text('tail')]))
    r.start()
    const screen = await emulate(term, 8, 4)
    expect(screen.lines[0]).toBe('abcdefgh')
    expect(screen.lines[1]).toBe('tail')
  })

  it('a frame taller than the terminal shows its last rows, not a pile on the bottom one', async () => {
    const term = new FakeTerminal({ columns: 8, rows: 3 })
    const lines = ['l1', 'l2', 'l3', 'l4', 'l5'].map((s) => new Text(s))
    const r = new Renderer(term, new VStack(lines))
    r.start()
    expect((await emulate(term, 8, 3)).lines).toEqual(['l3', 'l4', 'l5'])
    expect(r.lastFrame).toEqual(['l3', 'l4', 'l5'])
  })

  it('repaints the whole screen after a resize instead of leaving the old width behind', async () => {
    const term = new FakeTerminal({ columns: 12, rows: 4 })
    const r = new Renderer(term, new VStack([new Text('alpha beta gamma')]))
    r.start()
    expect((await emulate(term, 12, 4)).lines.slice(0, 2)).toEqual(['alpha beta', 'gamma'])
    const mark = term.writes.length
    term.resize(6, 4)
    // Only the writes the resize produced are replayed, onto a screen already full of characters the
    // renderer never put there -- which is the situation a real resize leaves behind.
    const seed = [1, 2, 3, 4].map((row) => `\x1b[${row};1HZZZZZZ`).join('')
    const screen = await emulate(term, 6, 4, { from: mark, seed })
    expect(screen.lines).toEqual(['alpha', 'beta', 'gamma', ''])
  })

  // An erase or a cursor move that survives into a written row does not merely look wrong. The row the
  // renderer recorded is no longer the row on screen, so the next differential pass finds nothing to
  // repair and the corruption outlives the frame that caused it.
  it('an erase sequence in text is defanged into visible characters, not obeyed', async () => {
    const term = new FakeTerminal({ columns: 12, rows: 4 })
    const middle = new Text('a\x1b[2Jb', { wrap: false })
    const r = new Renderer(term, new VStack([new Text('top'), middle, new Text('bottom')]))
    r.start()
    expect((await emulate(term, 12, 4)).lines).toEqual(['top', 'a[2Jb', 'bottom', ''])
  })

  it('a cursor-move sequence in text cannot relocate the row being written', async () => {
    const term = new FakeTerminal({ columns: 12, rows: 4 })
    const r = new Renderer(
      term,
      new VStack([new Text('one'), new Text('x\x1b[5;10Hy', { wrap: false }), new Text('three')]),
    )
    r.start()
    expect((await emulate(term, 12, 4)).lines).toEqual(['one', 'x[5;10Hy', 'three', ''])
  })

  // The record of the frame has to be what is on the screen, not what the component offered. If they
  // differ, every later diff is computed against a screen that does not exist.
  it('remembers the defanged line, so a later frame still repairs the row', async () => {
    const term = new FakeTerminal({ columns: 12, rows: 4 })
    const middle = new Text('a\x1b[2Jb', { wrap: false })
    const r = new Renderer(term, new VStack([new Text('top'), middle]))
    r.start()
    expect(r.lastFrame).toEqual(['top', 'a[2Jb'])
    middle.set('clean')
    r.renderNow()
    expect((await emulate(term, 12, 4)).lines.slice(0, 2)).toEqual(['top', 'clean'])
  })

  it('keeps the styling a component asked for while removing everything else', async () => {
    const term = new FakeTerminal({ columns: 12, rows: 3 })
    const r = new Renderer(term, new VStack([new Text('\x1b[1mbold\x1b[22m', { wrap: false })]))
    r.start()
    expect(term.writes.join('')).toContain('\x1b[1mbold\x1b[22m')
    expect((await emulate(term, 12, 3)).lines[0]).toBe('bold')
  })

  // A resize that changes only the row count leaves every line identical, so the diff finds nothing
  // to write. The clear-screen still fired, so unless the frame record is discarded with it the
  // screen is wiped and never repainted. A columns-only resize cannot show this: there every row
  // differs anyway.
  it('repaints after a resize that changes the rows but not a single line', async () => {
    const term = new FakeTerminal({ columns: 12, rows: 6 })
    const r = new Renderer(term, new VStack([new Text('alpha')]))
    r.start()
    const mark = term.writes.length
    term.resize(12, 4)
    const seed = [1, 2, 3, 4].map((row) => `\x1b[${row};1HZZZZZZ`).join('')
    const screen = await emulate(term, 12, 4, { from: mark, seed })
    expect(screen.lines).toEqual(['alpha', '', '', ''])
  })

  it('a stray cursor marker or control byte in text never reaches the terminal', async () => {
    const term = new FakeTerminal({ columns: 12, rows: 3 })
    const r = new Renderer(
      term,
      new VStack([new Text(`a${CURSOR_MARKER}b${CURSOR_MARKER}c\x07d`, { wrap: false })]),
    )
    r.start()
    const joined = term.writes.join('')
    expect(joined).not.toContain('\x00')
    expect(joined).not.toContain('\x07')
    const screen = await emulate(term, 12, 3)
    expect(screen.lines[0]).toBe('abcd')
    expect(screen.cursor).toEqual({ row: 0, col: 1 })
  })
})

describe('Renderer bookkeeping', () => {
  it('writes nothing at all when a frame is identical to the last', () => {
    const term = new FakeTerminal({ columns: 10, rows: 4 })
    const r = new Renderer(term, new VStack([new Text('same')]))
    r.start()
    const before = term.writes.length
    r.renderNow()
    r.renderNow()
    expect(term.writes.length).toBe(before)
  })

  it('coalesces many requestRender calls into one repaint', async () => {
    const term = new FakeTerminal({ columns: 10, rows: 4 })
    const t = new Text('a')
    const r = new Renderer(term, new VStack([t]))
    r.start()
    const before = term.writes.length
    for (const ch of ['b', 'c', 'd']) {
      t.set(ch)
      r.requestRender()
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(term.writes.length).toBe(before + 1)
    expect(r.lastFrame).toEqual(['d'])
  })

  it('feeds input to the root and repaints when it was consumed', async () => {
    const term = new FakeTerminal({ columns: 10, rows: 4 })
    const seen: string[] = []
    const root = {
      lines: ['a'],
      render(): string[] {
        return this.lines
      },
      handleInput(d: string): boolean {
        seen.push(d)
        this.lines = [d]
        return d !== 'ignored'
      },
      invalidate(): void {},
    }
    const r = new Renderer(term, root)
    r.start()
    const before = term.writes.length
    term.feed('k')
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual(['k'])
    expect(term.writes.length).toBe(before + 1)
  })

  it('stop unsubscribes, shows the cursor and leaves raw mode', () => {
    const term = new FakeTerminal({ columns: 10, rows: 4 })
    const t = new Text('a')
    const r = new Renderer(term, new VStack([t]))
    r.start()
    expect(term.raw).toBe(true)
    r.stop()
    expect(term.raw).toBe(false)
    expect(term.writes.at(-1)).toContain('\x1b[?25h')
    const after = term.writes.length
    term.feed('k')
    term.resize(4, 4)
    expect(term.writes.length).toBe(after)
  })

  it('does not push a full-height fixed chrome frame into scrollback on stop', async () => {
    const term = new FakeTerminal({ columns: 20, rows: 4 })
    term.write('USER HISTORY\r\none\r\ntwo\r\nthree\r\nfour')
    const renderer = new Renderer(
      term,
      new VStack([new Text('HEADER'), new Text('EDITOR'), new Text('STATUS'), new Text('HINTS')]),
    )
    renderer.start()
    renderer.stop()
    term.write('$ prompt')
    const screen = await emulate(term, 20, 4)
    expect(screen.scrollback).toContain('USER HISTORY')
    expect(screen.scrollback.join('\n')).not.toContain('HEADER')
    expect(screen.scrollback.join('\n')).not.toContain('EDITOR')
    expect(screen.lines).toEqual(['one', 'two', 'three', 'four$ prompt'])
    expect(screen.cursorHidden).toBe(false)
  })
})

it('a queued repaint cannot write after stop returned control to the shell', async () => {
  const term = new FakeTerminal({ columns: 20, rows: 4 })
  const text = new Text('before')
  const renderer = new Renderer(term, new VStack([text]))
  renderer.start()
  text.set('late overwrite')
  renderer.requestRender()
  renderer.stop()
  const count = term.writes.length
  await Promise.resolve()
  expect(term.writes).toHaveLength(count)
  expect(term.raw).toBe(false)
  renderer.requestRender()
  renderer.stop()
  await Promise.resolve()
  expect(term.writes).toHaveLength(count)
})

it('restart repaints its screen and stale queued work does not consume the new repaint', async () => {
  const term = new FakeTerminal({ columns: 20, rows: 4 })
  const text = new Text('before')
  const renderer = new Renderer(term, new VStack([text]))
  renderer.start()
  renderer.requestRender()
  renderer.stop()
  renderer.start()
  text.set('after restart')
  renderer.requestRender()
  await Promise.resolve()
  expect((await screenOf(term, 20, 4))[0]).toBe('after restart')
  renderer.stop()
})

it('outputs safe transcript once after restoring the shell, never the active frame', async () => {
  const term = new FakeTerminal({ columns: 20, rows: 5 })
  const renderer = new Renderer(term, new VStack([new Text('HEADER'), new Text('EDITOR')]))
  renderer.start()
  renderer.renderNow()
  expect((await emulate(term, 20, 5)).scrollback).toEqual([])
  renderer.stop(['history one', 'history two'])
  renderer.stop(['duplicate'])
  const screen = await emulate(term, 20, 5)
  expect(screen.lines).toEqual(['history one', 'history two', '', '', ''])
  expect(term.raw).toBe(false)
  const count = term.writes.length
  renderer.renderNow()
  renderer.requestRender()
  await Promise.resolve()
  expect(term.writes).toHaveLength(count)
})
it('wraps exit lines and removes executable control sequences', async () => {
  const term = new FakeTerminal({ columns: 5, rows: 4 })
  const renderer = new Renderer(term, new VStack([new Text('live')]))
  renderer.start()
  renderer.stop(['1234567890', '\x1b[31mred\x1b[0m', '\x1b[2J', '  x'])
  const screen = await emulate(term, 5, 4)
  expect([...screen.scrollback, ...screen.lines].filter(Boolean)).toEqual([
    '12345',
    '67890',
    'red',
    '[2J',
    '  x',
  ])
})
it('exits with only the current tool state after planned and running updates', async () => {
  type ToolNode = Extract<UINode, { kind: 'tool' }>
  const term = new FakeTerminal({ columns: 50, rows: 2 })
  const timeline = new Timeline({
    rows: () => term.size().rows,
    reservedRows: () => 0,
    nodeView: (node) => (node.kind === 'tool' ? new ToolCard(node) : new Text(node.id)),
  })
  const renderer = new Renderer(term, timeline)
  renderer.start()
  for (const status of ['planned', 'running', 'completed'] as const) {
    const node: ToolNode = {
      kind: 'tool',
      id: 'tool',
      seq: 1,
      toolUseId: 'call',
      name: 'read',
      status,
      summary: 'README.md',
    }
    timeline.apply({ sessionId: 's', generation: 1, upto: 1, opState: null, nodes: [node], turns: [] })
    renderer.renderNow()
  }
  expect((await emulate(term, 50, 2)).scrollback).toEqual([])
  renderer.stop(timeline.transcript(50))
  const screen = await emulate(term, 50, 2)
  expect([...screen.scrollback, ...screen.lines].filter(Boolean)).toEqual([
    expect.stringContaining('◆ 读取  README.md'),
  ])
})
