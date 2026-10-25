import { diffWork } from '@agnes/cli-tui'
import type { PermissionRequest } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { createAnsi } from '../../src/tui/ansi.js'
import { PermissionModal } from '../../src/tui/permission-modal.js'
import { displayWidth } from '../../src/tui/terminal.js'
import { TuiTheme } from '../../src/tui/theme.js'
import { ApprovalCard } from '../../src/tui/views/approval-card.js'

const request: PermissionRequest = {
  sessionId: 's',
  toolCall: { title: 'write' },
  options: [
    { optionId: 'a', name: 'Allow', kind: 'allow_once' },
    { optionId: 'r', name: 'Reject', kind: 'reject_once' },
  ],
}
it('keeps the details pager in a narrow bottom border and names every option kind it knows', () => {
  const modal = new PermissionModal(vi.fn(), { maxRows: () => 8 })
  void modal.ask(
    {
      ...request,
      toolCall: { title: 'write', rawInput: { path: 'a.txt', b: 1, c: 2, d: 3, e: 4, f: 5 } },
      options: [...request.options, { optionId: 'x', name: 'raw-name', kind: 'reject_always' }],
    },
    { signal: new AbortController().signal },
  )
  const lines = modal.render(44)
  expect(lines.at(-1)).toContain('pgup/pgdn details')
  expect(lines.at(-1)).toContain('esc close')
  expect(lines.join('\n')).toContain('Always reject')
  expect(lines.join('\n')).not.toContain('raw-name')
})

it('defaults Enter to rejection and only explicit option selection permits approval', async () => {
  const modal = new PermissionModal(vi.fn())
  const first = modal.ask(request, { signal: new AbortController().signal })
  expect(modal.render(80).join('\n')).toContain('❯ [2] Reject')
  // Title and footer sit in the frame's borders, so the frame adds no rows.
  const framed = modal.render(80)
  expect(framed).toHaveLength(5)
  expect(framed[0]).toMatch(/^╭ ▲ Needs approval · write ─+╮$/)
  // Everything fits, so there is nothing to page.
  expect(framed.at(-1)).toMatch(/^╰ ↑↓ select {2}⏎ confirm {2}esc close ─+╯$/)
  expect(framed.every((line) => displayWidth(line) === 80 && /^[╭│╰].*[╮│╯]$/.test(line))).toBe(true)
  modal.handleInput('\r')
  expect(await first).toEqual({ optionId: 'r' })
  const second = modal.ask(request, { signal: new AbortController().signal })
  modal.render(80)
  modal.handleInput('1')
  expect(await second).toEqual({ optionId: 'a' })
  expect(modal.handleInput('1')).toBe(false)
  // With input to show, a heading that fits the top border is not repeated as a detail row.
  const third = modal.ask(
    { ...request, toolCall: { title: 'write', rawInput: { path: 'a.txt' } } },
    { signal: new AbortController().signal },
  )
  const withInput = modal.render(80)
  expect(withInput.join('\n').split('Needs approval · write')).toHaveLength(2)
  expect(withInput[1]).toContain('{')
  expect(withInput.at(-1)).not.toContain('pgup')
  modal.handleInput('\r')
  expect(await third).toEqual({ optionId: 'r' })
})
it('cancels a queued question without dismissing the active question, and rejects after close', async () => {
  const modal = new PermissionModal(vi.fn())
  const first = modal.ask(request, { signal: new AbortController().signal })
  const ac = new AbortController()
  const second = modal.ask({ ...request, toolCall: { title: 'other' } }, { signal: ac.signal })
  ac.abort()
  expect(await second).toEqual({ unanswered: 'detached' })
  expect(modal.render(80).join('\n')).toContain('Needs approval · write')
  modal.close()
  expect(await first).toEqual({ unanswered: 'detached' })
  expect(await modal.ask(request, { signal: new AbortController().signal })).toEqual({
    unanswered: 'detached',
  })
  expect(modal.render(80)).toEqual([])
})
it('closes the active question on cancellation and consumes unrelated input', async () => {
  const modal = new PermissionModal(vi.fn())
  const ac = new AbortController()
  const pending = modal.ask(request, { signal: ac.signal })
  expect(modal.handleInput('unrelated draft text')).toBe(true)
  ac.abort()
  expect(await pending).toEqual({ unanswered: 'detached' })
  expect(modal.render(80)).toEqual([])
  expect(modal.handleInput('1')).toBe(false)
})

