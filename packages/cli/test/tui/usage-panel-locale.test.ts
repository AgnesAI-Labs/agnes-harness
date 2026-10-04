import { createAnsi, UsagePanel } from '@agnes/cli-tui'
import { expect, it, vi } from 'vitest'

it('keeps the translated default title when no custom report title is supplied', () => {
  const panel = new UsagePanel({
    ansi: createAnsi('none'),
    locale: 'zh-CN',
    maxRows: () => 8,
    changed: vi.fn(),
  })
  panel.show('用量内容')

  expect(panel.render(80).join('\n')).toContain('会话用量')
})
