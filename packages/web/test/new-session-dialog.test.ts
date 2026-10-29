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
    remove: vi.fn(),
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
const typeInto = (element: HTMLInputElement, value: string) => {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
}
const rowNamed = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('.workspace-option-row')].find((row) =>
    row.querySelector('.workspace-option-name')?.textContent?.includes(name),
  )

it('switches on one click, marks the current workspace, searches, removes and takes a typed path', async () => {
  const { controller, actions, button, dialog, input, locale } = setup()
  const row = (name: string, extra: object = {}) => ({
    path: ['', 'Users', 'me', name].join('/'),
    name,
    available: true,
    lastUsedAt: null,
    sessionCount: 0,
    workspaceId: name.padEnd(64, 'a'),
    ...extra,
  })
  const current = row('current')
  const other = row('other', { lastUsedAt: new Date(Date.now() - 86_400_000).toISOString() })
  const busy = row('busy', { sessionCount: 2 })
  const gone = row('gone', { available: false })
  controller.update({
    connected: true,
    pickerReady: true,
    current: current.path,
    workspaces: [current, other, busy, gone],
  })
  controller.show()
  expect(dialog().open).toBe(true)
  const modal = document.querySelector('[role=dialog]')
  // The dialog's accessible name is the title alone; e2e finds it by that exact name.
  expect(document.getElementById(modal?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
    enT('index-shell.pickWorkspaceTitle'),
  )
  // No confirm/cancel footer: a row click selects, ✕ and Escape close.
  expect(document.getElementById('new-session-cancel')).toBeNull()
  expect(rowNamed('current')?.textContent).toContain(enT('index-shell.currentWorkspace'))
  expect(rowNamed('current')?.querySelector('.workspace-option-path')?.textContent).toBe('~/current')
  expect(rowNamed('current')?.querySelector('.workspace-option-remove')).toBeNull()
  expect(rowNamed('other')?.querySelector('.workspace-option-time')?.textContent).toBe('yesterday')
  expect(rowNamed('gone')?.querySelector<HTMLButtonElement>('.workspace-option')?.disabled).toBe(true)
  expect(rowNamed('gone')?.textContent).toContain(enT('index-shell.workspaceGone'))
  rowNamed('other')?.querySelector<HTMLButtonElement>('.workspace-option')?.click()
  expect(actions.select).toHaveBeenCalledWith(other)

  // A folder without sessions is removed at once; one with sessions asks first (they get archived).
  rowNamed('gone')?.querySelector<HTMLButtonElement>('.workspace-option-drop')?.click()
  expect(actions.remove).toHaveBeenLastCalledWith(gone)
  rowNamed('busy')?.querySelector<HTMLButtonElement>('.workspace-option-remove')?.click()
  expect(actions.remove).toHaveBeenCalledOnce()
  const confirm = await vi.waitFor(() => {
    const group = rowNamed('busy')?.querySelector('.workspace-option-confirm')
    expect(group?.textContent).toContain('2')
    return group
  })
  ;[...(confirm?.querySelectorAll('button') ?? [])].at(-1)?.click()
  expect(actions.remove).toHaveBeenLastCalledWith(busy)

  typeInto(document.getElementById('workspace-search') as HTMLInputElement, 'OTH')
  expect([...document.querySelectorAll('.workspace-option-name')].map((node) => node.textContent)).toEqual([
    'other',
  ])
  typeInto(document.getElementById('workspace-search') as HTMLInputElement, 'nothing')
  expect(document.getElementById('workspace-option-items')?.textContent).toBe(
    enT('index-shell.noWorkspaceMatch'),
  )

  button('workspace-pick').click()
  expect(actions.pick).toHaveBeenCalledOnce()
  expect(button('new-session-create').disabled).toBe(true)
  typeInto(input(), '/workspace/new')
  expect(controller.path).toBe('/workspace/new')
  expect(button('new-session-create').disabled).toBe(false)
  document
    .getElementById('new-session-form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  expect(actions.submit).toHaveBeenCalledOnce()
  controller.update({ error: 'Directory unavailable' })
  expect(input().getAttribute('aria-invalid')).toBe('true')
  expect(document.getElementById('new-session-error')?.textContent).toBe('Directory unavailable')
  locale('zh-CN')
  expect(document.getElementById('new-session-title')?.textContent).toBe(
    zhT('index-shell.pickWorkspaceTitle'),
  )
  expect(button('new-session-create').textContent).toBe(zhT('app.newSession.useWorkspace'))
  expect(input().value).toBe('/workspace/new')
})

it.each([
  ['first use', true, true, false],
  ['a remote daemon', false, false, true],
])('offers the right way to add a folder on %s', (_name, ready, picker, note) => {
  const { controller, button } = setup()
  controller.update({ connected: true, pickerReady: ready, workspaces: [] })
  controller.show()
  expect(document.querySelector('.workspace-empty')).not.toBeNull()
  expect(document.getElementById('workspace-search')).toBeNull()
  expect(Boolean(button('workspace-pick'))).toBe(picker)
  expect(document.querySelector('.workspace-picker-note') !== null).toBe(note)
  expect(document.getElementById('new-session-cwd')).not.toBeNull()
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
  document.querySelector<HTMLButtonElement>('.ant-modal-close')?.click()
  expect(dialog().open).toBe(false)
})
