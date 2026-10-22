import type { ToolDetailState } from '@agnes/cli-tui'
import { childFacts } from '@agnes/cli-tui'
import type { UINode, UITimeline } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { createAnsi } from '../../src/tui/ansi.js'
import { collectSlots } from '../../src/tui/slots.js'
import { displayWidth } from '../../src/tui/terminal.js'
import { TuiTheme } from '../../src/tui/theme.js'
import { renderBarChart, ToolCard } from '../../src/tui/views/tool-card.js'

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
  expect(card.render(40)).toHaveLength(2)
  expect(card.render(40)[0]).toContain('◆ read  read a file')
  expect(card.render(40)[1]).toContain('    contents')
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
  expect(output).toHaveLength(2) // the headline row, then the one-line result preview
  expect(displayWidth(output[0] as string)).toBe(48)
  expect(output[0]).toContain('◆ read  first second')
  expect(output[0]).not.toContain('\n')
  expect(output[0]).not.toContain('\x1b')
})

const A = new TuiTheme('mono').ansi(createAnsi('none'))
const opener = (styled: string): string => styled.slice(0, styled.indexOf('\x1b[', 1))

it('colors the compact state glyph and the expanded title status on a colour tier', () => {
  const ansi = new TuiTheme('dark').ansi(createAnsi('256'))
  const mk = (status: Extract<UINode, { kind: 'tool' }>['status']) =>
    new ToolCard(
      { kind: 'tool', id: 'c', seq: 1, toolUseId: 'c', name: 'read', status, summary: 's' },
      { ansi },
    )
  // Collapsed single line: one semantic glyph carries completed state without repeating a word.
  const done = mk('completed').render(40)[0] as string
  expect(done).toContain(ansi.fg('success', '◆'))
  expect(done).not.toContain('完成')
  expect(mk('running').render(40)[0]).toContain(ansi.fg('accent', 'running'))
  expect(mk('failed').render(40)[0]).toContain(ansi.fg('danger', 'failed'))
  // A planned row gets typography but no semantic foreground colour; the tool name is never
  // coloured by status.
  const planned = mk('planned').render(40)[0] as string
  for (const tone of ['success', 'warning', 'danger'] as const)
    expect(planned).not.toContain(opener(ansi.fg(tone, '')))
  expect(planned).toContain('\x1b[1mread\x1b[22m')
  expect(done).not.toContain(ansi.fg('success', 'read'))
  // Expanded: no frame, a left rail in the state tone and a quiet closing row; the header names
  // the status even when it is terminal.
  const open = new ToolCard(
    { kind: 'tool', id: 'c', seq: 1, toolUseId: 'c', name: 'read', status: 'completed', summary: 's' },
    { ansi, collapsed: false },
  ).render(40)
  expect(open.join('\n')).not.toContain('╭')
  expect(open[0]).toContain(ansi.fg('success', 'done'))
  expect(open[1]).toContain(`${ansi.fg('success', '│')} s `)
  expect(open.at(-1)).toContain(`${ansi.fg('success', '╰─')} ${ansi.fg('faint', 'ctrl+o')}`)
  expect(open.every((line) => displayWidth(line) === 40)).toBe(true)
  // none tier: zero escapes anywhere.
  const plain = new ToolCard(
    { kind: 'tool', id: 'c', seq: 1, toolUseId: 'c', name: 'read', status: 'completed', summary: 's' },
    { ansi: A },
  )
  expect(plain.render(40).join('\n')).not.toContain('\x1b')
  // Without colour the state glyph alone tells running and failed apart from done.
  const glyphs = (['completed', 'running', 'failed', 'planned'] as const).map(
    (status) =>
      new ToolCard(
        { kind: 'tool', id: 'c', seq: 1, toolUseId: 'c', name: 'read', status, summary: 's' },
        { ansi: A },
      )
        .render(40)[0]
        ?.trim()[0],
  )
  expect(glyphs).toEqual(['◆', '◈', '✗', '◇'])
})

