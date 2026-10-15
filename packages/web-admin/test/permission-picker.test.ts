/** @vitest-environment happy-dom */

import { setLocaleTranslator } from '@agnes/web-foundation/locale-bridge'
import { zhT } from '@agnes/web-foundation/testkit/locale'
import { createRegionRenderer, type RegionRenderer } from '@agnes/web-ui'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  type PermissionMode,
  PermissionPickerControl,
  type PermissionPickerState,
  permissionLabel,
  yoloEnabled,
} from '../src/permission-picker.js'

// i18n: these suites assert zh-CN catalog output; pin the translator before imports run.
setLocaleTranslator(zhT)

const regions: RegionRenderer[] = []

function mountPicker(
  initial: PermissionPickerState,
  onSelect: (mode: PermissionMode) => Promise<boolean> = vi.fn(async () => true),
) {
  const host = document.createElement('div')
  document.body.append(host)
  const region = createRegionRenderer(host)
  regions.push(region)
  const onError = vi.fn()
  const render = (state: PermissionPickerState) => {
    region.render(createElement(PermissionPickerControl, { state, onSelect, onError }))
    region.flush()
  }
  render(initial)
  const trigger = host.querySelector<HTMLButtonElement>('#composer-permission')
  if (!trigger) throw new Error('permission trigger is missing')
  return { trigger, render, onSelect, onError }
}

function listbox(): HTMLElement {
  const found = document.querySelector<HTMLElement>('#permission-listbox')
  if (!found) throw new Error('permission listbox did not open')
  return found
}

function option(label: string): HTMLElement {
  const found = [...listbox().querySelectorAll<HTMLElement>('[role="option"]')].find(
    (row) => row.querySelector('.permission-picker-label')?.textContent === label,
  )
  if (!found) throw new Error(`missing permission option: ${label}`)
  return found
}

const opened = () => vi.waitFor(() => expect(document.querySelector('#permission-listbox')).not.toBeNull())
const closed = () => vi.waitFor(() => expect(document.querySelector('#permission-listbox')).toBeNull())

afterEach(() => {
  for (const region of regions.splice(0)) region.unmount()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it('labels the three session permission modes', () => {
  expect(permissionLabel('view')).toBe('只读')
  expect(permissionLabel('workspace')).toBe('可修改工作区')
  expect(permissionLabel('full')).toBe('完全访问')
  expect(yoloEnabled('full')).toBe(true)
  expect(yoloEnabled('workspace')).toBe(false)
})

it('shows the current mode on the trigger, lists the three modes and reports the chosen one', async () => {
  const { trigger, render, onSelect } = mountPicker({ disabled: false, pending: false, selected: null })
  const label = trigger.querySelector('[data-permission-label]')
  expect(label?.textContent).toBe('请选择权限')
  expect(trigger.dataset.permission).toBe('unknown')
  render({ disabled: false, pending: false, selected: 'workspace' })
  expect(label?.textContent).toBe('可修改工作区')
  expect(trigger.dataset.permission).toBe('workspace')
  expect(trigger.getAttribute('aria-label')).toBe('选择本会话权限')

  trigger.click()
  await opened()
  expect([...listbox().children].map((child) => child.getAttribute('role'))).toEqual([
    'option',
    'option',
    'option',
  ])
  expect(option('可修改工作区').getAttribute('aria-selected')).toBe('true')
  // The row carries one short line; the full explanation is its tooltip.
  expect(option('完全访问').textContent).toBe('完全访问跳过审批，谨慎使用')
  expect(option('完全访问').getAttribute('title')).toContain('工作区内外文件读写')
  expect(option('完全访问').getAttribute('title')).toContain('保留安全禁令和系统权限')
  expect(option('可修改工作区').getAttribute('title')).toContain('越界需切换完全权限或选择目录')

  // While the host is applying a change the list stays readable and refuses another choice.
  render({ disabled: false, pending: true, selected: 'workspace' })
  await vi.waitFor(() => expect(listbox().getAttribute('aria-busy')).toBe('true'))
  expect(option('完全访问').getAttribute('aria-disabled')).toBe('true')
  option('完全访问').click()
  expect(onSelect).not.toHaveBeenCalled()

  render({ disabled: false, pending: false, selected: 'workspace' })
  await vi.waitFor(() => expect(listbox().getAttribute('aria-busy')).toBe('false'))
  option('完全访问').click()
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith('full'))
  await closed()
})

it('moves the active permission with keys and returns focus on Escape', async () => {
  const { trigger, onSelect } = mountPicker({ disabled: false, pending: false, selected: 'workspace' })
  trigger.focus()
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  await opened()
  const list = listbox()
  expect(document.activeElement).toBe(list)
  expect(trigger.getAttribute('aria-controls')).toBe(list.id)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(list.getAttribute('aria-activedescendant')).toBe('permission-picker-option-1')

  const press = (key: string) =>
    list.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  const active = (index: number) =>
    vi.waitFor(() =>
      expect(list.getAttribute('aria-activedescendant')).toBe(`permission-picker-option-${index}`),
    )
  press('ArrowDown')
  await active(2)
  press('ArrowDown')
  await active(0)
  press('End')
  await active(2)
  press('Home')
  await active(0)
  press('Escape')

  await closed()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(trigger.hasAttribute('aria-controls')).toBe(false)
  expect(document.activeElement).toBe(trigger)
  expect(onSelect).not.toHaveBeenCalled()
})

it('selects the active mode with Enter and keeps the list open when the host declines', async () => {
  const onSelect = vi
    .fn<(mode: PermissionMode) => Promise<boolean>>()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true)
  const { trigger } = mountPicker({ disabled: false, pending: false, selected: 'workspace' }, onSelect)
  trigger.click()
  await opened()
  const enter = () =>
    listbox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  enter()
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(listbox().getAttribute('aria-busy')).toBe('false'))
  enter()
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalledTimes(2))
  expect(onSelect).toHaveBeenLastCalledWith('workspace')
  await closed()
})

