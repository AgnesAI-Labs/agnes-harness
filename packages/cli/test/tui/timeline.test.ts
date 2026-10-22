import type { UINode, UITimeline } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { Text } from '../../src/tui/component.js'
import { Timeline } from '../../src/tui/views/timeline.js'

const user = (id: string, text: string): UINode => ({
  id,
  kind: 'user',
  seq: 1,
  content: [{ type: 'text', text }],
})
const timeline = (nodes: UINode[]): UITimeline => ({
  sessionId: 's',
  generation: 1,
  upto: 1,
  opState: null,
  nodes,
  turns: [],
})
const view = (node: UINode) =>
  new Text(
    node.kind === 'user'
      ? node.content.map((block) => (block.type === 'text' ? block.text : block.type)).join('')
      : node.kind === 'tool'
        ? node.status
        : node.kind === 'assistant'
          ? node.text
          : node.kind === 'approval'
            ? node.state
            : node.id,
  )

it('reuses unchanged nodes and updates full current user/content and tool/status shapes', () => {
  const factory = vi.fn(view)
  const t = new Timeline({ rows: () => 24, nodeView: factory })
  const tool: UINode = {
    kind: 'tool',
    id: 't',
    seq: 2,
    toolUseId: 'call',
    name: 'write',
    status: 'running',
    summary: '',
  }
  t.apply(timeline([user('u', 'first'), tool]))
  t.apply(timeline([user('u', 'first'), tool]))
  expect(factory).toHaveBeenCalledTimes(2)
  t.apply(timeline([user('u', 'changed'), { ...tool, status: 'completed' }]))
  expect(t.render(30)).toEqual(['changed', 'completed'])
  expect(factory).toHaveBeenCalledTimes(4)
  t.apply(timeline([{ ...tool, status: 'completed' }, user('u', 'changed')]))
  expect(t.render(30)).toEqual(['completed', 'changed'])
  expect(factory).toHaveBeenCalledTimes(4)
  t.apply(timeline([user('u', 'changed')]))
  expect(t.render(30)).toEqual(['changed'])
})
it('uses the default five reserved rows and clamps scrolling in both directions', () => {
  const t = new Timeline({ rows: () => 8, nodeView: view })
  t.apply(timeline([1, 2, 3, 4].map((n) => user(String(n), String(n)))))
  expect(t.render(30)).toEqual(['2', '3', '4'])
  t.scroll(-1)
  expect(t.render(30)).toEqual(['1', '2', '3'])
  t.scroll(-100)
  expect(t.render(30)).toEqual(['1', '2', '3'])
  t.scroll(100)
  expect(t.render(30)).toEqual(['2', '3', '4'])
})
it('reflows at the actual width and updates the window when the terminal resizes', () => {
  let rows = 8
  const t = new Timeline({ rows: () => rows, nodeView: view })
  t.apply(timeline([user('u', 'one two three four')]))
  expect(t.render(5)).toEqual(['two', 'three', 'four'])
  rows = 10
  expect(t.render(5)).toEqual(['one', 'two', 'three', 'four'])
  expect(t.render(30)).toEqual(['one two three four'])
  rows = 1
  expect(t.render(5)).toEqual(['four'])
})
it('does not let a component mutate the source projection', () => {
  const source = timeline([user('u', 'original')])
  const t = new Timeline({
    rows: () => 8,
    nodeView: (node) => {
      node.id = 'changed'
      return view(node)
    },
  })
  t.apply(source)
  expect(source.nodes[0]?.id).toBe('u')
})

it('snapshots only current rows across repaint, deletion, reorder and reappearance', () => {
  const t = new Timeline({ rows: () => 8, nodeView: view })
  const nodes = [1, 2, 3, 4].map((n) => user(String(n), String(n)))
  t.apply(timeline(nodes))
  t.render(30)
  expect(t.transcript(30)).toEqual(['1', '2', '3', '4'])
  t.apply(timeline([...nodes.slice(1), user('5', '5')]))
  t.render(30)
  expect(t.transcript(30)).toEqual(['2', '3', '4', '5'])
  t.apply(timeline(nodes))
  expect(t.transcript(30)).toEqual(['1', '2', '3', '4'])
})

