/** @vitest-environment happy-dom */

import { expect, it, vi } from 'vitest'
import { createPermissionPicker, permissionLabel, yoloEnabled } from '../src/permission-picker.js'

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
