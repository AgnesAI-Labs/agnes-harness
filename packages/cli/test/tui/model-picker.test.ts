import { expect, it, vi } from 'vitest'
import { createAnsi } from '../../src/tui/ansi.js'
import { TuiTheme } from '../../src/tui/theme.js'
import { ModelPicker } from '../../src/tui/views/model-picker.js'

it('a model without reasoning finishes in one step', () => {
  const chosen = vi.fn()
  const picker = new ModelPicker({
    ansi: new TuiTheme().ansi(createAnsi('none')),
    maxRows: () => 8,
    onChoose: chosen,
    changed: vi.fn(),
  })
  picker.show([{ route: 'deepseek', model: 'deepseek-v4-flash', reasoning: false }])
  picker.handleInput('\r')
  expect(chosen).toHaveBeenCalledWith({ route: 'deepseek', model: 'deepseek-v4-flash' })
  expect(picker.open).toBe(false)
})

it('a model with reasoning forces a second screen listing its declared thinking levels', () => {
  const chosen = vi.fn()
  const picker = new ModelPicker({
    ansi: new TuiTheme().ansi(createAnsi('none')),
    maxRows: () => 8,
    onChoose: chosen,
    changed: vi.fn(),
  })
  picker.show([
    {
      route: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoning: true,
      thinkingLevelMap: { low: 'low', high: 'high' },
    },
  ])
  picker.handleInput('\r')
  expect(chosen).not.toHaveBeenCalled()
  // Box.render truncates its title to fit the given width (53-char padded title needs width >= 55);
  // render wider here so the full per-model title is present to assert on, unlike the terser checks
  // below that fit comfortably within the app's normal 40-column budget.
  expect(picker.render(60).join('\n')).toContain('Select Reasoning Level for deepseek/deepseek-v4-pro')
  expect(picker.render(40).join('\n')).toContain('high')
  picker.handleInput('\x1b[B')
  picker.handleInput('\r')
  expect(chosen).toHaveBeenCalledWith({ route: 'deepseek', model: 'deepseek-v4-pro', thinking: 'high' })
})

it('a reasoning model with no declared thinkingLevelMap falls back to all four levels', () => {
  const chosen = vi.fn()
  const picker = new ModelPicker({
    ansi: new TuiTheme().ansi(createAnsi('none')),
    maxRows: () => 8,
    onChoose: chosen,
    changed: vi.fn(),
  })
  picker.show([{ route: 'deepseek', model: 'deepseek-v4-pro', reasoning: true }])
  picker.handleInput('\r')
  const text = picker.render(40).join('\n')
  for (const level of ['off', 'low', 'medium', 'high']) expect(text).toContain(level)
})

it('a reasoning model with an empty declared thinkingLevelMap falls back to all four levels', () => {
  const chosen = vi.fn()
  const picker = new ModelPicker({
    ansi: new TuiTheme().ansi(createAnsi('none')),
    maxRows: () => 8,
    onChoose: chosen,
    changed: vi.fn(),
  })
  picker.show([{ route: 'deepseek', model: 'deepseek-v4-pro', reasoning: true, thinkingLevelMap: {} }])
  picker.handleInput('\r')
  const text = picker.render(40).join('\n')
  for (const level of ['off', 'low', 'medium', 'high']) expect(text).toContain(level)
})

it('esc on the reasoning screen returns to the model list rather than closing outright', () => {
  const chosen = vi.fn()
  const picker = new ModelPicker({
    ansi: new TuiTheme().ansi(createAnsi('none')),
    maxRows: () => 8,
    onChoose: chosen,
    changed: vi.fn(),
  })
  picker.show([
    { route: 'deepseek', model: 'deepseek-v4-pro', reasoning: true, thinkingLevelMap: { high: 'high' } },
  ])
  picker.handleInput('\r')
  expect(picker.render(40).join('\n')).toContain('Select Reasoning Level')
  picker.handleInput('\x1b')
  expect(picker.open).toBe(true)
  expect(picker.render(40).join('\n')).toContain('Select Model')
  expect(chosen).not.toHaveBeenCalled()
})

it('esc on the model list closes the picker entirely', () => {
  const chosen = vi.fn()
  const changed = vi.fn()
  const picker = new ModelPicker({
    ansi: new TuiTheme().ansi(createAnsi('none')),
    maxRows: () => 8,
    onChoose: chosen,
    changed,
  })
  picker.show([{ route: 'deepseek', model: 'deepseek-v4-flash', reasoning: false }])
  picker.show([
    { route: 'deepseek', model: 'deepseek-v4-flash', reasoning: false },
    { route: 'deepseek', model: 'deepseek-v4-pro', reasoning: true, thinkingLevelMap: { high: 'high' } },
  ])
  picker.handleInput('\x1b')
  expect(picker.open).toBe(false)
  expect(chosen).not.toHaveBeenCalled()
})

it('filters the model list as you type and still picks the original model', () => {
  const chosen = vi.fn()
  const picker = new ModelPicker({
    ansi: new TuiTheme().ansi(createAnsi('none')),
    maxRows: () => 8,
    onChoose: chosen,
    changed: vi.fn(),
  })
  picker.show([
    { route: 'deepseek', model: 'deepseek-v4-flash', reasoning: false },
    { route: 'openai', model: 'GPT-5', reasoning: false },
  ])
  for (const ch of 'gpt') picker.handleInput(ch)
  const text = picker.render(60).join('\n')
  expect(text).toContain('⌕ gpt  1/2')
  expect(text).toContain('openai/GPT-5')
  expect(text).not.toContain('deepseek')
  picker.handleInput('\r')
  expect(chosen).toHaveBeenCalledWith({ route: 'openai', model: 'GPT-5' })
})

it('shows the account label instead of the raw route, filters on it, and still submits the real route', () => {
  const chosen = vi.fn()
  const picker = new ModelPicker({
    ansi: new TuiTheme().ansi(createAnsi('none')),
    maxRows: () => 8,
    onChoose: chosen,
    changed: vi.fn(),
  })
  picker.show([
    { route: 'account-acct-3a4e775a', label: 'DeepSeek', model: 'deepseek-flash', reasoning: false },
    { route: 'legacy', model: 'old', reasoning: false },
  ])
  const text = picker.render(60).join('\n')
  expect(text).toContain('DeepSeek / deepseek-flash')
  expect(text).not.toContain('acct-3a4e775a')
  expect(text).toContain('legacy/old')
  for (const ch of 'deepseek') picker.handleInput(ch)
  expect(picker.render(60).join('\n')).not.toContain('legacy/old')
  picker.handleInput('\r')
  expect(chosen).toHaveBeenCalledWith({ route: 'account-acct-3a4e775a', model: 'deepseek-flash' })
})
