/** @vitest-environment happy-dom */
import { createElement, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ADVANCED_SETTINGS_STORAGE_KEY,
  advancedSettingsShown,
  advancedSettingsValue,
  Banner,
  Button,
  Drawer,
  EmptyState,
  Field,
  Icon,
  ListRow,
  Menu,
  mountRegion,
  SettingsAdvanced,
  SettingsPage,
  SettingsSaveBar,
  SettingsToolbar,
  setAdvancedSettingsShown,
  subscribeAdvancedSettings,
} from '../src/index.js'

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  document.body.replaceChildren()
  setAdvancedSettingsShown(false)
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
  // Header, notice, toolbar, body and save bar, in that order (the subpage frame adds no boxes).
  const page = host.querySelector('#existing-pane')!
  const parts = [
    'header.agnes-settings-page-top',
    '.agh-banner',
    '.agnes-settings-toolbar',
    '.agnes-settings-page-body',
    '.agh-settings-save-bar',
  ].map((selector) => page.querySelector(selector))
  expect(parts.every(Boolean)).toBe(true)
  for (const [index, part] of parts.entries())
    if (index > 0)
      expect(parts[index - 1]!.compareDocumentPosition(part!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
it.each(['default', 'file'] as const)('keeps %s row actions separate from its detail button', (variant) => {
  const open = vi.fn(),
    action = vi.fn()
  const host = render(
    createElement(ListRow, {
      variant,
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
  if (variant === 'file') {
    const name = 'delivery-summary.pdf'
    const label = render(createElement(ListRow, { variant, title: name }))
    expect(label.querySelector('h3')?.textContent).toBe(name)
    expect(label.querySelector('h3')?.title).toBe(name)
  }
})
it('closes the detail drawer on Escape and returns focus to its trigger', async () => {
  function Fixture() {
    const [open, setOpen] = useState(false)
    return createElement(
      'div',
      null,
      createElement(Button, { onClick: () => setOpen(true) }, 'Details'),
      createElement(
        Drawer,
        { id: 'detail-drawer', open, title: 'Plugin details', onClose: () => setOpen(false) },
        createElement(Menu, {
          label: 'Detail actions',
          trigger: createElement(Button, { id: 'drawer-menu-trigger' }, 'Actions'),
          items: [{ id: 'inspect', label: 'Inspect', onSelect: () => {} }],
        }),
      ),
    )
  }
  const host = render(createElement(Fixture))
  const trigger = host.querySelector('button')!
  trigger.focus()
  trigger.click()
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
  const drawer = document.querySelector('[role="dialog"]')!
  expect(document.querySelectorAll('#detail-drawer')).toHaveLength(1)
  const labelledBy = drawer.getAttribute('aria-labelledby')
  expect(labelledBy && document.getElementById(labelledBy)?.textContent).toBe('Plugin details')
  const innerTrigger = drawer.querySelector<HTMLElement>('#drawer-menu-trigger')!
  innerTrigger.focus()
  innerTrigger.click()
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Inspect'))
  const menuEscape = new KeyboardEvent('keydown', {
    key: 'Escape',
    keyCode: 27,
    bubbles: true,
    cancelable: true,
  })
  document.activeElement?.dispatchEvent(menuEscape)
  await vi.waitFor(() => expect(document.activeElement).toBe(innerTrigger))
  expect(document.querySelector('[role="dialog"]')).toBe(drawer)
  const cancel = new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
    bubbles: true,
    cancelable: true,
  })
  drawer.dispatchEvent(cancel)
  expect(cancel.defaultPrevented).toBe(true)
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  expect(document.activeElement).toBe(trigger)
})

it('announces loading once, marks it busy, shows the skeleton after 200 ms and removes it after completion', async () => {
  const { SettingsState, renderRegion } = await import('../src/index.js')
  const host = render(createElement(SettingsState, { tone: 'loading' }, 'Loading skills…'))
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Loading skills…')
  expect(host.querySelector('[role="status"]')?.getAttribute('aria-busy')).toBe('true')
  // The shared loading rule: nothing on screen for 200 ms, then the decorative skeleton.
  expect(host.querySelector('.agh-skeleton')).toBeNull()
  await vi.waitFor(() =>
    expect(host.querySelector('.agh-skeleton')?.getAttribute('aria-hidden')).toBe('true'),
  )
  renderRegion(host, createElement(SettingsState, { tone: 'success' }, 'Loaded'))
  expect(host.querySelector('.agh-skeleton')).toBeNull()
  expect(host.querySelector('[role="status"]')?.getAttribute('aria-busy')).toBeNull()
})

it('shows an advanced fold only while advanced settings are on, and remembers the switch on this computer', async () => {
  const host = render(
    createElement(
      SettingsAdvanced,
      { title: 'Auxiliary models', summary: 'Automatic', 'data-testid': 'aux' },
      createElement('p', null, 'Fast model'),
    ),
  )
  // The suite turned the switch off; that explicit choice is what hides the fold.
  expect(localStorage.getItem(ADVANCED_SETTINGS_STORAGE_KEY)).toBe('0')
  expect(host.querySelector('[data-testid="aux"]')).toBeNull()
  expect(advancedSettingsShown()).toBe(false)
  setAdvancedSettingsShown(true)
  await vi.waitFor(() => expect(host.querySelector('[data-testid="aux"]')).not.toBeNull())
  expect(localStorage.getItem(ADVANCED_SETTINGS_STORAGE_KEY)).toBe('1')
  const fold = host.querySelector<HTMLElement>('[data-testid="aux"]')
  // Closed by default; the header names the setting, marks it advanced and states the current value.
  expect(fold?.dataset.open).toBe('false')
  expect(fold?.querySelector('.agh-disclosure-title')?.textContent).toBe('Auxiliary modelsAdvanced')
  expect(fold?.querySelector('.agh-disclosure-meta')?.textContent).toBe('Automatic')
  host.querySelector<HTMLButtonElement>('[data-testid="aux-toggle"]')?.click()
  await vi.waitFor(() => expect(fold?.dataset.open).toBe('true'))
  // A blocked store keeps the choice for this page instead of failing.
  const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage is blocked')
  })
  try {
    expect(() => setAdvancedSettingsShown(false)).not.toThrow()
    expect(advancedSettingsShown()).toBe(false)
    await vi.waitFor(() => expect(host.querySelector('[data-testid="aux"]')).toBeNull())
  } finally {
    blocked.mockRestore()
    localStorage.removeItem(ADVANCED_SETTINGS_STORAGE_KEY)
  }
})

it('synchronizes local storage changes without discarding an in-memory choice when storage is blocked', () => {
  const changed = vi.fn()
  const stop = subscribeAdvancedSettings(changed)
  try {
    localStorage.setItem(ADVANCED_SETTINGS_STORAGE_KEY, '1')
    window.dispatchEvent(
      new StorageEvent('storage', { key: ADVANCED_SETTINGS_STORAGE_KEY, storageArea: localStorage }),
    )
    expect(advancedSettingsShown()).toBe(true)
    localStorage.setItem(ADVANCED_SETTINGS_STORAGE_KEY, '0')
    window.dispatchEvent(
      new StorageEvent('storage', { key: ADVANCED_SETTINGS_STORAGE_KEY, storageArea: localStorage }),
    )
    expect(advancedSettingsShown()).toBe(false)
    // Clearing the store forgets the choice, and an absent choice means on.
    localStorage.clear()
    window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }))
    expect(advancedSettingsShown()).toBe(true)
    setAdvancedSettingsShown(false)
    const blocked = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    try {
      setAdvancedSettingsShown(true)
      window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: sessionStorage }))
      expect(advancedSettingsShown()).toBe(true)
      window.dispatchEvent(
        new StorageEvent('storage', { key: ADVANCED_SETTINGS_STORAGE_KEY, storageArea: localStorage }),
      )
      expect(advancedSettingsShown()).toBe(true)
    } finally {
      blocked.mockRestore()
    }
  } finally {
    stop()
  }
  // A change made while no view subscribes must be picked up on the next mount.
  localStorage.setItem(ADVANCED_SETTINGS_STORAGE_KEY, '0')
  const restart = subscribeAdvancedSettings(changed)
  expect(advancedSettingsShown()).toBe(false)
  restart()
})

it('shows advanced settings until this browser turns them off', () => {
  expect(advancedSettingsValue(null)).toBe(true)
  expect(advancedSettingsValue(undefined)).toBe(true)
  expect(advancedSettingsValue('1')).toBe(true)
  expect(advancedSettingsValue('0')).toBe(false)
  // No stored choice: on.
  localStorage.removeItem(ADVANCED_SETTINGS_STORAGE_KEY)
  const stop = subscribeAdvancedSettings(() => {})
  expect(advancedSettingsShown()).toBe(true)
  stop()
  // The explicit "off" is remembered.
  setAdvancedSettingsShown(false)
  expect(localStorage.getItem(ADVANCED_SETTINGS_STORAGE_KEY)).toBe('0')
  const again = subscribeAdvancedSettings(() => {})
  expect(advancedSettingsShown()).toBe(false)
  again()
})
