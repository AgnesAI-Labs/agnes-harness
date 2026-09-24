/** @vitest-environment happy-dom */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const packageDirectory = process.cwd().endsWith('/packages/web')
  ? process.cwd()
  : resolve(process.cwd(), 'packages/web')
const publicDirectory = resolve(packageDirectory, 'public')

afterEach(() => {
  document.head.replaceChildren()
  document.body.replaceChildren()
})

/** Rule body by selector, so the assertions stay about declarations instead of line numbers. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  expect(start, `missing rule ${selector}`).toBeGreaterThan(-1)
  return css.slice(start, css.indexOf('}', start))
}

it('both hosts share one scroll model: documents fixed, list scrolls, detail scrolls only in the middle', async () => {
  const css = await readFile(resolve(publicDirectory, 'style.css'), 'utf8')

  // The standalone host must declare its own model instead of inheriting `overflow: hidden` from the
  // workbench shell (style.css top). That inheritance, plus nothing to scroll, is exactly what made
  // both admin documents unscrollable.
  expect(ruleBody(css, 'body.admin-page')).toContain('overflow: hidden')
  expect(ruleBody(css, 'body.admin-page')).toContain('flex-direction: column')
  expect(ruleBody(css, '.admin-pane-body')).toContain('overflow: hidden')
  expect(ruleBody(css, '.plugin-layout')).toContain('display: flex')
  expect(ruleBody(css, '.plugin-layout')).toContain('flex-direction: column')
  expect(ruleBody(css, '.plugin-layout')).toContain('min-height: 0')
  expect(ruleBody(css, '.plugin-list')).toContain('flex: 1')
  expect(ruleBody(css, '.plugin-list')).toContain('min-height: 0')
  expect(ruleBody(css, '.plugin-list')).toContain('overflow-y: auto')
  expect(ruleBody(css, '.admin-detail-scroll')).toContain('overflow-y: auto')
  // Actions live outside the scrolling middle, so a long description or a long integrity value can
  // never push 信任 / 拒绝 / 启用 out of reach.
  expect(ruleBody(css, '.admin-detail-actions')).toContain('flex: 0 0 auto')
  // The detail column must not reintroduce its own viewport-based height.
  // 选择器带 `[open]`：`display: flex` 必须限定在打开态，否则会覆盖浏览器对关闭态 dialog 的
  // `display: none`，空盒子会在页面正中渲染成一条灰线（见 style.css 的 dialog:not([open]) 兜底）。
  expect(ruleBody(css, '.plugin-detail[open]')).not.toContain('100dvh')
})

it('keeps settings DSH and pane mounts inside the content grid column', async () => {
  const css = await readFile(resolve(publicDirectory, 'style.css'), 'utf8')
  const content = ruleBody(css, '#settings-content-slots')
  expect(content).toContain('grid-column: 2')
  expect(content).toContain('grid-row: 1')
  expect(content).toContain('min-height: 0')
  expect(content).toContain('display: flex')
  expect(css).toContain('#settings-dsh-shell-slots > [id^="settings-dsh-slot-"]')
})

it('the iframe-era embedded overrides are gone', async () => {
  const css = await readFile(resolve(publicDirectory, 'style.css'), 'utf8')
  // These only existed because the panes were cross-document iframes. Their absence is the guard
  // against reintroducing a second layout path that only fires in the embedded host.
  expect(css).not.toContain('admin-embedded')
  expect(css).not.toContain('plugin-settings-loading')
  expect(css).not.toContain('plugin-settings-pane')
  expect(css).not.toContain('plugin-settings-frame')
})

it('the resource toolbar keeps its actions with the tabs', async () => {
  const html = await readFile(resolve(publicDirectory, 'resources.html'), 'utf8')
  document.documentElement.innerHTML = html
    .replace(/<link\b[^>]*>/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
  const toolbar = document.querySelector('.resource-toolbar') as HTMLElement
  expect(toolbar.contains(document.getElementById('mcp-create'))).toBe(true)
  expect(toolbar.contains(document.getElementById('skill-refresh'))).toBe(true)
})

it('list rows use fixed tracks so the status column aligns across rows', async () => {
  const css = await readFile(resolve(publicDirectory, 'style.css'), 'utf8')
  // Each row is its own grid, so an `auto` track is sized per row and the status column drifts.
  expect(ruleBody(css, '.plugin-row')).not.toMatch(/grid-template-columns:[^;]*\bauto\b/)
  expect(ruleBody(css, '.plugin-row')).toContain('grid-template-columns: minmax(0, 1fr) 8.5rem 2.375rem')
  expect(ruleBody(css, '.resource-row')).toContain('grid-template-columns: minmax(0, 1fr) 8.5rem 2.375rem')
})

it('the toolbar search field owns its type scale and a visible border in every state', async () => {
  const css = await readFile(resolve(publicDirectory, 'style.css'), 'utf8')
  const field = ruleBody(css, '.plugin-search-field input')
  // Without an explicit size it fell back to the 16px body value and looked oversized next to the
  // 13px controls in the same toolbar.
  expect(field).toContain('font-size: var(--font-size-sm)')
  expect(field).toContain('border-color: var(--agnes-input-border)')
  expect(field).not.toContain('transparent')
})

it('keeps the Agnes mark while hiding the wordmark in the collapsed sidebar', async () => {
  const css = await readFile(resolve(publicDirectory, 'style.css'), 'utf8')
  const wordmark = css.match(/body\.sidebar-collapsed \.brand-wordmark-text\s*\{[^}]*\}/)?.[0]
  expect(wordmark).toContain('display: none')
})

it('gives plugin and resource empty states the shared hero layout', async () => {
  const css = await readFile(resolve(publicDirectory, 'style.css'), 'utf8')
  const empty = ruleBody(css, '.admin-empty-state')
  expect(empty).toContain('display: grid')
  expect(empty).toContain('place-content: center')
  expect(empty).toContain('text-align: center')
})
