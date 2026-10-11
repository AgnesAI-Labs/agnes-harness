/** @vitest-environment happy-dom */
import { createElement, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  Banner,
  Button,
  Drawer,
  EmptyState,
  Field,
  Icon,
  ListRow,
  mountRegion,
  SettingsPage,
  SettingsSaveBar,
  SettingsToolbar,
} from '../src/index.js'

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  document.body.replaceChildren()
})
function render(element: Parameters<typeof mountRegion>[1]) {
  const host = document.createElement('div')
  document.body.append(host)
  disposers.push(mountRegion(host, element))
  return host
}
it('keeps page hooks and lays out heading, notice, toolbar, body and dirty actions in order', () => {
  const save = vi.fn(),
    discard = vi.fn()
  const host = render(
    createElement(
      SettingsPage,
      {
        title: 'Settings',
        id: 'existing-pane',
        headingId: 'existing-title',
        'data-agnes-region': 'settings-pane',
        banner: createElement(Banner, null, 'Review these changes'),
        toolbar: createElement(SettingsToolbar, {
          search: createElement('input', { type: 'search', 'aria-label': 'Search' }),
        }),
        saveBar: createElement(SettingsSaveBar, { dirty: true, onSave: save, onDiscard: discard }),
      },
      createElement('p', null, 'Content'),
    ),
  )
  expect(host.querySelector('#existing-pane')?.getAttribute('data-agnes-region')).toBe('settings-pane')
  expect([...host.querySelector('#existing-pane')!.children].map((node) => node.tagName)).toEqual([
    'HEADER',
    'DIV',
    'DIV',
    'DIV',
    'DIV',
  ])
  expect(host.querySelector('#existing-title')?.textContent).toBe('Settings')
  const actions = host.querySelectorAll<HTMLButtonElement>('.agh-settings-save-bar button')
  expect([...actions].map((node) => node.textContent)).toEqual(['Discard', 'Save'])
  actions[0]!.click()
  actions[1]!.click()
  expect(discard).toHaveBeenCalled()
  expect(save).toHaveBeenCalled()
})
it('omits a clean save bar and refuses double save/discard while busy', () => {
  const action = vi.fn()
  expect(
    render(createElement(SettingsSaveBar, { dirty: false, onSave: action, onDiscard: action }))
      .childElementCount,
  ).toBe(0)
  const host = render(
    createElement(SettingsSaveBar, { dirty: true, busy: true, onSave: action, onDiscard: action }),
  )
  for (const button of host.querySelectorAll<HTMLButtonElement>('button')) button.click()
  expect(action).not.toHaveBeenCalled()
})
it('replaces hints with errors and connects the control without changing its ID', () => {
  const host = render(
    createElement(
      Field,
      { label: 'Name', htmlFor: 'name', hint: 'Use a short name', error: 'Enter a name' },
      createElement('input', { id: 'name' }),
    ),
  )
  expect(host.textContent).not.toContain('Use a short name')
  expect(host.querySelector('input')?.getAttribute('aria-invalid')).toBe('true')
  const id = host.querySelector('input')?.getAttribute('aria-describedby')
  expect(document.getElementById(id!)?.textContent).toBe('Enter a name')
  expect(host.querySelector('label')?.htmlFor).toBe('name')
})
it('offers teaching content and only allows informational banners to be dismissed', () => {
  const dismiss = vi.fn()
  const host = render(
    createElement(
      'div',
      null,
      createElement(EmptyState, {
        icon: createElement(Icon, { name: 'plug', size: 48 }),
        title: 'No plugins',
        description: 'Add a capability',
        actions: createElement(Button, { type: 'primary' }, 'Browse'),
      }),
      createElement(Banner, { tone: 'error', onDismiss: dismiss }, 'Unable to load'),
      createElement(Banner, { tone: 'info', onDismiss: dismiss }, 'A useful tip'),
    ),
  )
  expect(host.querySelector('.agh-empty-state h3')?.textContent).toBe('No plugins')
  expect(host.querySelector('.agh-banner[role="alert"] button')).toBeNull()
  host.querySelector<HTMLButtonElement>('.agh-banner[role="status"] button')!.click()
  expect(dismiss).toHaveBeenCalledTimes(1)
})
it('keeps row actions separate from its detail button', () => {
  const open = vi.fn(),
    action = vi.fn()
  const host = render(
    createElement(ListRow, {
      title: 'Plugin',
      description: 'A short description',
      onOpen: open,
      actions: createElement(Button, { onClick: action }, 'Enable'),
    }),
  )
  const buttons = host.querySelectorAll<HTMLButtonElement>('button')
  buttons[1]!.click()
  expect(action).toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  buttons[0]!.click()
  expect(open).toHaveBeenCalledTimes(1)
  host.querySelector('p')!.click()
  expect(open).toHaveBeenCalledTimes(2)
  expect(document.activeElement).toBe(buttons[0])
})
it('closes the native detail drawer on Escape and returns focus to its trigger', async () => {
  function Fixture() {
    const [open, setOpen] = useState(false)
    return createElement(
      'div',
      null,
      createElement(Button, { onClick: () => setOpen(true) }, 'Details'),
      createElement(Drawer, { open, title: 'Plugin details', onClose: () => setOpen(false) }, 'Contents'),
    )
  }
  const host = render(createElement(Fixture))
  const trigger = host.querySelector('button')!
  trigger.focus()
  trigger.click()
  await vi.waitFor(() => expect(document.querySelector('dialog')?.open).toBe(true))
  const drawer = document.querySelector('dialog')!
  const cancel = new Event('cancel', { cancelable: true })
  drawer.dispatchEvent(cancel)
  expect(cancel.defaultPrevented).toBe(true)
  await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull())
  expect(document.activeElement).toBe(trigger)
})