it('renders a tool.card.inline chart/actions block when the card is expanded', () => {
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

it('renderBarChart against the real slots payload shape', () => {
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

it('shows the fetched record in place of the previews, and keeps them while it loads or when it fails', () => {
  let detail: ToolDetailState | undefined
  let opened = 0
  const card = new ToolCard(node, { detail: () => detail, onExpand: () => opened++ })
  card.toggle()
  expect(opened).toBe(1)
  detail = { state: 'loading' }
  let rows = card.render(60).join('\n')
  expect(rows).toContain('Loading the full record…')
  expect(rows).toContain('Result: contents')
  detail = { state: 'failed', reason: 'Request failed (X)' }
  rows = card.render(90).join('\n')
  expect(rows).toContain('Full record unavailable (Request failed (X)); showing the preview.')
  expect(rows).toContain('Result: contents')
  // Pretty-printed arguments keep their indentation under the label.
  detail = { state: 'ready', args: '{\n  "path": "x"\n}' }
  expect(card.render(50).join('\n')).toContain(`│ ${' '.repeat(13)}  "path": "x"`)
  // The record is external text: controls are dropped and every row keeps to the width.
  detail = { state: 'ready', args: '{\n  "path": "中.txt"\n}', result: `full\x1b[2J${'x'.repeat(100)}` }
  const lines = card.render(30)
  rows = lines.join('\n')
  expect(rows).toContain('"中.txt"')
  expect(rows).not.toContain('contents')
  expect(rows).not.toContain('\x1b')
  expect(lines.every((line) => displayWidth(line) === 30)).toBe(true)
  card.toggle()
  expect(opened).toBe(1)
})

const tool = (over: Partial<Extract<UINode, { kind: 'tool' }>>): Extract<UINode, { kind: 'tool' }> => ({
  kind: 'tool',
  id: 'c',
  seq: 1,
  toolUseId: 'u',
  status: 'completed',
  summary: '',
  name: 'x',
  ...over,
})

it('draws a plan as one row per step with its state, and shows only the first rows until opened', () => {
  const plan = (steps: unknown) => tool({ name: 'update_plan', argsPreview: JSON.stringify(steps) })
  const card = new ToolCard(
    plan({
      plan: [
        { step: 'read the spec', status: 'completed' },
        { step: 'write\nthe\x1b[2J parser', status: 'in_progress' },
        { step: 'ship it', status: 'pending' },
        { step: 'nope', status: 'constructor' },
        { text: 'wait on review', status: 'blocked' },
      ],
    }),
  )
  expect(card.render(50)).toEqual([
    ' ◆ Plan  1/5 done'.padEnd(50),
    '    [x] read the spec'.padEnd(50),
    '    [>] write the[2J parser'.padEnd(50),
    '    [ ] ship it'.padEnd(50),
    '    [ ] nope'.padEnd(50),
    '    [!] wait on review'.padEnd(50),
  ])
  // The plan tool this repository ships names its steps `content` under `items`.
  const todo = tool({
    name: 'todo',
    argsPreview: JSON.stringify({ items: [{ content: 'a', status: 'completed' }] }),
  })
  expect(new ToolCard(todo).render(30)[1]).toBe('    [x] a'.padEnd(30))
  // A long plan shows the first rows and says how many more; opening shows every step.
  const long = plan({
    items: Array.from({ length: 13 }, (_, i) => ({ content: `s${i}`, status: 'pending' })),
  })
  const collapsed = new ToolCard(long).render(40)
  expect(collapsed).toHaveLength(12)
  expect(collapsed.at(-1)).toBe('    … 3 more'.padEnd(40))
  const open = new ToolCard(long, { collapsed: false }).render(40).join('\n')
  expect(open).toContain('[ ] s12')
  // Cut-off or foreign arguments leave the plain card.
  for (const argsPreview of ['{"plan":[{"step":"a","sta…', '{"plan":"nope"}', '{"plan":[]}'])
    expect(
      new ToolCard(tool({ name: 'update_plan', argsPreview, summary: 'plan updated' })).render(40),
    ).toEqual([' ◆ Plan  plan updated'.padEnd(40)])
  const coloured = new ToolCard(plan({ plan: [{ step: 's', status: 'in_progress' }] }), {
    ansi: new TuiTheme('dark').ansi(createAnsi('256')),
  })
  expect(coloured.render(30)[1]).toContain(new TuiTheme('dark').ansi(createAnsi('256')).fg('accent', '[>]'))
})

it('draws subagent, job and workflow cards with their name, state, run time and a one-line summary', () => {
  // The headline with its state right-aligned, as the card lays it out.
  const row = (left: string, right: string, width: number) =>
    `${left.padEnd(width - right.length - 2)}  ${right}`
  let facts: { status?: string; durationMs?: number } | undefined
  const spawn = tool({
    name: 'subagent_spawn',
    summary: 'spawned',
    delegatedRole: { ref: 'reviewer', title: { en: 'Reviewer', 'zh-CN': '审阅者' } },
    delegatedTask: { childKey: 'child-1', task: 'review the\ndiff\x1b[2J carefully', status: 'running' },
  })
  const agent = new ToolCard(spawn, { facts: () => facts })
  expect(agent.render(60)).toEqual([row(' ◈ Subagent Reviewer  review the diff[2J carefully', 'running', 60)])
  // The child's state and time arrive without the spawning node changing, and the same card shows them.
  facts = { status: 'completed', durationMs: 12_345 }
  expect(agent.render(70)).toEqual([
    row(' ◆ Subagent Reviewer  review the diff[2J carefully', 'done · 12.3s', 70),
  ])
  expect(new ToolCard(spawn, { locale: 'zh-CN' }).render(60)[0]).toContain('子智能体 审阅者')
  agent.toggle()
  const open = agent.render(70).join('\n')
  expect(open).toContain('Task: review the')
  expect(open).toContain('diff[2J carefully')
  expect(open).toContain('Child: child-1')
  expect(open).not.toContain('\x1b')

  const job = tool({ name: 'job_kill', status: 'running', summary: 'killing dev' })
  expect(new ToolCard(job).render(50)).toEqual([row(' ◈ Job job_kill  killing dev', 'running', 50)])
  const background = tool({ name: 'shell', resultPreview: 'background job j1 started; use job_output' })
  expect(new ToolCard(background).render(60)[0]).toContain('Job shell')
  expect(new ToolCard(tool({ name: 'shell', resultPreview: 'ok' })).render(60)[0]).not.toContain('Job')
  const workflow = tool({ name: 'workflow_status', summary: '2 of 3 steps' })
  expect(new ToolCard(workflow).render(50)).toEqual([
    row(' ◆ Workflow workflow_status  2 of 3 steps', 'done', 50),
  ])
})

it('reads a subagent state and run time from the trace spans of the projected turns', () => {
  const span = (over: Record<string, unknown>) => ({
    id: 's',
    kind: 'other',
    name: 'n',
    status: 'completed',
    children: [],
    ...over,
  })
  const turn = (trace: unknown) => ({ turns: [{ trace }] }) as unknown as UITimeline
  const facts = childFacts(
    turn(
      span({
        kind: 'turn',
        children: [
          span({ kind: 'subagent', status: 'running', childSessionKey: 'a', children: [] }),
          span({
            kind: 'step',
            children: [
              span({
                kind: 'subagent',
                status: 'completed',
                durationMs: 900,
                childSessionKey: 'b',
                children: [span({ kind: 'turn', status: 'failed', durationMs: 5 })],
              }),
            ],
          }),
        ],
      }),
    ),
  )
  expect(facts.get('a')).toEqual({ status: 'running' })
  expect(facts.get('b')).toEqual({ status: 'failed', durationMs: 900 })
  expect(facts.size).toBe(2)
  expect(childFacts(turn(undefined)).size).toBe(0)
})

const editNode = (args: unknown, over: Partial<typeof node> = {}): typeof node => ({
  ...node,
  name: 'edit',
  summary: 'edit a.ts',
  argsPreview: JSON.stringify(args),
  resultPreview: '{"path":"a.ts","bytes":3}',
  ...over,
})
const editArgs = { path: 'a.ts', edits: [{ oldText: 'one\ntwo', newText: 'one\n2\nthree' }] }

it('previews a result by screen rows: wide characters wrap first, then three rows and a remainder', () => {
  const wide = '中'.repeat(30) // 60 columns: three rows at width 24 (inner 20)
  const rows = new ToolCard(
    { ...node, resultPreview: `${wide}\nsecond\n\nthird\nfourth` },
    { locale: 'zh-CN' },
  ).render(24)
  expect(rows).toHaveLength(5)
  expect(rows.slice(1, 4).map((r) => r.trimEnd())).toEqual([
    `    ${'中'.repeat(10)}`,
    `    ${'中'.repeat(10)}`,
    `    ${'中'.repeat(10)}`,
  ])
  expect(rows[4]?.trim()).toBe('… 还有 3 行')
  expect(rows.every((r) => displayWidth(r) === 24)).toBe(true)
  expect(new ToolCard({ ...node, resultPreview: 'a\nb\nc' }).render(40)).toHaveLength(4) // exactly three: no remainder row
  expect(new ToolCard({ ...node, resultPreview: 'x\x1b[2Jy' }).render(40).join('')).not.toContain('\x1b')
})

it('shows +a -b after an edit title and no preview, then the diff when expanded', () => {
  const card = new ToolCard(editNode(editArgs))
  const collapsed = card.render(60)
  expect(collapsed).toHaveLength(1)
  expect(collapsed[0]).toContain('◆ edit +2 -1  edit a.ts')
  card.toggle()
  const expanded = card.render(60).join('\n')
  expect(expanded).toContain('a.ts +2 -1')
  expect(expanded).toContain('2 - two')
  expect(expanded).toContain('3 + three')
  expect(expanded).not.toContain('Arguments:')
  expect(expanded).toContain('Result:')
  // The fetched record replaces a preview that was cut off.
  const cut = editNode(editArgs, { argsPreview: '{"path":"a.ts","edits":[{"oldT' })
  expect(new ToolCard(cut, { collapsed: false }).render(60).join('\n')).toContain('Arguments:')
  const fetched: ToolDetailState = { state: 'ready', args: JSON.stringify(editArgs) }
  expect(new ToolCard(cut, { collapsed: false, detail: () => fetched }).render(60).join('\n')).toContain(
    '3 + three',
  )
})
