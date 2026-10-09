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
