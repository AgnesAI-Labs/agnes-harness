/** @vitest-environment happy-dom */
import type { WorkspaceEntry } from '@agnes/protocol'
import { mountRegion, renderRegion } from '@agnes/web-ui'
import { getByRole } from '@testing-library/dom'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceMenu } from '../src/workspace-menu.js'
import { enT, zhT } from './helpers/locale.js'

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})
const workspace: WorkspaceEntry = {
  path: '/workspace/project',
  name: 'Project',
  workspaceId: 'a'.repeat(64),
  revision: 1,
  available: true,
  sessionCount: 35,
  lastUsedAt: null,
}
function render(runningCount = 0, t = zhT, platform = 'darwin') {
  const host = document.createElement('div')
  document.body.append(host)
  const action = vi
    .fn<(kind: 'reveal' | 'remove', workspace: WorkspaceEntry) => Promise<void>>()
    .mockResolvedValue()
  const newSession = vi.fn()
  const view = (disabled: boolean) => (
    <WorkspaceMenu
      workspace={workspace}
      name="Project"
      t={t}
      platform={platform}
      disabled={disabled}
      newDisabled={disabled}
      runningCount={runningCount}
      newSession={newSession}
      action={action}
    />
  )
  dispose = mountRegion(host, view(false))
  const getTrigger = () => {
    const trigger = host.querySelector<HTMLButtonElement>('.workspace-menu-trigger')
    if (!trigger) throw new Error('missing workspace menu trigger')
    return trigger
  }
  const open = async () => {
    const trigger = getTrigger()
    flushSync(() => trigger.click())
    await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'))
    await vi.waitFor(() => expect(document.querySelectorAll('[role=menuitem]')).toHaveLength(3))
    return [...document.querySelectorAll<HTMLElement>('[role=menuitem]')]
  }
  const confirm = async () => {
    const items = await open()
    flushSync(() => items[2]?.click())
    await vi.waitFor(() => expect(document.querySelector('[role=dialog]')).not.toBeNull())
    const dialog = document.querySelector<HTMLElement>('[role=dialog]')
    if (!dialog) throw new Error('missing remove dialog')
    return dialog
  }
  return {
    action,
    newSession,
    get trigger() {
      return getTrigger()
    },
    open,
    confirm,
    host,
    setDisabled(disabled: boolean) {
      renderRegion(host, view(disabled))
    },
  }
}

it.each(['win32', 'darwin'])(
  'closes a disabled project menu and allows reopening on %s',
  async (platform) => {
    const menu = render(0, zhT, platform)
    const oldItems = await menu.open()
    menu.setDisabled(true)
    expect(menu.trigger.disabled).toBe(true)
    expect(document.querySelector('[role=menu]')).toBeNull()
    for (const item of oldItems) item.click()
    menu.trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(menu.action).not.toHaveBeenCalled()
    expect(menu.newSession).not.toHaveBeenCalled()
    expect(document.querySelector('[role=dialog]')).toBeNull()
    menu.setDisabled(false)
    const reopened = await menu.open()
    flushSync(() => reopened[1]?.click())
    await vi.waitFor(() => expect(menu.action).toHaveBeenCalledWith('reveal', workspace))
  },
)

it('offers a compose shortcut and ordered project actions with a separated danger action', async () => {
  const { host, open, newSession, action } = render()
  host.querySelector<HTMLButtonElement>('.workspace-new-session')?.click()
  expect(newSession).toHaveBeenCalledOnce()
  expect(host.querySelector('.workspace-new-session svg')?.getAttribute('width')).toBe('16')
  const items = await open()
  expect(items.map((item) => item.textContent)).toEqual(['新建会话', '在访达中打开', '移除项目…'])
  expect(document.querySelectorAll('.agh-menu-separator')).toHaveLength(1)
  expect(items[2]?.getAttribute('data-danger')).toBe('true')
  expect(items.every((item) => item.closest('.agh-menu-popup--neutral'))).toBe(true)
  flushSync(() => items[0]?.click())
  expect(newSession).toHaveBeenCalledTimes(2)
  await vi.waitFor(() =>
    expect(host.querySelector('.workspace-menu-trigger')?.getAttribute('aria-expanded')).toBe('false'),
  )
  const reopened = await open()
  flushSync(() => reopened[1]?.click())
  await vi.waitFor(() => expect(action).toHaveBeenCalledWith('reveal', workspace))
})

it.each([zhT, enT])(
  'explains file preservation, archive count, re-add and path before removal',
  async (t) => {
    const { confirm, action, trigger } = render(0, t)
    let dialog = await confirm()
    expect(dialog.textContent).toContain(t('workspace.remove.title', { name: 'Project' }))
    expect(dialog.textContent).toContain(t('workspace.remove.description', { count: 35 }))
    expect(dialog.querySelector('.workspace-remove-path code')?.textContent).toBe(workspace.path)
    const cancel = getByRole(dialog, 'button', { name: t('workspace.remove.cancel') })
    flushSync(() => cancel.click())
    expect(action).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(document.querySelector('[role=dialog]')).toBeNull())
    expect(document.activeElement).toBe(trigger)
    dialog = await confirm()
    flushSync(() => getByRole(dialog, 'button', { name: t('workspace.remove.confirm') }).click())
    await vi.waitFor(() => expect(action).toHaveBeenCalledWith('remove', workspace))
    await vi.waitFor(() => expect(document.querySelector('[role=dialog]')).toBeNull())
  },
)

it('blocks removal while the sidebar reports running sessions', async () => {
  const { confirm, action } = render(1)
  const dialog = await confirm()
  expect(dialog.textContent).toContain('有 1 个会话正在运行，请先停止')
  const remove = getByRole(dialog, 'button', { name: /移除项目$/ }) as HTMLButtonElement
  expect(remove.disabled).toBe(true)
  remove.click()
  expect(action).not.toHaveBeenCalled()
})

it('keeps the dialog open and disables removal when the server discovers another running session', async () => {
  const { confirm, action } = render()
  action.mockRejectedValueOnce(
    Object.assign(new Error('Stop running sessions first'), {
      data: { code: 'WORKSPACE_RUNNING', runningSessionCount: 2 },
    }),
  )
  const dialog = await confirm()
  flushSync(() => getByRole(dialog, 'button', { name: /移除项目$/ }).click())
  await vi.waitFor(() => expect(dialog.textContent).toContain('有 2 个会话正在运行，请先停止'))
  expect((getByRole(dialog, 'button', { name: /移除项目$/ }) as HTMLButtonElement).disabled).toBe(true)
})
