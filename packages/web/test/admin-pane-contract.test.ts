/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { appNotice } from '../src/app-notices.js'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

/**
 * The admin controllers bind by id to the panes and dialogs the workbench renders from React. Their
 * own tests (resource-admin-dom, plugin-source-dialog, plugin-admin-page) mount on this same
 * rendered workbench, so a drifted id fails there at mount rather than passing against a copy.
 */
const packagesDir = join(resolve(import.meta.dirname, '../../..'), 'packages')
const read = (name: string): string => readFileSync(join(packagesDir, 'web', 'public', name), 'utf8')

it('the shared confirmation dialog is rendered by the workbench', async () => {
  const required = [
    'admin-confirm',
    'admin-confirm-title',
    'admin-confirm-description',
    'admin-confirm-preview',
    'admin-confirm-cancel',
    'admin-confirm-action',
  ]
  const runtime = await mountRenderedIndex()
  for (const id of required) expect(document.getElementById(id)).not.toBeNull()
  await runtime.dispose()
  resetWebDom()
})

it('the Skill / MCP pane confirms through the shared dialog, not window.confirm', async () => {
  const source = readFileSync(
    join(resolve(import.meta.dirname, '../../..'), 'packages', 'resource-control-web', 'src', 'admin.tsx'),
    'utf8',
  )
  expect(source).not.toContain('window.confirm')
  expect(source).toContain('createConfirmController')
})

it('no admin form is nested inside the settings form', async () => {
  const runtime = await mountRenderedIndex()
  const settingsForm = document.getElementById('config-form')
  expect(settingsForm).not.toBeNull()
  // A nested <form> is dropped by the parser and its </form> closes the outer form early, which would
  // silently move the settings rail out of the grid container. Assert both the symptom and the cause.
  expect(settingsForm?.querySelectorAll('form').length).toBe(0)
  for (const id of ['model-settings-pane', 'appearance-settings-pane', 'settings-sections-pane'])
    expect(settingsForm?.contains(document.getElementById(id)), `#${id} left #config-form`).toBe(true)
  expect(settingsForm?.querySelector('.settings-rail')).not.toBeNull()
  const settingsContent = document.getElementById('settings-content-slots')
  expect(settingsContent).not.toBeNull()
  expect(document.getElementById('settings-dsh-shell-slots')?.parentElement).toBe(settingsContent)
  expect(document.getElementById('settings-pane-slots')?.parentElement).toBe(settingsContent)
  expect(settingsForm?.querySelector('#settings-dsh-shell-slots')).not.toBeNull()
  await runtime.dispose()
  resetWebDom()
})

it.each([
  ['admin.html', '/admin-standalone.js'],
  ['resources.html', '/resources-standalone.js'],
])('%s is an alias of the workbench with no shell of its own', (page, entry) => {
  const html = read(page)
  expect(html).toContain(`<script type="module" src="${entry}"></script>`)
  expect(html).toMatch(/<body data-agnes-region="app"><\/body>/)
  expect(html).not.toContain('data-i18n')
  expect(html.match(/<script type="importmap">[\s\S]*?<\/script>/)?.[0]).toBe(
    read('index.html').match(/<script type="importmap">[\s\S]*?<\/script>/)?.[0],
  )
})

it('the settings region reports its active pane and routes section requests through its own form', async () => {
  const runtime = await mountRenderedIndex()
  const settings = runtime.settings
  expect(settings?.active()).toBe('model')
  settings?.open('appearance')
  expect(settings?.active()).toBe('appearance')
  expect(document.getElementById('appearance-settings-pane')?.hidden).toBe(false)
  const routed: unknown[] = []
  settings?.form()?.addEventListener('agnes:settings-route', (event) => {
    routed.push((event as CustomEvent<unknown>).detail)
  })
  settings?.route('security')
  expect(routed).toEqual(['security'])
  await runtime.dispose()
  resetWebDom()
})

it('the settings dialog no longer frames the admin pages', () => {
  const html = read('index.html')
  for (const gone of [
    'plugin-settings-frame',
    'resource-settings-frame',
    'admin/plugins?embedded=1',
    'admin/resources?embedded=1',
  ])
    expect(html, `${gone} still present`).not.toContain(gone)
})

it('exposes native tab and live status semantics for the rendered workbench', async () => {
  const runtime = await mountRenderedIndex()
  expect(document.querySelector('.session-tabs[role="tablist"]')).not.toBeNull()
  expect(document.querySelector('#view-chat[role="tab"][aria-controls="conversation-shell"]')).toBeInstanceOf(
    HTMLButtonElement,
  )
  expect(document.querySelector('#view-trace[role="tab"][aria-controls="trace-panel"]')).toBeInstanceOf(
    HTMLButtonElement,
  )
  expect(document.querySelector('#connection[role="status"][aria-live="polite"]')).not.toBeNull()
  const chat = document.getElementById('view-chat')
  const trace = document.getElementById('view-trace') as HTMLButtonElement
  const input = document.getElementById('prompt') as HTMLTextAreaElement
  trace.click()
  runtime.composer?.setDraft('keep this draft')
  trace.focus()
  runtime.locale.setLocale('zh-CN')
  document.documentElement.lang = 'zh-CN'
  await vi.waitFor(() => expect(document.querySelector('.skip-link')?.textContent).toBe('跳至主要内容'))
  expect(document.getElementById('view-chat')).toBe(chat)
  expect(document.getElementById('view-trace')).toBe(trace)
  expect(trace.getAttribute('aria-selected')).toBe('true')
  expect(document.getElementById('prompt')).toBe(input)
  expect(input.value).toBe('keep this draft')
  expect(document.activeElement).toBe(trace)
  expect(document.querySelector('[data-i18n], [data-i18n-aria], [data-i18n-placeholder]')).toBeNull()

  await runtime.dispose()
  resetWebDom()
})

it('updates recovery notices without replacing focused controls and refuses disabled actions', async () => {
  const runtime = await mountRenderedIndex()
  const retryAction = vi.fn()
  const createAction = vi.fn()
  const recovery = {
    message: 'unavailable session',
    error: '',
    disabled: false,
    retry: retryAction,
    create: createAction,
  }
  appNotice.recover(recovery)
  await vi.waitFor(() => expect(document.querySelector('[data-recovery-action="retry"]')).not.toBeNull())
  const retry = document.querySelector<HTMLButtonElement>(
    '[data-recovery-action="retry"]',
  ) as HTMLButtonElement
  retry.focus()
  appNotice.recover({ ...recovery, error: 'read failed' })
  await vi.waitFor(() =>
    expect(document.querySelector('[data-recovery-error]')?.textContent).toContain('read failed'),
  )
  expect(document.querySelector('[data-recovery-action="retry"]')).toBe(retry)
  expect(document.activeElement).toBe(retry)
  retry.click()
  expect(retryAction).toHaveBeenCalledOnce()
  appNotice.disableRecovery(true)
  await vi.waitFor(() => expect(retry.disabled).toBe(true))
  retry.click()
  expect(retryAction).toHaveBeenCalledOnce()
  expect(document.querySelector('#notice[role="alert"]')).not.toBeNull()
  appNotice.setText('')
  appNotice.setKind('')
  await runtime.dispose()
  resetWebDom()
})
