// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createSelectPicker, type SelectPicker } from '../src/select-picker.js'

let picker: SelectPicker
afterEach(() => {
  picker?.destroy()
  vi.restoreAllMocks()
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
  let top = 300
  vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => new DOMRect(200, top, 200, 44))
  vi.spyOn(window.performance, 'now').mockReturnValue(1000)
  const scrollAt = (timeStamp: number) => {
    const event = new Event('scroll')
    Object.defineProperties(event, { timeStamp: { value: timeStamp }, isTrusted: { value: true } })
    document.dispatchEvent(event)
  }
  const changed = vi.fn()
  select.addEventListener('change', changed)
  trigger.click()
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(2)
  picker.sync()
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  const panel = document.getElementById('choice-listbox') as HTMLElement
  expect(panel.closest('dialog[open]')).not.toBeNull()
  const row = document.getElementById('choice-listbox-1') as HTMLElement
  Object.defineProperty(panel, 'clientHeight', { value: 50 })
  Object.defineProperty(row, 'offsetTop', { value: 60 })
  Object.defineProperty(row, 'offsetHeight', { value: 20 })
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
  expect(panel.scrollTop).toBe(30)
  document.dispatchEvent(new Event('scroll'))
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  // Focus can queue a scroll before opening, then deliver it after the anchor moved.
  top -= 20
  scrollAt(999)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  // A later form scroll can settle the anchor by a fractional CSS pixel.
  top += 0.390625
  scrollAt(1001)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  top += 0.390625
  scrollAt(1002)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  top += 0.390625
  scrollAt(1003)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  trigger.click()
  document.getElementById('choice-listbox-1')?.click()
  expect(select.value).toBe('a')
  trigger.click()
  document.getElementById('choice-listbox-1')?.click()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  trigger.click()
  top -= 20
  scrollAt(1001)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
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
  trigger.click()
  picker.sync()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
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

it('keeps an open menu open and current when its options load while the value stays', () => {
  const { select, trigger } = setup()
  trigger.click()
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(2)
  // A late read adds a choice; the person's open menu shows it instead of closing under them.
  const option = document.createElement('option')
  option.value = 'b'
  option.textContent = 'Model B'
  select.append(option)
  picker.sync()
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect([...document.querySelectorAll('[role="option"]')].map((row) => row.textContent)).toEqual([
    '选择模型✓',
    'Model A',
    'Model B',
  ])
  ;(document.getElementById('choice-listbox-2') as HTMLElement).click()
  expect(select.value).toBe('b')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
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

it('mounts a standalone picker in the shared overlay outlet', () => {
  document.body.innerHTML =
    '<div id="agnes-overlay-container"></div><select id="choice"><option value="a">Model A</option></select>'
  const select = document.getElementById('choice') as HTMLSelectElement
  picker = createSelectPicker(select, { label: 'Model' })
  document.getElementById('choice-trigger')?.click()
  expect(document.getElementById('choice-listbox')?.parentElement?.id).toBe('agnes-overlay-container')
})