it('reflows the current snapshot without accumulating resize copies', () => {
  const t = new Timeline({ rows: () => 8, nodeView: view })
  t.apply(timeline([user('u', 'one two three four')]))
  for (const width of [5, 30, 5, 30]) {
    t.render(width)
    expect(t.transcript(width).join(' ')).toBe('one two three four')
  }
})

it('shows the welcome banner only for an empty conversation and excludes it from exit text', () => {
  const t = new Timeline({ rows: () => 8, nodeView: view, top: new Text('BRAND') })
  t.apply(timeline([]))
  expect(t.render(30)).toEqual(['BRAND'])
  t.apply(timeline([1, 2, 3, 4].map((n) => user(String(n), String(n)))))
  expect(t.render(30)).toEqual(['2', '3', '4'])
  expect(t.transcript(30)).toEqual(['1', '2', '3', '4'])
})

it('reserves the current measured footer height while retaining the legacy default', () => {
  let reserved = 6
  const t = new Timeline({ rows: () => 12, reservedRows: () => reserved, nodeView: view })
  t.apply(timeline(Array.from({ length: 10 }, (_, i) => user(String(i), String(i)))))
  expect(t.render(30)).toHaveLength(6)
  reserved = 9
  expect(t.render(30)).toEqual(['7', '8', '9'])
  reserved = 6
  expect(t.render(30)).toHaveLength(6)
})

it('replaces mutable tool, approval and assistant snapshots instead of appending versions', () => {
  const t = new Timeline({ rows: () => 2, reservedRows: () => 0, nodeView: view })
  const tail = [user('tail-1', 'tail 1'), user('tail-2', 'tail 2')]
  const shapes: Array<{ intermediate: UINode; terminal: UINode; expected: string }> = [
    {
      intermediate: {
        kind: 'tool',
        id: 'mutable-tool',
        seq: 2,
        toolUseId: 'call',
        name: 'read',
        status: 'planned',
        summary: 'file',
      },
      terminal: {
        kind: 'tool',
        id: 'mutable-tool',
        seq: 2,
        toolUseId: 'call',
        name: 'read',
        status: 'completed',
        summary: 'file',
      },
      expected: 'completed',
    },
    {
      intermediate: {
        kind: 'approval',
        id: 'mutable-approval',
        seq: 3,
        state: 'pending',
        summary: 'allow?',
        risk: 'unknown',
        options: ['reject_once'],
      },
      terminal: {
        kind: 'approval',
        id: 'mutable-approval',
        seq: 3,
        state: 'decided',
        summary: 'allow?',
        risk: 'unknown',
        options: ['reject_once'],
        decision: { verdict: 'rejected', via: 'local' },
      },
      expected: 'decided',
    },
    {
      intermediate: {
        kind: 'assistant',
        id: 'mutable-assistant',
        seq: 4,
        text: 'partial',
        streaming: true,
      },
      terminal: {
        kind: 'assistant',
        id: 'mutable-assistant',
        seq: 4,
        text: 'done',
        streaming: false,
      },
      expected: 'done',
    },
  ]

  for (const shape of shapes) {
    t.apply(timeline([shape.intermediate, ...tail]))
    t.render(40)
    expect(t.transcript(40)).toHaveLength(3)
    t.apply(timeline([shape.terminal, ...tail]))
    t.render(40)
    expect(t.transcript(40)).toEqual([shape.expected, 'tail 1', 'tail 2'])
    t.render(40)
    expect(t.transcript(40)).toEqual([shape.expected, 'tail 1', 'tail 2'])
  }
})

