/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { mountNewSessionDialog } from '../src/new-session-dialog.js'
import { enT, zhT } from './helpers/locale.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose()
  document.body.replaceChildren()
})
function setup() {
  const host = document.createElement('div')
  const trigger = document.createElement('button')
  document.body.append(host, trigger)
  let locale = 'en'
  const actions = {
    translate: (key: string, vars?: Record<string, string | number>) =>
      (locale === 'en' ? enT : zhT)(key, vars),
    submit: vi.fn(),
    pick: vi.fn(),
    select: vi.fn(),
    restoreFocus: () => trigger.focus(),
  }
  const controller = mountNewSessionDialog(host, actions)
  cleanups.push(controller.dispose)
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement
  const dialog = () => document.getElementById('new-session') as HTMLDialogElement
  const input = () => document.getElementById('new-session-cwd') as HTMLInputElement
  const key = (name: string) =>
    document
      .querySelector('[role=dialog]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
  return {
    controller,
    actions,
    button,
    dialog,
    input,
    trigger,
    key,
    locale: (value: string) => {
      locale = value
      window.dispatchEvent(new Event('agnes:locale-changed'))
    },
  }
}

it('preserves picker selectors, workspace availability, manual entry and localized copy', async () => {
  const { controller, actions, button, dialog, input, locale } = setup()
  const workspace = {
    path: '/workspace',
    name: 'Project',
    available: true,
    lastUsedAt: null,
    sessionCount: 1,
  }
  controller.update({
    connected: true,
    pickerReady: true,
    workspaces: [workspace, { ...workspace, path: '/missing', available: false }],
  })
  controller.show()
  expect(dialog().open).toBe(true)
  const modal = document.querySelector('[role=dialog]')
  const title = document.getElementById(modal?.getAttribute('aria-labelledby') ?? '')
  const accessibleText = (node: Node): string => {
    if (node instanceof HTMLElement && node.getAttribute('aria-hidden') === 'true') return ''
    return node.nodeType === Node.TEXT_NODE
      ? (node.textContent ?? '')
      : [...node.childNodes].map(accessibleText).join('')
  }
  expect(title && accessibleText(title)).toBe(enT('index-shell.pickWorkspaceTitle'))
  expect(document.querySelector('[data-testid=workspace-manual-toggle]')?.textContent).toBe(
    enT('index-shell.manualPath'),
  )
  expect(document.querySelector<HTMLButtonElement>('[data-available=false]')?.disabled).toBe(true)
  document.querySelector<HTMLButtonElement>('[data-available=true]')?.click()
  expect(actions.select).toHaveBeenCalledWith(workspace)
  button('workspace-pick').click()
  expect(actions.pick).toHaveBeenCalledOnce()
  expect(button('new-session-create').disabled).toBe(true)
  input().value = '/workspace/new'
  input().dispatchEvent(new Event('input', { bubbles: true }))
  expect(controller.path).toBe('/workspace/new')
  expect(button('new-session-create').disabled).toBe(false)
  document
    .getElementById('new-session-form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  expect(actions.submit).toHaveBeenCalledOnce()
  controller.update({ error: 'Directory unavailable', pickerReady: false })
  expect(button('workspace-pick').hidden).toBe(true)
  expect((document.getElementById('workspace-manual') as HTMLElement).dataset.open).toBe('true')
  expect(document.getElementById('new-session-error')?.textContent).toBe('Directory unavailable')
  locale('zh-CN')
  expect(document.getElementById('new-session-title')?.textContent).toBe(
    zhT('index-shell.pickWorkspaceTitle'),
  )
  expect(input().value).toBe('/workspace/new')
})

it('blocks dismissal during native picking and registration, then restores focus on Escape', async () => {
  const { controller, button, dialog, input, trigger, key } = setup()
  const nativeEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  window.dispatchEvent(nativeEscape)
  expect(nativeEscape.defaultPrevented).toBe(false)
  controller.update({ connected: true, pickerReady: false, path: '/workspace' })
  controller.show()
  controller.update({ pickerBusy: true })
  expect(input().disabled).toBe(true)
  expect(button('new-session-cancel').disabled).toBe(true)
  key('Escape')
  expect(dialog().open).toBe(true)
  controller.update({ pickerBusy: false, creating: true })
  expect(button('new-session-create').disabled).toBe(true)
  key('Escape')
  expect(dialog().open).toBe(true)
  controller.update({ creating: false })
  key('Escape')
  await vi.waitFor(() => expect(dialog().open).toBe(false))
  expect(document.activeElement).toBe(trigger)
  controller.show()
  button('new-session-cancel').click()
  expect(dialog().open).toBe(false)
})
