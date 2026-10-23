import type { UINode, UITimeline } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { createAnsi } from '../src/ansi.js'
import { CardFocus } from '../src/card-focus.js'
import { Text } from '../src/component.js'
import { TuiTheme } from '../src/theme.js'
import { ToolCards } from '../src/tool-cards.js'
import { Timeline } from '../src/views/timeline.js'

const ansi = new TuiTheme('mono').ansi(createAnsi('none'))
const CTRL_X = '\x18'
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const ESC = '\x1b'

const user = (id: string, seq: number): UINode => ({
  kind: 'user',
  id,
  seq,
  content: [{ type: 'text', text: id }],
})
const tool = (id: string, seq: number, name = 'shell'): UINode => ({
  kind: 'tool',
  id,
  seq,
  toolUseId: id,
  name,
  status: 'completed',
  summary: id,
  argsPreview: `{"cmd":"${id}"}`,
})
const tl = (nodes: UINode[]): UITimeline =>
  ({
    sessionId: 's',
    generation: 1,
    upto: nodes.length,
    opState: null,
    nodes,
    turns: [],
  }) as unknown as UITimeline

function rig(locale = 'en', rows = 10) {
  const cards = new ToolCards({
    ansi,
    locale,
    // A record that never arrives: an opened card says it is loading and keeps its preview.
    session: () => ({ id: 's', readToolDetail: () => new Promise(() => {}) }),
    closed: () => false,
    changed: () => {},
    onAction: () => {},
  })
  const timeline = new Timeline({
    rows: () => rows,
    reservedRows: () => 2,
    groupView: (nodes) => cards.group(nodes),
    nodeView: (node) =>
      node.kind === 'tool' ? cards.view(node) : new Text(node.kind === 'user' ? node.id : node.kind),
  })
  const notices: string[] = []
  const focus = new CardFocus({
    timeline,
    cards,
    ansi,
    locale,
    notice: (text) => notices.push(text),
    changed: () => {},
  })
  const feed = (nodes: UINode[]) => {
    const value = tl(nodes)
    cards.sync(value)
    timeline.apply(value)
  }
  const screen = () => timeline.render(60).map((row) => row.trimEnd())
  const marked = () => screen().filter((row) => row.startsWith('▌'))
  return { cards, timeline, focus, feed, screen, marked, notices }
}

const many = (n: number): UINode[] => Array.from({ length: n }, (_, i) => tool(`t${i}`, i + 1))

describe('card focus', () => {
  it('lands on the newest card and marks it with a bar', () => {
    const { focus, feed, marked } = rig()
    feed([user('u', 1), tool('a', 2), tool('b', 3)])
    focus.enter()
    expect(focus.open).toBe(true)
    expect(marked()).toHaveLength(1)
    expect(marked()[0]).toContain('b')
    expect(focus.render(80)[0]).toContain('Esc/Ctrl-X leave')
  })

  it('says so when there is no card, and does not start', () => {
    const { focus, feed, notices } = rig('zh-CN')
    feed([user('u', 1)])
    focus.enter()
    expect(focus.open).toBe(false)
    expect(notices).toEqual(['没有可聚焦的工具卡'])
  })

  it('steps between cards with the arrows and stops at both ends', () => {
    const { focus, feed, marked } = rig()
    feed(many(3))
    focus.enter()
    expect(marked()[0]).toContain('t2')
    focus.handleInput(UP)
    expect(marked()[0]).toContain('t1')
    focus.handleInput(UP)
    focus.handleInput(UP)
    expect(marked()[0]).toContain('t0')
    focus.handleInput(DOWN)
    focus.handleInput(DOWN)
    focus.handleInput(DOWN)
    expect(marked()[0]).toContain('t2')
  })

  it('opens and folds one card with Enter or space, and every card with a and z', () => {
    const { focus, feed, screen } = rig('en', 40)
    feed(many(3))
    const folded = screen().length
    focus.enter()
    focus.handleInput('\r')
    const one = screen().length
    expect(one).toBeGreaterThan(folded)
    expect(screen().join('\n')).toContain('Arguments:')
    focus.handleInput(' ')
    expect(screen()).toHaveLength(folded)
    focus.handleInput('a')
    expect(screen().filter((row) => row.includes('Arguments:'))).toHaveLength(3)
    focus.handleInput('z')
    expect(screen()).toHaveLength(folded)
  })

  it('swallows every other key, so nothing reaches the draft', () => {
    const { focus, feed } = rig()
    feed(many(1))
    focus.enter()
    for (const key of ['h', 'e', '\x7f', '\t', '/', '\x1b[5~', '\x1b[200~paste\x1b[201~'])
      expect(focus.handleInput(key)).toBe(true)
    expect(focus.open).toBe(true)
  })

  it('keeps the focus on its card when a new card arrives', () => {
    const { focus, feed, marked } = rig()
    feed(many(2))
    focus.enter()
    focus.handleInput(UP)
    expect(marked()[0]).toContain('t0')
    feed([...many(2), tool('fresh', 9)])
    expect(marked()).toHaveLength(1)
    expect(marked()[0]).toContain('t0')
    focus.handleInput(DOWN)
    focus.handleInput(DOWN)
    expect(marked()[0]).toContain('fresh')
  })

  it('scrolls the focused card into view, and leaving puts the viewport back', () => {
    const { focus, feed, timeline, screen } = rig()
    feed(many(12))
    // The reader had scrolled up three rows before pressing Ctrl-X.
    timeline.scroll(-3)
    const before = screen()
    focus.enter()
    for (let i = 0; i < 11; i++) focus.handleInput(UP)
    expect(screen().some((row) => row.startsWith('▌') && row.includes('t0'))).toBe(true)
    expect(screen()).not.toEqual(before)
    focus.handleInput(ESC)
    expect(focus.open).toBe(false)
    expect(screen()).toEqual(before)
    expect(screen().some((row) => row.startsWith('▌'))).toBe(false)
  })

  it('returns to the tail on exit when it started there, Ctrl-X also leaves, and Ctrl-C falls through', () => {
    const { focus, feed, screen } = rig()
    feed(many(12))
    const tail = screen()
    focus.enter()
    for (let i = 0; i < 11; i++) focus.handleInput(UP)
    expect(focus.handleInput(CTRL_X)).toBe(true)
    expect(focus.open).toBe(false)
    expect(screen()).toEqual(tail)
    focus.enter()
    expect(focus.handleInput('\x03')).toBe(false)
    expect(focus.open).toBe(false)
  })

  it('leaves by itself when the cards are gone', () => {
    const { focus, feed } = rig()
    feed(many(2))
    focus.enter()
    feed([user('u', 1)])
    focus.handleInput(DOWN)
    expect(focus.open).toBe(false)
  })
})

describe('/expand', () => {
  it('opens and folds every card, leaving cards inside a read-only group alone', () => {
    const { cards, feed, screen } = rig('en', 40)
    const read = (id: string, seq: number): UINode => tool(id, seq, 'read')
    feed([tool('a', 1), read('r1', 2), read('r2', 3), tool('b', 4)])
    const folded = screen()
    cards.setAll(true)
    expect(screen().filter((row) => row.includes('Arguments:'))).toHaveLength(2)
    expect(screen().length).toBeGreaterThan(folded.length)
    cards.setAll(false)
    expect(screen()).toEqual(folded)
  })
})
