/** @vitest-environment happy-dom */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

const css = readFileSync(resolve(__dirname, '../public/style.css'), 'utf8')
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
  })

  it('neutralizes the wrappers so the list keeps its region grid row', () => {
    // 包装是普通 block 时，区域网格只看到一个按内容高度铺开的子项：三条轨道被第一行全吃掉，
    // .trace-body 拿到的不是剩余高度而是内容高度，.trace-list 的 overflow:auto 永不触发，
    // 列表被区域的 overflow:hidden 裁掉又滚不动。
    expect(declarations('[data-agnes-region="trace"]')).toContain(
      'grid-template-rows: auto auto minmax(0, 1fr)',
    )
    expect(
      declarations(
        '[data-agnes-region="trace"] > [data-slot], [data-agnes-region="trace"] > [data-slot] > [data-slot-entry]',
      ),
    ).toContain('display: contents')
    expect(declarations('.trace-body')).toContain('min-height: 0')
    expect(declarations('.trace-list')).toContain('overflow: auto')
  })
})
