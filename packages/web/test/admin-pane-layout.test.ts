/** @vitest-environment happy-dom */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readWebStyleSource } from '../../../tools/web-style-source.mjs'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

const packageDirectory = process.cwd().endsWith('/packages/web')
  ? process.cwd()
  : resolve(process.cwd(), 'packages/web')
const publicDirectory = resolve(packageDirectory, 'public')

afterEach(() => {
  resetWebDom()
})

/** Rule body by selector, so the assertions stay about declarations instead of line numbers. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^\\s*${escaped} \\{([^}]*)\\}`, 'm').exec(css)
  expect(match, `missing rule ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

it('the admin panes keep one scroll model: document fixed, list scrolls, detail scrolls only in the middle', async () => {
  const css = readWebStyleSource(resolve(publicDirectory, 'style.css'))

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
  expect(ruleBody(css, '.plugin-detail:not(.agh-drawer)[open]')).not.toContain('100dvh')
})

it('keeps settings DSH and pane mounts inside the content grid column', async () => {
  const css = readWebStyleSource(resolve(publicDirectory, 'style.css'))
  const content = ruleBody(css, '#settings-content-slots')
  expect(content).toContain('grid-column: 2')
  expect(content).toContain('grid-row: 1')
  expect(content).toContain('min-height: 0')
  expect(content).toContain('display: flex')
  expect(css).toContain('#settings-dsh-shell-slots > [id^="settings-dsh-slot-"]')
})

/** The selectors of one rule, split at top-level commas only. */
function selectorList(rule: string): string[] {
  const selectors = ['']
  let depth = 0
  for (const character of rule) {
    if (character === '(') depth++
    if (character === ')') depth--
    if (character === ',' && depth === 0) selectors.push('')
    else selectors[selectors.length - 1] += character
  }
  return selectors.map((selector) => selector.trim())
}

it('a subpage of a tabbed settings page keeps its breadcrumb line', async () => {
  const css = readWebStyleSource(resolve(publicDirectory, 'style.css'))
  // The tab strip names a tabbed page, so its own heading folds away; a subpage's header is its only
  // way back (「Models & accounts › Add account」) and must never be folded with it.
  const folded = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^}]*\}/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(
      (selector) =>
        selector.includes('settings-section-tabs') && selector.includes('.agnes-settings-page-heading'),
    )
  expect(folded.length).toBeGreaterThanOrEqual(3)
  for (const selector of folded.flatMap(selectorList))
    expect(selector.replace(/\s+/g, ' ')).toContain(
      '.agnes-settings-page-heading:not(.agnes-settings-subpage-header > *',
    )
})

it('list rows use fixed tracks so the Switch column aligns across rows', async () => {
  const css = readWebStyleSource(resolve(publicDirectory, 'style.css'))
  // Each row is its own grid, so an `auto` track is sized per row and the Switch column drifts.
  // 状态灯移除后每行只剩标题和 Switch；资源页也必须收成两段，否则空出来的第三段会把 Switch 挤离右边缘。
  expect(ruleBody(css, '.plugin-row:not(.agh-list-row)')).not.toMatch(/grid-template-columns:[^;]*\bauto\b/)
  expect(ruleBody(css, '.plugin-row:not(.agh-list-row)')).toContain(
    'grid-template-columns: minmax(0, 1fr) 2.375rem',
  )
  expect(ruleBody(css, '.resource-row')).toContain('grid-template-columns: minmax(0, 1fr) 2.375rem')
  const primitives = await readFile(resolve(packageDirectory, '../web-ui/src/components.css'), 'utf8')
  expect(ruleBody(primitives, '.agh-list-row')).not.toMatch(/grid-template-columns:[^;]*\bauto\b/)
  expect(ruleBody(primitives, '.agh-list-row-actions')).toContain('flex: 0 0 auto')
})

it('the toolbar search field owns its type scale and a visible border in every state', async () => {
  const css = readWebStyleSource(resolve(publicDirectory, 'style.css'))
  const field = ruleBody(css, '.plugin-search-field input')
  // Without an explicit size it fell back to the 16px body value and looked oversized next to the
  // 13px controls in the same toolbar.
  expect(field).toContain('font-size: var(--font-size-sm)')
  expect(field).toContain('border-color: var(--agnes-input-border)')
  expect(field).not.toContain('transparent')
})

it('keeps the Agnes mark while hiding the wordmark in the collapsed sidebar', async () => {
  const css = readWebStyleSource(resolve(publicDirectory, 'style.css'))
  const wordmark = css.match(/body\.sidebar-collapsed \.brand-wordmark-text\s*\{[^}]*\}/)?.[0]
  expect(wordmark).toContain('display: none')
})

it('gives plugin and resource empty states the shared hero layout', async () => {
  const css = readWebStyleSource(resolve(publicDirectory, 'style.css'))
  const empty = ruleBody(css, '.admin-empty-state')
  expect(empty).toContain('display: grid')
  expect(empty).toContain('place-content: center')
  expect(empty).toContain('text-align: center')
})
