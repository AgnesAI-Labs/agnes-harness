import { createAnsi, ModelPicker, SessionPicker } from '@agnes/cli-tui'
import { afterEach, expect, it, vi } from 'vitest'

const opened: Array<{ close(): void }> = []

afterEach(() => {
  for (const picker of opened.splice(0)) picker.close()
})

it('renders the session picker in the selected locale', () => {
  const picker = new SessionPicker({
    ansi: createAnsi('none'),
    locale: 'zh-CN',
    maxRows: () => 12,
    onChoose: vi.fn(),
    changed: vi.fn(),
  })
  opened.push(picker)
  picker.show([{ sessionId: 's1', createdAt: 'invalid', lastSeq: 2, preset: 'default' }])

  const output = picker.render(80).join('\n')
  expect(output).toContain('选择会话')
  expect(output).toContain('时间未知')
})

it('renders the model picker in the selected locale', () => {
  const picker = new ModelPicker({
    ansi: createAnsi('none'),
    locale: 'zh-CN',
    maxRows: () => 12,
    onChoose: vi.fn(),
    changed: vi.fn(),
  })
  opened.push(picker)
  picker.show([{ route: 'openai', model: 'gpt', reasoning: false }])

  expect(picker.render(80).join('\n')).toContain('选择模型')
})
