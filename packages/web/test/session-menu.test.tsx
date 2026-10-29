/** @vitest-environment happy-dom */
import { mountRegion, renderRegion } from '@agnes/web-ui'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionMenu } from '../src/session-menu.js'
import { zhT } from './helpers/locale.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function renderMenu(platform?: string, chats = false, pinned = false, archived = false) {
  const host = document.createElement('div')
  document.body.append(host)
  const select = vi.fn()
  const view = (disabled: boolean) => (
    <div className="session-row">
      <SessionMenu
        id="visible"
        title="名称 visible"
        disabled={disabled}
        platform={platform}
        chats={chats}
        pinned={pinned}
        archived={archived}
        t={zhT}
        action={select}
      />
    </div>
  )
  const dispose = mountRegion(host, view(false))
  cleanups.push(dispose)
  const row = host.querySelector<HTMLElement>('.session-row')
  const getTrigger = () => {
    const button = host.querySelector<HTMLButtonElement>('[data-session-action-id="visible"]')
    if (!button) throw new Error('session menu trigger did not render')
    return button
  }
  if (!row) throw new Error('session menu did not render')
  const open = async (keyboard = false) => {
    const trigger = getTrigger()
    trigger.focus()
    if (keyboard)
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      )
    else trigger.click()
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
    await vi.waitFor(() => expect(getTrigger().getAttribute('aria-expanded')).toBe('false'))
    await vi.waitFor(() => expect(row.hasAttribute('data-menu-open')).toBe(false))
  }
  return {
    host,
    row,
    select,
    dispose,
    open,
    closed,
    get trigger() {
      return getTrigger()
    },
    setDisabled(disabled: boolean) {
      renderRegion(host, view(disabled))
    },
  }
}

it.each(['win32', 'darwin'])(
  'closes and blocks a disabled session menu, then reopens on %s',
  async (platform) => {
    const menu = renderMenu(platform)
    const panel = await menu.open()
    const oldItems = [...panel.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    menu.setDisabled(true)
    expect(menu.trigger.disabled).toBe(true)
    expect(menu.trigger.getAttribute('aria-expanded')).toBe('false')
    expect(menu.trigger.hasAttribute('aria-controls')).toBe(false)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(menu.row.hasAttribute('data-menu-open')).toBe(false)
    // Late input on the removed popup and attempts to reopen must not dispatch an action.
    for (const item of oldItems) {
      item.click()
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
    menu.trigger.click()
    menu.trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(menu.select).not.toHaveBeenCalled()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    menu.setDisabled(false)
    expect(menu.trigger.disabled).toBe(false)
    expect(menu.trigger.getAttribute('aria-expanded')).toBe('false')
    expect(menu.row.hasAttribute('data-menu-open')).toBe(false)
    for (const item of oldItems) item.click()
    expect(menu.select).not.toHaveBeenCalled()
    const reopened = await menu.open(true)
    const label = platform === 'darwin' ? '在访达中打开' : '在资源管理器中打开'
    const item = [...reopened.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === label,
    )
    expect(item).toBeDefined()
    item?.click()
    await menu.closed()
    expect(menu.select).toHaveBeenCalledWith('revealWorkspace', 'visible', '名称 visible', menu.trigger)
    expect(document.activeElement).toBe(menu.trigger)
    // A second disable/enable cycle must rebind row tracking to the new trigger too.
    await menu.open()
    menu.setDisabled(true)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(menu.row.hasAttribute('data-menu-open')).toBe(false)
    menu.setDisabled(false)
    await menu.open()
    menu.dispose()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(menu.row.hasAttribute('data-menu-open')).toBe(false)
  },
)

it('offers no folder to show for a chat in the managed chats workspace', async () => {
  const items = [...(await renderMenu('darwin', true).open()).querySelectorAll('[role="menuitem"]')]
  expect(items.map((item) => item.textContent)).toEqual([
    '置顶',
    '重命名',
    '分叉会话',
    '运行信息',
    '归档会话',
  ])
})

it('drops the pin actions and offers 恢复会话 for an archived session', async () => {
  const { open, select, closed, trigger } = renderMenu('darwin', false, false, true)
  const items = [...(await open()).querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(items.map((item) => item.textContent)).toEqual([
    '重命名',
    '分叉会话',
    '在访达中打开',
    '运行信息',
    '恢复会话',
  ])
  items.at(-1)?.click()
  await closed()
  // 恢复走会话仓库的统一通道，菜单只负责派发动作。
  expect(select).toHaveBeenCalledWith('unarchive', 'visible', '名称 visible', trigger)
})

it('offers 「取消置顶」 for a pinned session and reports it as unpin', async () => {
  const { trigger, select, open, closed } = renderMenu('darwin', false, true)
  const first = (await open()).querySelector<HTMLElement>('[role="menuitem"]')
  expect(first?.textContent).toBe('取消置顶')
  first?.click()
  await closed()
  expect(select).toHaveBeenCalledWith('unpin', 'visible', '名称 visible', trigger)
})

it('labels the trigger for assistive technology and starts collapsed', () => {
  const { trigger } = renderMenu()
  expect(trigger.getAttribute('aria-label')).toBe('会话操作 名称 visible')
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(trigger.dataset.sessionActionId).toBe('visible')
  expect(trigger.querySelector('svg')).not.toBeNull()
})

it('portals one menu with six icon-led items and marks the trigger expanded', async () => {
  const { host, trigger, open } = renderMenu()
  const panel = await open()
  expect(host.contains(panel)).toBe(false)
  expect(document.body.contains(panel)).toBe(true)
  expect(panel.getAttribute('role')).toBe('menu')
  const items = [...panel.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(items.map((item) => item.textContent)).toEqual([
    '置顶',
    '重命名',
    '分叉会话',
    '在文件管理器中打开',
    '运行信息',
    '归档会话',
  ])
  expect(items.map((item) => item.querySelector('svg') !== null)).toEqual([
    true,
    true,
    true,
    true,
    true,
    true,
  ])
  expect([...panel.children].filter((item) => item.classList.contains('agh-menu-separator'))).toHaveLength(2)
  expect([...panel.children].map((item) => item.textContent)).toEqual([
    '置顶',
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
  expect(document.activeElement).toBe(items[5])
})

it('dismisses on selection, reports the session action and returns focus to the trigger', async () => {
  const { trigger, select, open, closed } = renderMenu()
  const panel = await open()
  panel.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click()
  await closed()
  expect(select).toHaveBeenCalledWith('pin', 'visible', '名称 visible', trigger)
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