it('windows an opening snapshot and retains one current copy for paging', () => {
  const t = new Timeline({ rows: () => 2, reservedRows: () => 0, nodeView: view })
  const history = Array.from({ length: 1_002 }, (_, index) =>
    user(`history-${index + 1}`, `history ${index + 1}`),
  )
  t.apply(timeline(history), { opening: true })
  expect(t.render(40)).toEqual(['history 1001', 'history 1002'])
  t.apply(timeline([...history, user('live', 'live')]))
  expect(t.render(40)).toEqual(['history 1002', 'live'])
  expect(t.transcript(40)).toHaveLength(1_003)
  t.scroll(-10000)
  expect(t.render(40)).toEqual(['history 1', 'history 2'])
})

it('does not carry transcript or viewport state across a session switch', () => {
  const t = new Timeline({ rows: () => 2, reservedRows: () => 0, nodeView: view })
  t.apply({
    ...timeline([user('same', 'old'), user('old-2', 'old 2'), user('old-3', 'old 3')]),
    sessionId: 'old',
  })
  t.render(40)
  t.scroll(-100)
  t.apply(
    {
      ...timeline([user('same', 'new'), user('new-2', 'new 2'), user('new-3', 'new 3')]),
      sessionId: 'new',
    },
    { opening: true },
  )
  expect(t.render(40)).toEqual(['new 2', 'new 3'])
  expect(t.transcript(40)).toEqual(['new', 'new 2', 'new 3'])
})

it('anchors local transcript rows at the current cut and clears them on session switch', () => {
  const t = new Timeline({ rows: () => 20, reservedRows: () => 0, nodeView: view })
  t.apply(timeline([user('one', 'one')]))
  t.appendLocal('s', new Text('› /sessions\nfirst\nsecond'))
  t.apply({
    ...timeline([user('one', 'one'), { ...user('two', 'two'), seq: 2 }]),
    upto: 2,
  })
  expect(t.render(40)).toEqual(['one', '› /sessions', 'first', 'second', 'two'])

  t.apply({ ...timeline([user('new', 'new')]), sessionId: 'new-session' })
  expect(t.render(40)).toEqual(['new'])
})

it('includes local output once in the exit snapshot independently of the viewport', () => {
  const t = new Timeline({ rows: () => 2, reservedRows: () => 0, nodeView: view })
  t.apply(timeline([user('one', 'one')]))
  t.appendLocal('s', new Text('local one\nlocal two\nlocal three'))
  expect(t.render(40)).toEqual(['local two', 'local three'])
  expect(t.transcript(40)).toEqual(['one', 'local one', 'local two', 'local three'])
  t.render(40)
  expect(t.transcript(40)).toEqual(['one', 'local one', 'local two', 'local three'])
})

it('keeps one terminal tool headline when its summary or slots are enriched', () => {
  const t = new Timeline({ rows: () => 2, reservedRows: () => 0, nodeView: view })
  const base: Extract<UINode, { kind: 'tool' }> = {
    kind: 'tool',
    id: 'terminal-tool',
    seq: 2,
    toolUseId: 'call',
    name: 'query',
    status: 'completed',
    summary: 'done',
  }
  const tail = [user('tail-1', 'tail 1'), user('tail-2', 'tail 2')]
  t.apply(timeline([base, ...tail]))
  t.render(40)
  expect(t.transcript(40)).toEqual(['completed', 'tail 1', 'tail 2'])
  t.apply(
    timeline([
      {
        ...base,
        summary: 'done with late surface fill',
        slots: [
          {
            slot: 'status.line',
            extId: 'example/ext',
            requestSeq: 9,
            payload: { text: 'ready', level: 'info' },
          },
        ],
      },
      ...tail,
    ]),
  )
  t.render(40)
  expect(t.transcript(40)).toEqual(['completed', 'tail 1', 'tail 2'])
})

it('requests an earlier page only when PageUp reaches the loaded window boundary', () => {
  const t = new Timeline({ rows: () => 2, reservedRows: () => 0, nodeView: view })
  t.apply(
    timeline([
      user('tail-1', 'tail 1'),
      user('tail-2', 'tail 2'),
      user('tail-3', 'tail 3'),
      user('tail-4', 'tail 4'),
    ]),
    { hasEarlier: true },
  )
  expect(t.render(40)).toEqual(['tail 3', 'tail 4'])
  expect(t.scroll(-1)).toBe(false)
  expect(t.scroll(-2)).toBe(true)
  expect(t.render(40)).toEqual(['↑ Earlier history · PgUp to load', 'tail 1'])
  expect(t.scroll(2)).toBe(false)
})

