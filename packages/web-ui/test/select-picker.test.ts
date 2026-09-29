// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createSelectPicker, type SelectPicker } from '../src/select-picker.js'

let picker: SelectPicker
afterEach(() => {
  picker?.destroy()
  document.body.replaceChildren()
})

function setup() {
  document.body.innerHTML = `<dialog open><form><label for="choice">默认模型<select id="choice">
    <option value="">选择模型</option><option value="a">Model A</option>
    <option value="hidden" hidden>Hidden</option><option value="locked" disabled>Locked</option>
    </select></label></form></dialog>`
  const select = document.querySelector('select') as HTMLSelectElement
  picker = createSelectPicker(select, { label: '默认模型' })
  const trigger = document.getElementById('choice-trigger') as HTMLButtonElement
  return { select, trigger }
}

it('preserves empty-value choices and ignores hidden/disabled items', () => {
  const { select, trigger } = setup()
  const changed = vi.fn()
  select.addEventListener('change', changed)
  trigger.click()
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(2)
  document.getElementById('choice-listbox-1')?.click()
  expect(select.value).toBe('a')
  trigger.click()
  document.getElementById('choice-listbox-0')?.click()
  expect(select.value).toBe('')
  expect(changed).toHaveBeenCalledTimes(2)
})

it('syncs programmatic values, disabled state and form reset without firing change', async () => {
  const { select, trigger } = setup()
  const changed = vi.fn()
  select.addEventListener('change', changed)
  select.value = 'a'
  picker.sync()
  expect(trigger.textContent).toBe('Model A')
  select.disabled = true
  picker.sync()
  expect(trigger.disabled).toBe(true)
  select.disabled = false
  select.form?.reset()
  await Promise.resolve()
  expect(trigger.textContent).toBe('选择模型')
  expect(changed).not.toHaveBeenCalled()
})

it('restores the native control and label on destroy, with no duplicate trigger on remount', () => {
  const { select, trigger } = setup()
  trigger.click()
  picker.destroy()
  expect(document.querySelector('[role="listbox"]')).toBeNull()
  expect(trigger.isConnected).toBe(false)
  expect(select.hidden).toBe(false)
  expect(document.querySelector('label')?.htmlFor).toBe('choice')
  picker = createSelectPicker(select, { label: '默认模型' })
  expect(document.querySelectorAll('#choice-trigger')).toHaveLength(1)
})
