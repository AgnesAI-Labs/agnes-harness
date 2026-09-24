/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { attachSessionMenu, closeSessionMenu, createSessionMenuTrigger } from '../src/session-menu.js'

afterEach(() => {
  closeSessionMenu()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function openMenu() {
  const row = document.createElement('div')
  row.className = 'session-row'
  const menu = document.createElement('div')
  menu.className = 'session-menu'
  const trigger = createSessionMenuTrigger('visible', '名称 visible')
  menu.append(trigger)
  row.append(menu)
  document.body.append(row)
  const select = vi.fn()
  attachSessionMenu(trigger, select)
  trigger.click()
  const panel = document.querySelector('.session-menu-actions') as HTMLElement
  return { row, trigger, select, panel }
}

it('labels the trigger for assistive technology and starts collapsed', () => {
  const trigger = createSessionMenuTrigger('visible', '名称 visible')
  expect(trigger.getAttribute('aria-label')).toBe('会话操作 名称 visible')
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(trigger.dataset.sessionActionId).toBe('visible')
  expect(trigger.querySelector('svg')).not.toBeNull()
})

it('portals one menu with three icon-led items and marks the trigger expanded', () => {
  const { trigger, panel } = openMenu()
  expect(panel.parentElement).toBe(document.body)
  expect(panel.getAttribute('role')).toBe('menu')
  const items = [...panel.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(items.map((item) => item.textContent)).toEqual(['重命名', '分叉会话', '归档会话'])
  expect(items.map((item) => item.querySelector('svg') !== null)).toEqual([true, true, true])
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(items[0])
})

it('closes before reporting the chosen action and returns focus to the trigger', () => {
  const { trigger, select, panel } = openMenu()
  ;(panel.querySelector('[role="menuitem"]') as HTMLButtonElement).click()
  expect(document.querySelector('.session-menu-actions')).toBeNull()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(select).toHaveBeenCalledWith('rename')
  expect(document.activeElement).toBe(trigger)
})

it('toggles the same trigger closed instead of stacking a second menu', () => {
  const { row, trigger } = openMenu()
  expect(row.getAttribute('data-menu-open')).toBe('true')
  trigger.click()
  expect(document.querySelector('.session-menu-actions')).toBeNull()
  expect(row.hasAttribute('data-menu-open')).toBe(false)
  trigger.click()
  expect(document.querySelectorAll('.session-menu-actions')).toHaveLength(1)
  expect(row.getAttribute('data-menu-open')).toBe('true')
})

it('closes on Escape without letting the key reach the page, and on an outside pointer', () => {
  const { trigger } = openMenu()
  const escapeKey = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
  document.dispatchEvent(escapeKey)
  expect(escapeKey.defaultPrevented).toBe(true)
  expect(document.querySelector('.session-menu-actions')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  openMenu()
  expect(document.querySelectorAll('.session-menu-actions')).toHaveLength(1)
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  expect(document.querySelector('.session-menu-actions')).toBeNull()
})

it('drops a stale menu when the sidebar redraws, since the panel outlives replaceChildren', () => {
  const nav = document.createElement('nav')
  const { trigger } = openMenu()
  nav.append(trigger)
  document.body.append(nav)
  expect(document.querySelector('.session-menu-actions')).not.toBeNull()
  closeSessionMenu()
  nav.replaceChildren()
  expect(document.querySelector('.session-menu-actions')).toBeNull()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})