it('localizes the earlier-history hint', () => {
  const options = {
    rows: () => 2,
    reservedRows: () => 0,
    nodeView: view,
    locale: 'zh-CN',
  }
  const t = new Timeline(options)
  t.apply(timeline([]), { hasEarlier: true })
  expect(t.render(40)).toEqual(['↑ 更早的记录 · PgUp 加载'])
})

it('offers the way back only when output arrived while scrolled up, and End or Ctrl-End returns to the bottom', () => {
  const t = new Timeline({ rows: () => 8, nodeView: view, locale: 'zh-CN' })
  const nodes = [1, 2, 3, 4, 5, 6].map((n) => user(String(n), String(n)))
  t.apply(timeline(nodes.slice(0, 5)))
  t.render(30)
  expect(t.newOutputHint(false)).toBeUndefined()
  // Scrolling up over unchanged content has nothing new to announce.
  t.scroll(-1)
  t.render(30)
  expect(t.newOutputHint(false)).toBeUndefined()
  t.apply(timeline(nodes))
  expect(t.newOutputHint(false)).toBe('↓ 有新内容 · End 回到底部')
  expect(t.newOutputHint(true)).toBe('↓ 有新内容 · Ctrl-End 回到底部')
  expect(t.render(30)).toEqual(['3', '4', '5'])
  // With a draft End is the cursor's; only Ctrl-End jumps.
  expect(t.jumpKey('end', true)).toBe(false)
  expect(t.jumpKey('left', false)).toBe(false)
  expect(t.newOutputHint(true)).toBeDefined()
  expect(t.jumpKey('end', false)).toBe(true)
  expect(t.render(30)).toEqual(['4', '5', '6'])
  expect(t.newOutputHint(false)).toBeUndefined()
  t.scroll(-1)
  t.apply(timeline([...nodes, user('7', '7')]))
  expect(t.newOutputHint(false)).toBeDefined()
  expect(t.jumpKey('ctrl-end', true)).toBe(true)
  expect(t.render(30)).toEqual(['5', '6', '7'])
  // Scrolling back down by hand also clears it.
  t.scroll(-1)
  t.apply(timeline([...nodes, user('7', '7'), user('8', '8')]))
  t.scroll(1)
  expect(t.newOutputHint(false)).toBeUndefined()
})

// Split footer (--no-alt-screen): what leaves for native scrollback, and when.
const at = (seq: number, node: UINode): UINode => ({ ...node, seq }) as UINode
const assistant = (id: string, seq: number, text: string, streaming: boolean): UINode => ({
  kind: 'assistant',
  id,
  seq,
  text,
  streaming,
})
const tool = (id: string, seq: number, status: 'running' | 'completed', name = 'write'): UINode => ({
  kind: 'tool',
  id,
  seq,
  toolUseId: id,
  name,
  status,
  summary: '',
})
const approval = (id: string, seq: number, state: 'pending' | 'decided'): UINode => ({
  kind: 'approval',
  id,
  seq,
  state,
  summary: id,
  risk: 'unknown',
  options: [],
})
const splitTimeline = () => new Timeline({ rows: () => 20, nodeView: view, split: true })
const idleAt = (nodes: UINode[]): UITimeline => timeline(nodes)
const busyAt = (nodes: UINode[]): UITimeline => ({
  ...timeline(nodes),
  opState: { turn: 1, step: 1, phase: 'inference' } as never,
})

