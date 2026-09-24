import { expect, it } from 'vitest'
import { createAnsi } from '../src/tui/ansi.js'
import { displayWidth } from '../src/tui/terminal.js'
import { UsagePanel } from '../src/tui/views/usage-panel.js'

it('shows long reports within terminal bounds, scrolls, and restores editor input after Escape', () => {
  const panel = new UsagePanel({ ansi: createAnsi('none'), maxRows: () => 8, changed() {} })
  panel.show(Array.from({ length: 20 }, (_, i) => `row ${i} 模型用量`).join('\n'))
  for (const width of [20, 40, 80]) {
    const lines = panel.render(width)
    expect(lines.length).toBeLessThanOrEqual(8)
    expect(lines.every((line) => displayWidth(line) <= width)).toBe(true)
  }
  expect(panel.handleInput('do not send')).toBe(true)
  panel.handleInput('\x1b[B')
  expect(panel.render(40).join('\n')).toContain('row 5')
  panel.handleInput('\x1b')
  expect(panel.render(40)).toEqual([])
  expect(panel.handleInput('typing')).toBe(false)
})
