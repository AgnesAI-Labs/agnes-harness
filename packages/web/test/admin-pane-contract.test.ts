/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

/**
 * The admin surfaces live in two hosts: the full pages (`admin.html` / `resources.html`) and the
 * settings panes inside `index.html`. Both are static markup, so nothing but this test prevents the
 * two copies from drifting apart — and a drifted id means a silent `missing element` crash at mount.
 */
const publicDir = join(process.cwd(), 'packages', 'web', 'public')
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
  document.documentElement.innerHTML = stripAssets(html)
  const found = new Set(selfIds)
  for (const id of roots) {
    const root = document.getElementById(id)
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
  // #admin-confirm is the shared confirmation dialog (@agnes/web-admin-frame); it is host-level, so it
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
  expect(pane.querySelector('.config-heading')?.textContent).toContain('在聊天中说“帮我接入这个 MCP”')
  expect(pane.querySelector<HTMLButtonElement>('#mcp-create')?.hidden).toBe(true)
  await runtime.dispose()
  resetWebDom()
})

it('the shared confirmation dialog exists in every host', () => {
  for (const file of ['index.html', 'admin.html', 'resources.html'])
    for (const id of [
      'admin-confirm',
      'admin-confirm-title',
      'admin-confirm-description',
      'admin-confirm-preview',
      'admin-confirm-cancel',
      'admin-confirm-action',
    ])
      expect(idsIn(read(file)), `${file} is missing #${id}`).toContain(id)
})

it('the Skill / MCP pane confirms through the shared dialog, not window.confirm', async () => {
  const source = readFileSync(
    join(process.cwd(), 'packages', 'resource-control-web', 'src', 'admin.ts'),
    'utf8',
  )
  expect(source).not.toContain('window.confirm')
  expect(source).toContain('createConfirmController')
})

it('keeps embedded resource Tab ownership in the workbench host', () => {
  const source = readFileSync(
    join(process.cwd(), 'packages', 'resource-control-web', 'src', 'admin.ts'),
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
  const html = read('index.html')
  expect(html).toContain('<div class="session-tabs" role="tablist"')
  expect(html).toContain('id="view-chat" role="tab"')
  expect(html).toContain('id="view-trace" role="tab"')
  expect(html).toContain('aria-controls="conversation-shell"')
  expect(html).toContain('aria-controls="trace-panel"')
  expect(document.querySelector('#connection[role="status"][aria-live="polite"]')).not.toBeNull()
  await runtime.dispose()
  resetWebDom()
})