it('hands out each settled entry once, in projection order, and keeps the first unsettled one and its successors back', () => {
  const t = splitTimeline()
  t.apply(
    busyAt([
      at(1, user('u', 'ask')),
      assistant('a', 2, '', true),
      tool('t', 3, 'running'),
      approval('p', 4, 'pending'),
    ]),
  )
  expect(t.takeSettled(30)).toEqual(['', 'ask'])
  expect(t.takeSettled(30)).toEqual([])
  // The reply settles but the tool after it has not: only the reply leaves. Nothing is repeated.
  t.apply(
    busyAt([
      user('u', 'ask'),
      assistant('a', 5, 'answer', false),
      tool('t', 3, 'running'),
      approval('p', 4, 'pending'),
    ]),
  )
  expect(t.takeSettled(30)).toEqual(['', 'answer'])
  t.apply(
    busyAt([
      user('u', 'ask'),
      assistant('a', 5, 'answer', false),
      tool('t', 3, 'completed'),
      approval('p', 4, 'pending'),
    ]),
  )
  expect(t.takeSettled(30)).toEqual(['', 'completed'])
  expect(t.render(30)).toEqual(['pending'])
  t.apply(
    idleAt([
      user('u', 'ask'),
      assistant('a', 5, 'answer', false),
      tool('t', 3, 'completed'),
      approval('p', 4, 'decided'),
    ]),
  )
  expect(t.takeSettled(30)).toEqual(['', 'decided'])
  expect(t.render(30)).toEqual([])
})

it('never rewrites an entry the projection changes afterwards, nor writes one that appears behind a written one', () => {
  const t = splitTimeline()
  t.apply(idleAt([at(1, user('u', 'ask')), tool('t', 2, 'completed')]))
  expect(t.takeSettled(30)).toEqual(['', 'ask', '', 'completed'])
  t.apply(idleAt([user('u', 'edited'), { ...tool('t', 2, 'completed'), summary: 'later review' } as UINode]))
  expect(t.takeSettled(30)).toEqual([])
  t.apply(
    idleAt([user('early', 'late arrival'), user('u', 'edited'), tool('t', 2, 'completed'), user('n', 'new')]),
  )
  expect(t.takeSettled(30)).toEqual(['', 'new'])
})

it('keeps a trailing read-only call back while the turn runs, since the next one folds into its group', () => {
  const t = new Timeline({
    rows: () => 20,
    nodeView: view,
    groupView: (nodes) => new Text(`group of ${nodes.length}`),
    split: true,
  })
  t.apply(busyAt([user('u', 'ask'), tool('r1', 2, 'completed', 'read')]))
  expect(t.takeSettled(30)).toEqual(['', 'ask'])
  t.apply(busyAt([user('u', 'ask'), tool('r1', 2, 'completed', 'read'), tool('r2', 3, 'completed', 'read')]))
  expect(t.takeSettled(30)).toEqual([])
  t.apply(idleAt([user('u', 'ask'), tool('r1', 2, 'completed', 'read'), tool('r2', 3, 'completed', 'read')]))
  expect(t.takeSettled(30)).toEqual(['', 'group of 2'])
})

it('places connection-local output by the seq it follows, writes the unsettled only at exit, and starts over for another session', () => {
  const t = splitTimeline()
  t.apply(idleAt([at(1, user('u', 'ask')), assistant('a', 2, '', true)]))
  t.appendLocal('s', new Text('/help output'), 1)
  expect(t.takeSettled(30)).toEqual(['', 'ask', '', '/help output'])
  expect(t.takeSettled(30, true)).toEqual(['', ''])
  t.apply({ ...timeline([user('u', 'ask')]), sessionId: 'other' })
  expect(t.takeSettled(30)).toEqual(['', 'ask'])
})

it('shows only the entries not yet written, the welcome only before anything was, and no scroll state', () => {
  const t = new Timeline({ rows: () => 20, nodeView: view, top: new Text('BRAND'), split: true })
  t.apply(idleAt([]))
  expect(t.render(30)).toEqual(['BRAND'])
  t.apply(busyAt([user('u', 'ask'), assistant('a', 2, '', true)]))
  t.takeSettled(30)
  expect(t.render(30)).toEqual([''])
  expect(t.scroll(-3)).toBe(false)
  expect(t.jumpKey('end', false)).toBe(false)
})
