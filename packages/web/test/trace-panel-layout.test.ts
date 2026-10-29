import { readWebStyleSource } from '../../../tools/web-style-source.mjs'
/** @vitest-environment happy-dom */

import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

const css = readWebStyleSource(resolve(__dirname, '../public/style.css'))
const flatCss = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ')

function declarations(selector: string): string {
  const pattern = selector.replace(/\s+/g, ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${pattern} \\{([^}]*)\\}`).exec(flatCss)
  if (!match) throw new Error(`未找到规则 ${selector}`)
  return match[1] as string
}

describe('trace region layout', () => {
  let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    sessionStorage.clear()
    resetWebDom()
  })

  it('renders the trace pane through exactly two slot wrappers around #trace-content', async () => {
    runtime = await mountRenderedIndex()
    const region = document.querySelector('#trace-panel')
    const content = region?.querySelector('#trace-content')

    expect(content?.getAttribute('style')).toContain('display: contents')
    expect(content?.parentElement?.hasAttribute('data-slot-entry')).toBe(true)
    expect(content?.parentElement?.parentElement?.getAttribute('data-slot')).toBe('ui:trace')
    expect(content?.parentElement?.parentElement?.parentElement).toBe(region)
    expect(content?.querySelector('.trace-body > .trace-list')).toBeTruthy()
    const trace = runtime.trace
    if (!trace) throw new Error('Missing trace region')
    trace.render(
      [
        {
          kind: 'tool',
          id: 'actual-tool',
          seq: 4,
          resultSeq: 7,
          toolUseId: 'actual-use',
          name: 'write',
          status: 'completed',
          summary: 'confirmed write',
        },
      ],
      [],
      { sessionId: 'owned-session', hasEarlier: false },
    )
    expect(trace.selectTool?.('foreign-session', 4, 7)).toBe(false)
    expect(trace.isOpen()).toBe(false)
    expect(trace.selectTool?.('owned-session', 4, 7)).toBe(true)
    expect(trace.isOpen()).toBe(true)
    expect(content?.querySelector('[aria-current="true"]')?.getAttribute('data-trace-row-id')).toBe(
      'actual-tool',
    )
    expect(content?.querySelector('.trace-inspector')?.textContent).toContain('write')
    expect(trace.selectTool?.('owned-session', 100)).toBe(false)
  })

  it('leaves the trace for the conversation when a new session starts there (TRACE-NEWSESSION)', async () => {
    runtime = await mountRenderedIndex()
    const trace = runtime.trace
    if (!trace) throw new Error('Missing trace region')
    trace.render([{ kind: 'user', id: 'u', seq: 1, content: [{ type: 'text', text: 'install mcp' }] }], [], {
      sessionId: 'traced',
      hasEarlier: false,
    })
    trace.setOpen(true)
    expect(document.querySelector('#view-trace')?.getAttribute('aria-selected')).toBe('true')
    // What the app renders for a new draft: no session, nothing recorded.
    trace.render([], [])
    expect(trace.isOpen()).toBe(false)
    expect(document.querySelector('#view-chat')?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('#view-trace')?.getAttribute('aria-selected')).toBe('false')
    expect(document.body.classList.contains('trace-open')).toBe(false)
    expect(document.querySelector<HTMLElement>('#trace-panel')?.hidden).toBe(true)
    // The rule that hides the composer only applies while the trace tab is selected.
    expect(flatCss).toContain('main:has(#view-trace[aria-selected="true"]) #composer-mount')
    // An empty trace, when shown, sits in the middle of its pane.
    expect(declarations('.trace-empty')).toContain('align-self: center')
    expect(declarations('.trace-empty')).toContain('justify-self: center')
  })

  it('neutralizes the wrappers so the list keeps its region grid row', () => {
    // 包装是普通 block 时，区域网格只看到一个按内容高度铺开的子项：三条轨道被第一行全吃掉，
    // .trace-body 拿到的不是剩余高度而是内容高度，.trace-list 的 overflow:auto 永不触发，
    // 列表被区域的 overflow:hidden 裁掉又滚不动。
    expect(declarations('[data-agnes-region="trace"]')).toContain(
      'grid-template-rows: auto auto auto minmax(0, 1fr)',
    )
    expect(
      declarations(
        '[data-agnes-region="trace"] > [data-slot], [data-agnes-region="trace"] > [data-slot] > [data-slot-entry]',
      ),
    ).toContain('display: contents')
    expect(declarations('.trace-body')).toContain('min-height: 0')
    expect(declarations('.trace-list')).toContain('overflow: auto')
  })

  it('gives every part of the trace its own row, so nothing can push the list off the flexible one', () => {
    // A run with approvals adds the control records above the toolbar. With auto-placement that
    // fourth part moved the timeline onto the flexible row, where it collapsed and its lanes were
    // painted over the first records.
    expect(declarations('.trace-toolbar')).toContain('grid-row: 2')
    expect(declarations('.trace-gantt')).toContain('grid-row: 3')
    expect(declarations('.trace-body')).toContain('grid-row: 4')
    expect(declarations('.trace-empty')).toContain('grid-row: 4')
    const overlay = '[data-agnes-region="trace"]:has(.trace-inspector:not([hidden]))'
    expect(declarations(overlay)).toContain('grid-template-rows: minmax(0, 1fr)')
    expect(declarations(`${overlay} .trace-body`)).toContain('grid-row: 1')
    const tablet =
      [...css.matchAll(/@media \(min-width: 768px\) and \(max-width: 900px\) \{([\s\S]*?)\n  \}/g)]
        .map((match) => match[1] ?? '')
        .find((block) => block.includes('.workbench-changes-file.agnes-ui-button')) ?? ''
    for (const selector of [
      '.deliverable-row .agh-list-row-title',
      '.trace-search-box .trace-search',
      '.trace-fold-all.agh-btn--icon',
      '.workbench-files-filter .agh-search-bar-field > input',
      '.workbench-changes-file.agnes-ui-button',
      '.agnes-settings-chip-input',
      '.agnes-settings-block a',
    ])
      expect(tablet).toContain(selector)
    expect(tablet).toContain('min-height: var(--s32)')
  })

  it('keeps shared control retuning out of the trace', () => {
    const scope = ':where([data-agnes-region="trace"])'
    const small = declarations(`${scope} :where(.agh-btn--sm:not(.agh-btn--icon))`)
    expect(small).toContain('height: var(--control-height-sm)')
    expect(small).toContain('min-height: var(--control-height-sm)')
    expect(declarations(`${scope} :where(.agh-btn:not(.agh-btn--link), .agnes-settings-input)`)).toContain(
      'border-radius: var(--radius-md)',
    )
    const select = declarations(`${scope} :where(select.agnes-settings-input)`)
    expect(select).toContain('box-shadow: none')
    expect(select).toContain('border-color: var(--agnes-input-border)')
    expect(declarations(`${scope} :where(.agh-btn, .agnes-settings-input)`)).toContain('corner-shape: round')
    // Trace rules name the fixed 10px step; the shared control radius is free to move.
    const traceRules = flatCss.match(/\.trace-[\w-]+[^{}]*\{[^}]*\}/g) ?? []
    expect(traceRules.filter((rule) => rule.includes('var(--radius-control)'))).toEqual([])
  })
})
