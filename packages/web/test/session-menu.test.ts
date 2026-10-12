/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionMenu } from '../src/session-menu.js'
import { zhT } from './helpers/locale.js'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
const roots = new Set<Root>()

afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount())
  roots.clear()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

async function mountMenu(open = true) {
  const row = document.createElement('div')
  row.className = 'session-row'
  document.body.append(row)
  const root = createRoot(row)
  roots.add(root)
  const select = vi.fn()
  await act(async () =>
    root.render(
      createElement(SessionMenu, {
        id: 'visible',
        title: '名称 visible',
        disabled: false,
        t: zhT,
        action: select,
      }),
    ),
  )
  const trigger = row.querySelector<HTMLButtonElement>('button')!
  if (open) await act(async () => trigger.click())
  const panel = () => document.getElementById(trigger.getAttribute('aria-controls') ?? '')!
  return { row, trigger, select, panel, root }
}

it('labels the trigger for assistive technology and starts collapsed', async () => {
  const { trigger } = await mountMenu(false)
  expect(trigger.getAttribute('aria-label')).toBe('会话操作 名称 visible')
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(trigger.dataset.sessionActionId).toBe('visible')
  expect(trigger.querySelector('svg')).not.toBeNull()
})

it('portals one menu with three icon-led items and marks the trigger expanded', async () => {
  const { row, trigger, panel } = await mountMenu()
  expect(document.body.contains(panel())).toBe(true)
  expect(row.contains(panel())).toBe(false)
  expect(panel().getAttribute('role')).toBe('menu')
  const items = [...panel().querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(items.map((item) => item.textContent)).toEqual(['重命名', '分叉会话', '归档会话'])
  expect(items.map((item) => item.querySelector('svg') !== null)).toEqual([true, true, true])
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(items[0])
})

it('reports the chosen session action and returns focus to the collapsed trigger', async () => {
  const { trigger, select, panel } = await mountMenu()
  await act(async () => panel().querySelector<HTMLButtonElement>('[role="menuitem"]')!.click())
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(select).toHaveBeenCalledWith('rename', 'visible', '名称 visible', trigger)
  expect(document.activeElement).toBe(trigger)
})

it('toggles the same trigger closed and mirrors the menu state on its row', async () => {
  const { row, trigger, panel } = await mountMenu()
  expect(row.getAttribute('data-menu-open')).toBe('true')
  await act(async () => trigger.click())
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(row.hasAttribute('data-menu-open')).toBe(false)
  await act(async () => trigger.click())
  expect(panel().getAttribute('role')).toBe('menu')
  expect(row.getAttribute('data-menu-open')).toBe('true')
})

it('closes on Escape without letting the key reach the page, and on an outside pointer', async () => {
  const { trigger, panel } = await mountMenu()
  const pageKey = vi.fn()
  document.addEventListener('keydown', pageKey)
  try {
    const escapeKey = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
    await act(async () => {
      panel().dispatchEvent(escapeKey)
    })
    expect(escapeKey.defaultPrevented).toBe(true)
    expect(pageKey).not.toHaveBeenCalled()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    await act(async () => trigger.click())
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  } finally {
    document.removeEventListener('keydown', pageKey)
  }
})

it('removes the portalled menu when the sidebar row unmounts', async () => {
  const { panel, root } = await mountMenu()
  const menu = panel()
  expect(menu.isConnected).toBe(true)
  await act(async () => root.unmount())
  roots.delete(root)
  expect(menu.isConnected).toBe(false)
})
