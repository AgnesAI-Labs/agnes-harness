/** @vitest-environment happy-dom */
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { Button, Count, Menu, mountRegion, Tag, Toast, Tooltip } from '../src/index.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
})
function render(element: Parameters<typeof mountRegion>[1]) {
  const host = document.createElement('div')
  document.body.append(host)
  cleanups.push(mountRegion(host, element))
  return host
}
function key(node: Element, name: string) {
  node.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
}

it('keeps tags textual and omits zero actionable counts', () => {
  const host = render(
    createElement(
      'div',
      null,
      createElement(Tag, { tone: 'warn' }, 'Restart required'),
      createElement(Count, { value: 0, label: 'No pending reviews' }),
      createElement(Count, { value: 3, label: '3 pending reviews' }),
    ),
  )
  expect(host.querySelector('[data-tone="warn"]')?.textContent).toBe('Restart required')
  expect(host.querySelectorAll('.agh-count')).toHaveLength(1)
  expect(host.querySelector('.agh-count')?.getAttribute('aria-label')).toBe('3 pending reviews')
})
it('moves through enabled menu actions, typeahead and danger-last grouping; restores focus', async () => {
  let selected = ''
  const host = render(
    createElement(Menu, {
      label: 'Actions',
      trigger: createElement(Button, null, 'More'),
      items: [
        {
          id: 'delete',
          label: 'Delete',
          danger: true,
          onSelect: () => {
            selected = 'delete'
          },
        },
        {
          id: 'edit',
          label: 'Edit',
          onSelect: () => {
            selected = 'edit'
          },
        },
        {
          id: 'disabled',
          label: 'Unavailable',
          disabled: true,
          onSelect: () => {
            selected = 'disabled'
          },
        },
        {
          id: 'copy',
          label: 'Copy',
          onSelect: () => {
            selected = 'copy'
          },
        },
      ],
    }),
  )
  const trigger = host.querySelector('button')!
  trigger.focus()
  key(trigger, 'ArrowDown')
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Edit'))
  const menu = document.querySelector('[role="menu"]')!
  expect([...menu.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent)).toEqual([
    'Edit',
    'Unavailable',
    'Copy',
    'Delete',
  ])
  expect(menu.querySelectorAll('hr')).toHaveLength(1)
  key(document.activeElement!, 'ArrowDown')
  expect(document.activeElement?.textContent).toBe('Copy')
  key(document.activeElement!, 'd')
  expect(document.activeElement?.textContent).toBe('Delete')
  key(document.activeElement!, 'Home')
  expect(document.activeElement?.textContent).toBe('Edit')
  key(document.activeElement!, 'Escape')
  await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
  expect(document.activeElement).toBe(trigger)
  trigger.click()
  await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'))
  document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click()
  expect(selected).toBe('edit')
  expect(document.activeElement).toBe(trigger)
})
it('explains a disabled action immediately on keyboard focus', async () => {
  const host = render(
    createElement(
      Tooltip,
      { title: 'Finish the review first', disabled: true },
      createElement('button', { type: 'button', disabled: true }, 'Install'),
    ),
  )
  host.querySelector<HTMLElement>('[tabindex="0"]')!.focus()
  await vi.waitFor(() =>
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Finish the review first'),
  )
  expect(host.querySelector('button')?.getAttribute('aria-describedby')).toBeTruthy()
  key(host.querySelector('[tabindex="0"]')!, 'Escape')
  await vi.waitFor(() => expect(host.querySelector('button')?.getAttribute('aria-describedby')).toBeNull())
})
it('announces success without stealing focus and cleans up the expiry on unmount', async () => {
  const dismiss = vi.fn()
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const host = render(createElement(Toast, { open: true, duration: 40, onDismiss: dismiss }, 'Saved'))
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Saved')
  expect(document.activeElement).toBe(trigger)
  key(trigger, 'Escape')
  expect(dismiss).toHaveBeenCalledTimes(1)
  cleanups.pop()!()
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(dismiss).toHaveBeenCalledTimes(1)
})

it('shares Lucide geometry between native and React icons and labels icon actions', async () => {
  const { Icon, IconButton, createSettingsIcon, icons } = await import('../src/index.js')
  for (const name of Object.keys(icons) as (keyof typeof icons)[]) {
    const host = render(createElement(Icon, { name, size: 20 }))
    const svg = host.querySelector('svg')!
    const native = createSettingsIcon(document, name)
    expect(svg.innerHTML).toBe(native.innerHTML)
    expect(svg.getAttribute('data-agnes-region')).toBe('icon')
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.getAttribute('stroke-width')).toBe('1.75')
  }
  const host = render(createElement(IconButton, { name: 'refresh-cw', label: 'Refresh' }))
  expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Refresh')
  const pending = render(createElement(Button, { 'aria-busy': true, disabled: true }, 'Refresh'))
  expect(pending.querySelector('button')?.getAttribute('aria-busy')).toBe('true')
  const settled = render(createElement(Button, { 'aria-busy': false }, 'Refresh'))
  expect(settled.querySelector('button')?.getAttribute('aria-busy')).toBe('false')
})
