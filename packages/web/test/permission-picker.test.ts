/** @vitest-environment happy-dom */

import { afterEach, expect, it, vi } from 'vitest'
import { createPermissionPicker, permissionLabel, yoloEnabled } from '../src/permission-picker.js'
import { zhT } from './helpers/locale.js'

/** The option the listbox's aria-activedescendant points at, resolved in its own document. */
const activeOption = (box: HTMLElement) =>
  box.ownerDocument.getElementById(box.getAttribute('aria-activedescendant') ?? '')

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it('labels the three session permission modes', () => {
  expect(permissionLabel('view', zhT)).toBe('仅可查看')
  expect(permissionLabel('workspace', zhT)).toBe('工作区内修改')
  expect(permissionLabel('full', zhT)).toBe('完全权限')
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
  const picker = createPermissionPicker({ trigger, onSelect, onError: () => undefined, t: zhT })
  picker.render({ disabled: false, pending: false, selected: null })
  expect(label.textContent).toBe('请选择权限')
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
  const full = [...document.querySelectorAll('[role="option"]')].find(
    (row) => row.querySelector('.permission-picker-label')?.textContent === '完全权限',
  )
  expect(full).toBeDefined()
  expect(full?.textContent).toContain('工作区内外文件读写')
  expect(full?.textContent).toContain('保留安全禁令和系统权限')
  const workspace = [...document.querySelectorAll('[role="option"]')].find(
    (row) => row.querySelector('.permission-picker-label')?.textContent === '工作区内修改',
  )
  expect(workspace?.textContent).toContain('越界需切换完全权限或选择目录')
  full?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith('full'))
  picker.destroy()
})

it('moves the active permission with keys and returns focus on Escape', () => {
  vi.stubGlobal('requestAnimationFrame', () => 1)
  const trigger = document.createElement('button')
  document.body.append(trigger)
  const onSelect = vi.fn(async () => true)
  const picker = createPermissionPicker({ trigger, onSelect, onError: vi.fn(), t: zhT })
  picker.render({ disabled: false, pending: false, selected: 'workspace' })

  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  const listbox = document.querySelector<HTMLElement>('[role="listbox"]')
  if (!listbox) throw new Error('permission listbox did not open')
  expect(document.activeElement).toBe(listbox)
  expect(trigger.getAttribute('aria-controls')).toBe(listbox.id)
  expect(activeOption(listbox)).toBe(listbox.querySelectorAll('[role="option"]')[1])

  listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(activeOption(listbox)).toBe(listbox.querySelectorAll('[role="option"]')[2])
  listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  expect(activeOption(listbox)).toBe(listbox.querySelectorAll('[role="option"]')[0])
  listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  expect(activeOption(listbox)).toBe(listbox.querySelectorAll('[role="option"]')[2])
  listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

  expect(document.querySelector('[role="listbox"]')).toBeNull()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(trigger.hasAttribute('aria-controls')).toBe(false)
  expect(document.activeElement).toBe(trigger)
  expect(onSelect).not.toHaveBeenCalled()
  picker.destroy()
})
