/** @vitest-environment happy-dom */
import { mountRegion } from '@agnes/web-ui'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionMenu } from '../src/session-menu.js'
import { zhT } from './helpers/locale.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function renderMenu(platform?: string) {
  const host = document.createElement('div')
  document.body.append(host)
  const select = vi.fn()
  const dispose = mountRegion(
    host,
    <div className="session-row">
      <SessionMenu
        id="visible"
        title="名称 visible"
        disabled={false}
        platform={platform}
        t={zhT}
        action={select}
      />
    </div>,
  )
  cleanups.push(dispose)
  const row = host.querySelector<HTMLElement>('.session-row')
  const trigger = host.querySelector<HTMLButtonElement>('[data-session-action-id="visible"]')
  if (!row || !trigger) throw new Error('session menu did not render')
  const open = async () => {
    trigger.focus()
    trigger.click()
    await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'))
    await vi.waitFor(() =>
      expect(document.getElementById(trigger.getAttribute('aria-controls') ?? '')?.getAttribute('role')).toBe(
        'menu',
      ),
    )
    const panel = document.getElementById(trigger.getAttribute('aria-controls') ?? '')
    if (!panel) throw new Error('session menu did not open')
    await vi.waitFor(() => expect(document.activeElement).toBe(panel.querySelector('[role=menuitem]')))
    await vi.waitFor(() => expect(row.getAttribute('data-menu-open')).toBe('true'))
    return panel
  }
  const closed = async () => {
    await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
    await vi.waitFor(() => expect(row.hasAttribute('data-menu-open')).toBe(false))
  }
  return { host, row, trigger, select, dispose, open, closed }
}

it('labels the trigger for assistive technology and starts collapsed', () => {
  const { trigger } = renderMenu()
  expect(trigger.getAttribute('aria-label')).toBe('会话操作 名称 visible')
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(trigger.dataset.sessionActionId).toBe('visible')
  expect(trigger.querySelector('svg')).not.toBeNull()
})

it('portals one menu with five icon-led items and marks the trigger expanded', async () => {
  const { host, trigger, open } = renderMenu()
  const panel = await open()
  expect(host.contains(panel)).toBe(false)
  expect(document.body.contains(panel)).toBe(true)
  expect(panel.getAttribute('role')).toBe('menu')
  const items = [...panel.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(items.map((item) => item.textContent)).toEqual([
    '重命名',
    '分叉会话',
    '在文件管理器中打开',
    '运行信息',
    '归档会话',
  ])
  expect(items.map((item) => item.querySelector('svg') !== null)).toEqual([true, true, true, true, true])
  expect([...panel.children].filter((item) => item.classList.contains('agh-menu-separator'))).toHaveLength(2)
  expect([...panel.children].map((item) => item.textContent)).toEqual([
    '重命名',
    '分叉会话',
    '',
    '在文件管理器中打开',
    '运行信息',
    '',
    '归档会话',
  ])
  for (const item of items) {
    expect(item.closest('.agh-menu-popup--neutral')).not.toBeNull()
    expect(item.querySelector('.agh-menu-icon')).not.toBeNull()
    expect(item.querySelector('svg')?.getAttribute('width')).toBe('16')
    expect(item.querySelector('svg')?.getAttribute('stroke-width')).toBe('1.5')
  }
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(items[0])
  items[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(document.activeElement).toBe(items[1])
  items[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  expect(document.activeElement).toBe(items[4])
})

it('dismisses on selection, reports the session action and returns focus to the trigger', async () => {
  const { trigger, select, open, closed } = renderMenu()
  const panel = await open()
  panel.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click()
  await closed()
  expect(select).toHaveBeenCalledWith('rename', 'visible', '名称 visible', trigger)
  expect(document.activeElement).toBe(trigger)
})

it('toggles the same trigger closed instead of stacking a second menu', async () => {
  const { row, trigger, open, closed } = renderMenu()
  await open()
  trigger.click()
  await closed()
  await open()
  expect(document.querySelectorAll('[role=menu]')).toHaveLength(1)
  expect(row.getAttribute('data-menu-open')).toBe('true')
})

it('closes on Escape without letting the key reach the page, and on an outside click', async () => {
  const { trigger, open, closed } = renderMenu()
  const panel = await open()
  const pageKey = vi.fn()
  document.addEventListener('keydown', pageKey)
  cleanups.push(() => document.removeEventListener('keydown', pageKey))
  const escapeKey = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
  panel.querySelector<HTMLElement>('[role=menuitem]')?.dispatchEvent(escapeKey)
  await closed()
  expect(escapeKey.defaultPrevented).toBe(true)
  expect(pageKey).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(trigger)
  await open()
  const outside = document.createElement('button')
  document.body.append(outside)
  outside.focus()
  outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  outside.click()
  await closed()
  expect(document.activeElement).toBe(outside)
})

it('removes a portalled menu and row state when the sidebar unmounts', async () => {
  const { row, trigger, dispose, open } = renderMenu()
  await open()
  dispose()
  expect(document.querySelector('[role=menu]')).toBeNull()
  expect(row.hasAttribute('data-menu-open')).toBe(false)
  expect(trigger.isConnected).toBe(false)
})

it.each([
  ['darwin', '在访达中打开'],
  ['win32', '在资源管理器中打开'],
  ['linux', '在文件管理器中打开'],
])('uses the daemon %s platform label and dispatches only a session id', async (platform, label) => {
  const { open, select, trigger } = renderMenu(platform)
  const panel = await open()
  const item = [...panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (entry) => entry.textContent === label,
  )
  expect(item).toBeTruthy()
  item?.click()
  expect(select).toHaveBeenCalledWith('revealWorkspace', 'visible', '名称 visible', trigger)
})
