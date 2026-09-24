import type { PermissionRequest } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { PermissionModal } from '../../src/tui/permission-modal.js'
import { displayWidth } from '../../src/tui/terminal.js'

const request: PermissionRequest = {
  sessionId: 's',
  toolCall: { title: 'write' },
  options: [
    { optionId: 'a', name: 'Allow', kind: 'allow_once' },
    { optionId: 'r', name: 'Reject', kind: 'reject_once' },
  ],
}
it('defaults Enter to rejection and only explicit option selection permits approval', async () => {
  const modal = new PermissionModal(vi.fn())
  const first = modal.ask(request, { signal: new AbortController().signal })
  expect(modal.render(80).join('\n')).toContain('> 2. Reject')
  modal.handleInput('\r')
  expect(await first).toEqual({ optionId: 'r' })
  const second = modal.ask(request, { signal: new AbortController().signal })
  modal.render(80)
  modal.handleInput('1')
  expect(await second).toEqual({ optionId: 'a' })
  expect(modal.handleInput('1')).toBe(false)
})
it('cancels a queued question without dismissing the active question, and rejects after close', async () => {
  const modal = new PermissionModal(vi.fn())
  const first = modal.ask(request, { signal: new AbortController().signal })
  const ac = new AbortController()
  const second = modal.ask({ ...request, toolCall: { title: 'other' } }, { signal: ac.signal })
  ac.abort()
  expect(await second).toEqual({ verdict: 'rejected' })
  expect(modal.render(80).join('\n')).toContain('Approval: write')
  modal.close()
  expect(await first).toEqual({ verdict: 'rejected' })
  expect(await modal.ask(request, { signal: new AbortController().signal })).toEqual({ verdict: 'rejected' })
  expect(modal.render(80)).toEqual([])
})
it('closes the active question on cancellation and consumes unrelated input', async () => {
  const modal = new PermissionModal(vi.fn())
  const ac = new AbortController()
  const pending = modal.ask(request, { signal: ac.signal })
  expect(modal.handleInput('unrelated draft text')).toBe(true)
  ac.abort()
  expect(await pending).toEqual({ verdict: 'rejected' })
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
  expect(normal).toContain('审批: 工具请求')
  expect(normal).toContain('Esc：拒绝 · PgUp/PgDn 查看详情')

  rows = 3
  for (const width of [1, 2, 10, 20, 40]) {
    const lines = modal.render(width)
    expect(lines).toHaveLength(1)
    expect(lines.every((line) => displayWidth(line) <= width)).toBe(true)
  }
  expect(modal.render(40).join('\n')).toContain('审批：请调整窗口大小')

  modal.handleInput('\x1b')
  expect(await pending).toEqual({ verdict: 'rejected' })
})