it('reports a failed change and closes when the session can no longer change permission', async () => {
  const failure = new Error('refused')
  const onSelect = vi.fn(async () => {
    throw failure
  })
  const { trigger, render, onError } = mountPicker(
    { disabled: false, pending: false, selected: 'workspace' },
    onSelect,
  )
  trigger.click()
  await opened()
  option('只读').click()
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
  expect(document.querySelector('#permission-listbox')).not.toBeNull()

  render({ disabled: true, pending: false, selected: 'workspace' })
  await closed()
  expect(trigger.disabled).toBe(true)
})

it('links to the permission settings from the list', async () => {
  const { trigger } = mountPicker({ disabled: false, pending: false, selected: 'workspace' })
  const opens = vi.fn()
  document.addEventListener('agnes:permission-settings', opens)
  try {
    trigger.click()
    await opened()
    const help = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '.permission-picker-heading button.permission-picker-help',
      ),
    ].find((button) => button.textContent === '了解更多')
    if (!help) throw new Error('permission help is missing')
    // Each mode: its own glyph, a name and one short line; the long explanation is the tooltip.
    const rows = [...document.querySelectorAll<HTMLElement>('.permission-picker-option')]
    expect(rows.map((row) => row.dataset.permission)).toEqual(['view', 'workspace', 'full'])
    expect(rows.map((row) => row.querySelector('.permission-picker-hint')?.textContent)).toEqual([
      '只能查看，不改文件',
      '可改工作区内文件',
      '跳过审批，谨慎使用',
    ])
    for (const row of rows) {
      expect(row.querySelector('svg.permission-picker-icon')).not.toBeNull()
      expect(row.getAttribute('title')?.length ?? 0).toBeGreaterThan(16)
    }
    expect(rows.map((row) => row.querySelector('.permission-picker-check svg') !== null)).toEqual([
      false,
      true,
      false,
    ])
    help.click()
    expect(opens).toHaveBeenCalledTimes(1)
    await closed()
  } finally {
    document.removeEventListener('agnes:permission-settings', opens)
  }
})

it('shows measured isolation information without changing the permission choice', () => {
  const { trigger } = mountPicker({
    disabled: false,
    pending: false,
    selected: 'workspace',
    isolationNote: 'OS sandbox off',
  })
  expect(trigger.textContent).toContain('OS sandbox off')
  expect(trigger.dataset.permission).toBe('workspace')
})