it('paginates full input while keeping controls visible and blocks unseen positive choices', async () => {
  const modal = new PermissionModal(vi.fn(), { maxRows: () => 6 })
  const pending = modal.ask(
    { ...request, toolCall: { title: 'write', rawInput: { content: 'x'.repeat(300), path: 'target.txt' } } },
    { signal: new AbortController().signal },
  )
  expect(modal.handleInput('1')).toBe(true) // Before the first paint no positive action is exposed.
  let lines = modal.render(30)
  expect(lines.length).toBeLessThanOrEqual(6)
  expect(lines.join('\n')).toContain('Reject')
  expect(lines.join('\n')).not.toContain('target.txt')
  for (let i = 0; i < 20 && !lines.join('\n').includes('target.txt'); i++) {
    modal.handleInput('\x1b[6~')
    lines = modal.render(30)
  }
  expect(lines.join('\n')).toContain('target.txt')
  modal.handleInput('\x1b[5~')
  expect(modal.render(30)).not.toEqual(lines)
  modal.handleInput('1')
  expect(await pending).toEqual({ optionId: 'a' })
})
it('reveals offscreen options through navigation and keeps an undersized modal rejection-only', async () => {
  let rows = 3
  const modal = new PermissionModal(vi.fn(), { maxRows: () => rows })
  const pending = modal.ask(request, { signal: new AbortController().signal })
  expect(modal.render(30)).toHaveLength(1)
  modal.handleInput('1')
  rows = 4
  expect(modal.render(30).join('\n')).toContain('Reject')
  modal.handleInput('1') // Only the rejecting option is visible in this layout.
  modal.handleInput('\x1b[A')
  expect(modal.render(30).join('\n')).toContain('Allow')
  modal.handleInput('\r')
  expect(await pending).toEqual({ optionId: 'a' })
})

it('localizes Chinese approval chrome and bounds the rejection-only row at extreme widths', async () => {
  let rows = 6
  const modal = new PermissionModal(vi.fn(), { locale: 'zh-CN', maxRows: () => rows })
  const pending = modal.ask(
    { ...request, toolCall: { title: undefined } },
    { signal: new AbortController().signal },
  )

  const normal = modal.render(40).join('\n')
  expect(normal).toContain('需要审批 · 工具请求')
  expect(normal).toContain('esc 关闭')

  rows = 3
  for (const width of [1, 2, 10, 20, 40]) {
    const lines = modal.render(width)
    expect(lines).toHaveLength(1)
    expect(lines.every((line) => displayWidth(line) <= width)).toBe(true)
  }
  expect(modal.render(40).join('\n')).toContain('审批：请调整窗口大小')

  modal.handleInput('\x1b')
  expect(await pending).toEqual({ unanswered: 'detached' })
})

it.each([
  ['zh-CN', '在本机运行候选的 Node 作者测试', '不会发布、信任或启用', '设置 → 插件 → 候选'],
  [
    'en',
    'Node author tests on this machine',
    'does not publish, trust or enable',
    'Settings → Plugins → Candidates',
  ],
] as const)('renders candidate test approval in %s', async (locale, execution, boundary, review) => {
  const modal = new PermissionModal(vi.fn(), { locale })
  const pending = modal.ask(
    {
      ...request,
      toolCall: {
        title: 'synthetic fallback',
        rawInput: { packageId: 'agh-skill-math-teacher', candidateHash: `sha256-${'b'.repeat(64)}` },
        _meta: { 'ai.agnes.harness': { tool: 'plugin_candidate_test' } },
      },
    },
    { signal: new AbortController().signal },
  )
  const text = modal.render(240).join('\n')
  for (const phrase of [execution, boundary, review, 'agh-skill-math-teacher', 'bbbbbbbbbbbb'])
    expect(text).toContain(phrase)
  expect(text).not.toContain('synthetic fallback')
  modal.close()
  expect(await pending).toEqual({ unanswered: 'detached' })
})

