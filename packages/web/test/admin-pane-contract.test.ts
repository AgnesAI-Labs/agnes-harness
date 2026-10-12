/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { appNotice } from '../src/app-notices.js'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

/**
 * The admin surfaces live in two hosts: the full pages (`admin.html` / `resources.html`) and the
 * settings panes inside `index.html`. Both are static markup, so nothing but this test prevents the
 * two copies from drifting apart — and a drifted id means a silent `missing element` crash at mount.
 */
const publicDir = join(resolve(import.meta.dirname, '../../..'), 'packages', 'web', 'public')
const read = (name: string): string => readFileSync(join(publicDir, name), 'utf8')

/** Ids the full page carries around the surface (shell and <body>), not part of the surface itself. */
const STANDALONE_ONLY = new Set([
  'return-workbench',
  'plugin-content',
  'plugin-admin-page',
  'resource-return',
  'resource-content',
  'resource-admin-page',
])

const idsIn = (markup: string): string[] =>
  [...markup.matchAll(/\bid="([^"]+)"/g)]
    .map((m) => m[1] as string)
    .filter((id) => !id.startsWith('settings-dsh-slot-'))

/** happy-dom would try to fetch these; the contract under test is structural, not visual. */
const stripAssets = (html: string): string =>
  html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '')

/** Ids inside each root, plus the roots named in `selfIds`. The pane section's own id is host-specific. */
function embeddedIds(html: string, roots: readonly string[], selfIds: readonly string[] = []): string[] {
  const parsed = new DOMParser().parseFromString(stripAssets(html), 'text/html')
  const found = new Set(selfIds)
  for (const id of roots) {
    const root = parsed.getElementById(id)
    expect(root, `#${id} is missing from the embedded host`).not.toBeNull()
    for (const node of root?.querySelectorAll('[id]') ?? [])
      if (!node.id.startsWith('settings-dsh-slot-')) found.add(node.id)
  }
  return [...found].sort()
}

it('embedded plugin pane and admin.html carry the same surface ids', async () => {
  const standalone = idsIn(read('admin.html'))
    .filter((id) => !STANDALONE_ONLY.has(id))
    .sort()
  const runtime = await mountRenderedIndex()
  const embedded = embeddedIds(
    document.documentElement.outerHTML,
    ['plugin-settings-pane', 'source-dialog', 'plugin-confirm', 'admin-confirm', 'plugin-detail'],
    ['source-dialog', 'plugin-confirm', 'admin-confirm', 'plugin-detail'],
  )
  await runtime.dispose()
  resetWebDom()
  expect(embedded).toEqual(standalone)
})

it('embedded resource pane and resources.html carry the same surface ids', async () => {
  const standalone = idsIn(read('resources.html'))
    .filter((id) => !STANDALONE_ONLY.has(id))
    .sort()
  // #admin-confirm is the shared confirmation dialog (@agnes/web-ui); it is host-level, so it
  // is compared in both surfaces rather than belonging to one of them.
  // #resource-detail is a body-level modal in both hosts, and the Skills / MCP tabs sit in the
  // standalone page's toolbar but in the workbench's settings rail — same ids, different parent.
  const runtime = await mountRenderedIndex()
  const embedded = embeddedIds(
    document.documentElement.outerHTML,
    ['resource-settings-pane', 'mcp-dialog', 'admin-confirm', 'resource-detail'],
    ['mcp-dialog', 'admin-confirm', 'resource-detail', 'skills-tab', 'mcp-tab'],
  )
  await runtime.dispose()
  resetWebDom()
  expect(embedded).toEqual(standalone)
})

it('guides MCP setup through chat and hides the manual creation control', async () => {
  const runtime = await mountRenderedIndex()
  const pane = document.getElementById('resource-settings-pane') as HTMLElement
  expect(pane.querySelector('.config-heading')?.textContent).toContain('ask Agnes to connect it')
  expect(pane.querySelector<HTMLButtonElement>('#mcp-create')?.hidden).toBe(true)
  await runtime.dispose()
  resetWebDom()
})

it('the shared confirmation dialog exists in every host', async () => {
  const required = [
    'admin-confirm',
    'admin-confirm-title',
    'admin-confirm-description',
    'admin-confirm-preview',
    'admin-confirm-cancel',
    'admin-confirm-action',
  ]
  for (const file of ['admin.html', 'resources.html'])
    for (const id of required) expect(idsIn(read(file)), `${file} is missing #${id}`).toContain(id)
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

it('keeps embedded resource Tab ownership in the workbench host', () => {
  const source = readFileSync(
    join(resolve(import.meta.dirname, '../../..'), 'packages', 'resource-control-web', 'src', 'admin.tsx'),
    'utf8',
  )
  expect(source).toContain('embedded?: boolean')
  expect(source).toContain('if (!options.embedded)')
  expect(source).toContain('sync(scope')
})

it('no admin form is nested inside the settings form', async () => {
  const runtime = await mountRenderedIndex()
  const settingsForm = document.getElementById('config-form')
  expect(settingsForm).not.toBeNull()
  // A nested <form> is dropped by the parser and its </form> closes the outer form early, which would
  // silently move the settings rail out of the grid container. Assert both the symptom and the cause.
  expect(settingsForm?.querySelectorAll('form').length).toBe(0)
  for (const id of [
    'model-settings-pane',
    'plugin-settings-pane',
    'resource-settings-pane',
    'computer-use-settings-pane',
    'appearance-settings-pane',
  ])
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
