import type { UINode, UITimeline } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { createAnsi } from '../../src/tui/ansi.js'
import { collectSlots } from '../../src/tui/slots.js'
import { displayWidth } from '../../src/tui/terminal.js'
import { renderBarChart, renderTable, ToolCard } from '../../src/tui/views/tool-card.js'

const node: Extract<UINode, { kind: 'tool' }> = {
  kind: 'tool',
  id: 't',
  seq: 1,
  toolUseId: 'call',
  name: 'read',
  status: 'completed',
  summary: 'read a file',
  argsPreview: '{"path":"中.txt"}',
  resultPreview: 'contents',
  enforcement: { level: 'partial', scope: ['file'] },
}
it('collapses by default and expands current protocol details without inventing missing values', () => {
  const card = new ToolCard(node)
  expect(card.render(40)).toHaveLength(1)
  expect(card.render(40)[0]).toContain('◆ 读取  read a file')
  card.toggle()
  const output = card.render(40).join('\n')
  expect(output).toContain('Arguments: {"path":"中.txt"}')
  expect(output).toContain('Result: contents')
  expect(output).toContain('Enforcement: partial (file)')
  expect(
    new ToolCard(
      { kind: 'tool', id: 'x', seq: 2, toolUseId: 'x', name: 'pending', status: 'planned', summary: '' },
      { collapsed: false },
    )
      .render(40)
      .join('\n'),
  ).not.toContain('Result:')
})
it('keeps narrow cards within the available columns and removes untrusted controls', () => {
  const card = new ToolCard({ ...node, resultPreview: 'a\x1b[2Jb' }, { collapsed: false })
  for (const width of [1, 4, 8, 40])
    expect(card.render(width).every((line) => displayWidth(line) === width)).toBe(true)
  expect(card.render(40).join('\n')).not.toContain('\x1b')
})

it('keeps the default collapsed headline to one bounded and escaped summary row', () => {
  const card = new ToolCard({
    ...node,
    summary: `first\nsecond ${'very-long '.repeat(20)}\x1b[2J`,
  })
  const output = card.render(48)
  expect(output).toHaveLength(1)
  expect(displayWidth(output[0] as string)).toBe(48)
  expect(output[0]).toContain('◆ 读取  first second')
  expect(output[0]).not.toContain('\n')
  expect(output[0]).not.toContain('\x1b')
})

const A = createAnsi('none')

it('colors the compact state glyph and the expanded title status on a colour tier', () => {
  const ansi = createAnsi('256')
  const mk = (status: Extract<UINode, { kind: 'tool' }>['status']) =>
    new ToolCard(
      { kind: 'tool', id: 'c', seq: 1, toolUseId: 'c', name: 'read', status, summary: 's' },
      { ansi },
    )
  // Collapsed single line: one semantic glyph carries completed state without repeating a word.
  const done = mk('completed').render(40)[0] as string
  expect(done).toContain('\x1b[38;5;78m◆\x1b[39m')
  expect(done).not.toContain('完成')
  expect(mk('running').render(40)[0]).toContain('\x1b[38;5;178m执行中\x1b[39m')
  expect(mk('failed').render(40)[0]).toContain('\x1b[38;5;203m失败\x1b[39m')
  // A planned row gets typography but no semantic foreground colour; the tool name is never
  // coloured by status.
  const planned = mk('planned').render(40)[0] as string
  expect(planned).not.toContain('\x1b[38;5;')
  expect(planned).toContain('\x1b[1m读取\x1b[22m')
  expect(done).not.toContain('\x1b[38;5;78m读取\x1b[39m')
  // Expanded: the frame stays quiet while the title status carries colour.
  const open = new ToolCard(
    { kind: 'tool', id: 'c', seq: 1, toolUseId: 'c', name: 'read', status: 'completed', summary: 's' },
    { ansi, collapsed: false },
  ).render(40)
  expect(open[0]).toContain('\x1b[2m╭\x1b[22m')
  expect(open[0]).toContain('\x1b[38;5;78m完成\x1b[39m')
  expect(open.at(-1)).toContain('\x1b[2m╰')
  expect(open[1]).toContain(' s ')
  // none tier: zero escapes anywhere.
  const plain = new ToolCard(
    { kind: 'tool', id: 'c', seq: 1, toolUseId: 'c', name: 'read', status: 'completed', summary: 's' },
    { ansi: createAnsi('none') },
  )
  expect(plain.render(40).join('\n')).not.toContain('\x1b')
})

