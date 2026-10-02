/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ModelSettingsDialog } from '../src/model-settings-dialog.js'

let root: Root
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  const host = document.createElement('section')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.replaceChildren()
})
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.replace(/\s/g, '') === label,
  )
  if (!button) throw new Error(`missing button: ${label}`)
  await act(async () => button.click())
}
async function input(id: string, value: string) {
  const field = document.getElementById(id) as HTMLInputElement | HTMLSelectElement
  const prototype = field.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value)
  await act(async () =>
    field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })),
  )
}
const props = {
  disabled: false,
  contextWindow: 128000,
  thinkingLevelMap: { low: 'low', high: 'high' },
  settings: { thinking: 'low' as const, contextWindow: 64000 },
}

it('shows supported thinking levels, validates the window and keeps failed changes reviewable', async () => {
  const onApply = vi.fn(async () => false)
  await act(async () => root.render(createElement(ModelSettingsDialog, { ...props, onApply })))
  await click('思考·上下文')
  expect(
    [...document.querySelectorAll('#session-model-thinking option')].map((o) => o.getAttribute('value')),
  ).toEqual(['', 'low', 'high'])
  expect((document.getElementById('session-model-window') as HTMLInputElement).value).toBe('64000')
  await input('session-model-window', '100')
  await click('应用到本会话')
  expect(onApply).not.toHaveBeenCalled()
  await input('session-model-window', '128001')
  await click('应用到本会话')
  expect(onApply).not.toHaveBeenCalled()
  expect(document.getElementById('session-model-window')?.getAttribute('aria-invalid')).toBe('true')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('正整数')
  await input('session-model-thinking', 'high')
  for (const [value, contextWindow] of [
    ['32K', 32000],
    ['0.032M', 32000],
    ['100K', 100000],
  ] as const) {
    await input('session-model-window', value)
    await click('应用到本会话')
    expect(onApply).toHaveBeenLastCalledWith({ thinking: 'high', contextWindow })
  }
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('配置未保存')
  expect(document.getElementById('session-model-thinking')).not.toBeNull()
  onApply.mockResolvedValue(true)
  await input('session-model-window', '')
  await input('session-model-thinking', '')
  await click('应用到本会话')
  expect(onApply).toHaveBeenLastCalledWith({})
  await click('思考·上下文')
  expect((document.getElementById('session-model-thinking') as HTMLSelectElement).value).toBe('low')
})

it('preserves unavailable saved thinking until the user chooses a supported value', async () => {
  const onApply = vi.fn(async () => true)
  await act(async () =>
    root.render(
      createElement(ModelSettingsDialog, { ...props, thinkingLevelMap: { high: 'high' }, onApply }),
    ),
  )
  await click('思考·上下文')
  expect((document.getElementById('session-model-thinking') as HTMLSelectElement).value).toBe('low')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('不支持')
  await click('应用到本会话')
  expect(onApply).not.toHaveBeenCalled()
  await input('session-model-thinking', '')
  await click('应用到本会话')
  expect(onApply).toHaveBeenCalledWith({ contextWindow: 64000 })
})
