/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { type ReactNode, useState } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { createRegionRenderer, mountApplication, unmountApplication } from '../src/antd-root.js'
import { getOverlayContainer, overlayLayers } from '../src/overlay-policy.js'
import { Toast } from '../src/overlay-toast.js'
import { Button } from '../src/ui/button.js'
import { Dialog } from '../src/ui/dialog.js'
import { Drawer } from '../src/ui/drawer.js'
import { Menu } from '../src/ui/menu.js'

afterEach(() => {
  unmountApplication(document)
  document.body.replaceChildren()
})

it('keeps layer tokens ordered and retains native modal and Radix portal focus scopes', () => {
  const values = Object.values(overlayLayers)
  expect(values.every((value, index) => index === 0 || value > (values[index - 1] ?? 0))).toBe(true)
  const css = readFileSync(new NodeURL('../../web/public/styles/01-tokens.css', import.meta.url), 'utf8')
  for (const [name, value] of Object.entries(overlayLayers))
    expect(css).toContain(`--agh-z-${name}: ${value};`)
  const bridge = readFileSync(new NodeURL('../src/tokens.css', import.meta.url), 'utf8')
  for (const [component, layer] of Object.entries({
    dropdown: 'dropdown',
    select: 'dropdown',
    popover: 'dropdown',
    drawer: 'drawer',
    tooltip: 'tooltip',
    message: 'notification',
    notification: 'notification',
  }))
    expect(bridge).toContain(`--ant-${component}-z-index-popup: var(--agh-z-${layer});`)
  const global = document.createElement('div')
  global.id = 'agnes-overlay-container'
  const dialog = document.createElement('dialog')
  dialog.open = true
  const trigger = document.createElement('span')
  dialog.append(trigger)
  global.append(dialog)
  document.body.append(global)
  expect(getOverlayContainer()).toBe(global)
  expect(getOverlayContainer(trigger)).toBe(dialog)
  // This exported policy is also the container supplied to custom/Radix portals.
  dialog.open = false
  expect(getOverlayContainer(trigger)).toBe(global)
  const popup = document.createElement('div')
  popup.setAttribute('popover', 'manual')
  global.append(popup)
  popup.append(trigger)
  expect(getOverlayContainer(trigger)).toBe(popup)
})

it.each(['modal', 'drawer'] as const)(
  'closes a menu before its containing %s and restores trigger focus',
  async (kind) => {
    const root = document.createElement('div')
    document.body.append(root)
    function Shell({ children }: { children?: ReactNode }) {
      return (
        <div id="agnes-overlay-container">
          <div id="fixture" />
          {children}
        </div>
      )
    }
    mountApplication(root, <Shell />)
    const host = document.getElementById('fixture') as HTMLElement
    function Fixture() {
      const [open, setOpen] = useState(true)
      const menu = (
        <Menu
          label="actions"
          trigger={<Button id="menu-trigger">actions</Button>}
          items={[{ id: 'action', label: 'action', onSelect() {} }]}
        />
      )
      return (
        <>
          <span data-testid="overlay-state">{open ? 'open' : 'closed'}</span>
          {kind === 'modal' ? (
            <Dialog open={open} title="modal" footer={null} onCancel={() => setOpen(false)}>
              {menu}
            </Dialog>
          ) : (
            <Drawer open={open} title="drawer" onClose={() => setOpen(false)}>
              {menu}
            </Drawer>
          )}
        </>
      )
    }
    flushSync(() => createRegionRenderer(host).render(<Fixture />))
    await vi.waitFor(() => expect(document.getElementById('menu-trigger')).not.toBeNull())
    const trigger = document.getElementById('menu-trigger') as HTMLButtonElement
    trigger.focus()
    flushSync(() => trigger.click())
    await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull())
    const item = document.querySelector<HTMLElement>('[role="menuitem"]') as HTMLElement
    const scope = kind === 'modal' ? '.ant-modal' : '.ant-drawer-section'
    expect(item.closest(scope)).not.toBeNull()
    item.focus()
    flushSync(() =>
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
    )
    expect(document.getElementById('menu-trigger')).toBe(trigger)
    expect(document.activeElement).toBe(trigger)
    expect(trigger.closest(scope)).not.toBeNull()
    flushSync(() =>
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid=overlay-state]')?.textContent).toBe('closed'),
    )
  },
)

it('mounts notification holders in the shared outlet or active native dialog scope', async () => {
  const root = document.createElement('div')
  document.body.append(root)
  function Shell({ children }: { children?: ReactNode }) {
    return (
      <>
        <div id="fixture" />
        <div id="agnes-overlay-container">
          <dialog id="native" />
        </div>
        {children}
      </>
    )
  }
  mountApplication(root, <Shell />)
  const page = createRegionRenderer(document.getElementById('fixture')!)
  const dialog = createRegionRenderer(document.getElementById('native')!)
  flushSync(() => {
    page.render(
      <Toast open duration={0} onDismiss={() => {}}>
        page saved
      </Toast>,
    )
  })
  await vi.waitFor(() => expect(document.querySelectorAll('[role="status"]')).toHaveLength(1))
  const holder = document.querySelector('#agnes-overlay-container > .agh-toast-host')
  expect(holder?.textContent).toContain('page saved')
  // Notifications created while a native dialog is open belong to its focus scope.
  document.getElementById('native')?.setAttribute('open', '')
  flushSync(() => {
    dialog.render(
      <Toast open duration={0} onDismiss={() => {}}>
        dialog saved
      </Toast>,
    )
  })
  await vi.waitFor(() => expect(document.querySelectorAll('[role="status"]')).toHaveLength(2))
  expect(document.querySelector('#native > .agh-toast-host')?.textContent).toContain('dialog saved')
  page.unmount()
  expect(document.querySelector('#agnes-overlay-container > .agh-toast-host')).toBeNull()
  expect(document.querySelector('#native > .agh-toast-host')?.textContent).toContain('dialog saved')
})

it('keeps a toast in the shared outlet when a popover merely holds focus', async () => {
  const root = document.createElement('div')
  document.body.append(root)
  function Shell({ children }: { children?: ReactNode }) {
    return (
      <>
        <div id="fixture" />
        <div id="agnes-overlay-container" />
        {children}
      </>
    )
  }
  mountApplication(root, <Shell />)
  const page = createRegionRenderer(document.getElementById('fixture')!)
  // A picker option keeps focus while it closes; a toast raised by that choice must outlive it.
  const popover = document.createElement('div')
  popover.setAttribute('popover', 'manual')
  const option = document.createElement('button')
  popover.append(option)
  document.body.append(popover)
  option.focus()
  flushSync(() => {
    page.render(
      <Toast open duration={0} onDismiss={() => {}}>
        draft model saved
      </Toast>,
    )
  })
  await vi.waitFor(() => expect(document.querySelectorAll('[role="status"]')).toHaveLength(1))
  expect(document.querySelector('#agnes-overlay-container > .agh-toast-host')?.textContent).toContain(
    'draft model saved',
  )
  expect(popover.querySelector('.agh-toast-host')).toBeNull()
})