it('renders a tool.card.inline table/chart/actions block when the card is expanded', () => {
  const acted: string[] = []
  const inline: Extract<UINode, { kind: 'tool' }> = {
    kind: 'tool',
    id: 't1',
    seq: 5,
    toolUseId: 'call',
    name: 'query',
    status: 'completed',
    summary: '3 rows',
    slots: [
      {
        slot: 'tool.card.inline',
        extId: 'xinwei/sales',
        requestSeq: 5,
        payload: {
          title: '本月销售',
          table: {
            columns: ['区', '额'],
            rows: [
              ['华东', '12'],
              ['华北', '9'],
            ],
          },
          chart: {
            kind: 'bar',
            series: [
              {
                name: '销售',
                points: [
                  { x: '华东', y: 12 },
                  { x: '华北', y: 9 },
                ],
              },
            ],
          },
          actions: [{ id: 'export', label: '导出' }],
        },
      },
    ],
  }
  const card = new ToolCard(inline, { ansi: A, onAction: (id) => acted.push(id) })
  expect(card.render(30)).toHaveLength(1)
  expect(card.render(30)[0]).toContain('◆ query  3 rows')
  card.toggle()
  const lines = card.render(30).map((l) => l.trimEnd())
  expect(lines.some((l) => l.includes('华东') && l.includes('12'))).toBe(true)
  expect(lines.some((l) => l.includes('█'))).toBe(true)
  expect(lines.some((l) => l.includes('[1] 导出'))).toBe(true)
  card.handleInput('1')
  expect(acted).toEqual(['export'])
})

it('a collapsed card ignores digit keys; onAction is never called without expanding', () => {
  const acted: string[] = []
  const inline: Extract<UINode, { kind: 'tool' }> = {
    kind: 'tool',
    id: 't2',
    seq: 6,
    toolUseId: 'call2',
    name: 'query',
    status: 'completed',
    summary: '',
    slots: [
      {
        slot: 'tool.card.inline',
        extId: 'e',
        requestSeq: 1,
        payload: { title: 't', actions: [{ id: 'export', label: 'Export' }] },
      },
    ],
  }
  const card = new ToolCard(inline, { onAction: (id) => acted.push(id) })
  expect(card.handleInput('1')).toBe(false)
  expect(acted).toEqual([])
})

it('renderTable and renderBarChart against the real slots payload shape', () => {
  expect(renderTable({ columns: ['a', 'b'], rows: [['1', '22']] }, 20).map((l) => l.trimEnd())).toEqual([
    'a │ b',
    '1 │ 22',
  ])
  // real chart series is `{ name, points: [{ x, y }] }`, not the flatter `{ label, value }` an
  // earlier illustrative draft assumed
  expect(
    renderBarChart(
      [
        {
          name: 's',
          points: [
            { x: 'x', y: 4 },
            { x: 'y', y: 2 },
          ],
        },
      ],
      14,
    )[0],
  ).toMatch(/^x █+ 4/)
})

it('collects status.line and sidebar.action across tool-attached and standalone slot nodes; notification ignored', () => {
  const timeline = {
    sessionId: 's',
    upto: 3,
    generation: 1,
    opState: null,
    turns: [],
    nodes: [
      {
        kind: 'tool',
        id: 'a',
        seq: 1,
        toolUseId: 'x',
        name: 'q',
        status: 'completed',
        summary: '',
        slots: [
          {
            slot: 'status.line',
            extId: 'e',
            requestSeq: 1,
            payload: { text: '数据截至 9/6', level: 'warn' },
          },
        ],
      },
      {
        kind: 'slot',
        id: 'n1',
        seq: 2,
        fill: { slot: 'notification', extId: 'e', requestSeq: 1, payload: { title: 'x', body: 'y' } },
      },
      {
        kind: 'slot',
        id: 'b',
        seq: 3,
        fill: {
          slot: 'sidebar.action',
          extId: 'e',
          requestSeq: 2,
          payload: { id: 'rerun', label: '重跑本月' },
        },
      },
    ],
  } as unknown as UITimeline
  const s = collectSlots(timeline)
  expect(s.status).toEqual([{ text: '数据截至 9/6', level: 'warn' }])
  // sidebar.action carries no requestSeq: the field belongs to the slot fill, not to the
  // client-minted value a real click sends.
  expect(s.actions).toEqual([{ id: 'rerun', label: '重跑本月' }])
})
