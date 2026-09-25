/** @vitest-environment happy-dom */

import { afterEach, expect, it, vi } from 'vitest'
import { createPermissionPicker, permissionLabel, yoloEnabled } from '../src/permission-picker.js'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it('labels the three session permission modes', () => {
  expect(permissionLabel('view')).toBe('仅可查看')
  expect(permissionLabel('workspace')).toBe('工作区内修改')
  expect(permissionLabel('full')).toBe('完全权限')
  expect(yoloEnabled('full')).toBe(true)
  expect(yoloEnabled('workspace')).toBe(false)
})

it('opens the list and reports the chosen mode', async () => {
  const trigger = document.createElement('button')
  const label = document.createElement('span')
  label.dataset.permissionLabel = ''
  trigger.append(label)
  document.body.append(trigger)
  const onSelect = vi.fn(async () => true)
  const picker = createPermissionPicker({ trigger, onSelect, onError: () => undefined })
  picker.render({ disabled: false, pending: false, selected: 'workspace' })
  expect(label.textContent).toBe('工作区内修改')
  trigger.click()
  const listbox = document.querySelector('[role="listbox"]')
  if (!listbox) throw new Error('permission listbox did not open')
  expect([...listbox.children].map((child) => child.getAttribute('role'))).toEqual([
    'option',
    'option',
    'option',
  ])
  const full = [...document.querySelectorAll('[role="option"]')].find((row) =>
    row.textContent?.includes('完全权限'),
  )
  expect(full).toBeDefined()
  full?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith('full'))
  picker.destroy()
})

it('moves the active permission with keys and returns focus on Escape', () => {
  vi.stubGlobal('requestAnimationFrame', () => 1)
  const trigger = document.createElement('button')
  document.body.append(trigger)
  const onSelect = vi.fn(async () => true)
  const picker = createPermissionPicker({ trigger, onSelect, onError: vi.fn() })
  picker.render({ disabled: false, pending: false, selected: 'workspace' })

  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  const listbox = document.querySelector<HTMLElement>('[role="listbox"]')
  if (!listbox) throw new Error('permission listbox did not open')
  expect(document.activeElement).toBe(listbox)
  expect(trigger.getAttribute('aria-controls')).toBe(listbox.id)
  expect(listbox.getAttribute('aria-activedescendant')).toBe('permission-picker-option-1')

  listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(listbox.getAttribute('aria-activedescendant')).toBe('permission-picker-option-2')
  listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  expect(listbox.getAttribute('aria-activedescendant')).toBe('permission-picker-option-0')
  listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  expect(listbox.getAttribute('aria-activedescendant')).toBe('permission-picker-option-2')
  listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

  expect(document.querySelector('[role="listbox"]')).toBeNull()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(trigger.hasAttribute('aria-controls')).toBe(false)
  expect(document.activeElement).toBe(trigger)
  expect(onSelect).not.toHaveBeenCalled()
  picker.destroy()
})