const editInput = {
  path: 'a.ts',
  edits: [{ oldText: 'one\ntwo', newText: 'one\n2' }],
}
const editRequest: PermissionRequest = {
  sessionId: 's',
  toolCall: {
    title: 'Edit a.ts',
    rawInput: editInput,
    _meta: { 'ai.agnes.harness': { tool: 'edit' } },
  },
  options: [
    { optionId: 'o', name: 'allow_once', kind: 'allow_once' },
    { optionId: 'a', name: 'allow_always', kind: 'allow_always' },
    { optionId: 'r', name: 'reject_once', kind: 'reject_once' },
  ],
}

it('shows the change of an edit first, the raw input after it, and scope-stating option labels', async () => {
  const modal = new PermissionModal(vi.fn(), { locale: 'zh-CN' })
  const pending = modal.ask(editRequest, { signal: new AbortController().signal })
  const text = modal.render(80).join('\n')
  const work = diffWork.hunks
  modal.render(60)
  expect(diffWork.hunks).toBe(work) // drawing again does not diff again
  expect(text).toContain('edit')
  expect(text).toContain('a.ts +1 -1')
  expect(text).toContain('2 - two')
  expect(text.indexOf('2 - two')).toBeLessThan(text.indexOf('"oldText"'))
  expect(text).toContain('原始输入')
  expect(text).toContain('[2] 本会话允许')
  expect(text).toContain('❯ [3] 拒绝') // the default is still the rejection
  modal.handleInput('\r')
  expect(await pending).toEqual({ optionId: 'r' })
})

it('lets scrolling reach every option when they do not all fit, even before the next paint', async () => {
  const modal = new PermissionModal(vi.fn(), { maxRows: () => 5 })
  const pending = modal.ask(editRequest, { signal: new AbortController().signal })
  modal.render(60)
  modal.handleInput('1') // option 1 is off screen: only the rejection can be hit by number
  modal.handleInput('\x1b[A')
  modal.handleInput('\x1b[A') // the keys land before any repaint
  modal.handleInput('\r')
  expect(await pending).toEqual({ optionId: 'o' })
})

it('gives the modal and the parked card the same body for the same request', () => {
  const ansi = new TuiTheme('mono').ansi(createAnsi('none'))
  const card = new ApprovalCard(
    {
      kind: 'approval',
      id: 'a',
      seq: 1,
      state: 'pending',
      summary: 'Edit a.ts',
      risk: 'always',
      toolName: 'edit',
      options: ['allow_once', 'reject_once'],
      decisionRef: { sessionId: 's', id: 'tk', revision: 1 },
      subjectText: JSON.stringify({ call: { name: 'edit', args: editInput } }),
    },
    { ansi, onDecide: async () => {} },
  )
  const body = (rows: string[]) =>
    rows.map((r) => r.replace(/^[ │]+/, '').replace(/[ │]+$/, '')).filter(Boolean)
  const cardRows = body(card.render(80))
  const modal = new PermissionModal(vi.fn())
  void modal.ask(editRequest, { signal: new AbortController().signal })
  const modalRows = body(modal.render(80))
  for (const row of ['a.ts +1 -1', '1   one', '2 - two', '2 + 2']) expect(cardRows).toContain(row)
  for (const row of ['a.ts +1 -1', '1   one', '2 - two', '2 + 2']) expect(modalRows).toContain(row)
  const card80 = cardRows.join('\n') // the raw subject stays, below the diff, under its own heading
  expect(card80.indexOf('oldText')).toBeGreaterThan(card80.indexOf('── Raw input ──'))
  expect(card80.indexOf('── Raw input ──')).toBeGreaterThan(card80.indexOf('2 + 2'))
  modal.close()
})

it('names a request without a title by its plain arguments', () => {
  const modal = new PermissionModal(vi.fn())
  void modal.ask(
    { ...request, toolCall: { rawInput: { path: 'a b.txt', content: { nested: true }, n: 3 } } },
    { signal: new AbortController().signal },
  )
  expect(modal.render(80)[0]).toContain('Needs approval · path=a b.txt, n=3')
  modal.close()
})
