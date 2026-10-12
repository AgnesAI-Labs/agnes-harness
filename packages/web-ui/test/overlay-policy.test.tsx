/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { type ReactNode, useState } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { createRegionRenderer, mountApplication, unmountApplication } from '../src/antd-root.js'
import { getOverlayContainer, overlayLayers } from '../src/overlay-policy.js'
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
  const css = readFileSync(new NodeURL('../src/tokens.css', import.meta.url), 'utf8')
  for (const [name, value] of Object.entries(overlayLayers))
    expect(css).toContain(`--agnes-z-${name}: ${value};`)
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
