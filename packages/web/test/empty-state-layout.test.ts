import { readWebStyleSource } from '../../../tools/web-style-source.mjs'
/** @vitest-environment happy-dom */

import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

const css = readWebStyleSource(resolve(__dirname, '../public/style.css'))

function rule(selector: string): string {
  const escaped = selector.replace(/[.#[\]]/g, '\\$&')
  const match = new RegExp(`^\\s*${escaped} \\{([^}]*)\\}`, 'm').exec(css)
  if (!match) throw new Error(`未找到规则 ${selector}`)
  return match[1] as string
}

describe('empty session layout', () => {
  let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    resetWebDom()
  })

  it('keys the empty-state layout off #empty-state, because #transcript can never be :empty', async () => {
    runtime = await mountRenderedIndex()
    const transcript = document.querySelector('section#transcript')

    // React 树恒定渲染一个 #transcript-content 子节点，所以 `#transcript:empty` 永远不成立。
    // 空态布局此前挂在这个选择器上，等于从来没生效过（表现是输入卡一直贴底）。
    expect(transcript?.querySelector('#transcript-content')).toBeTruthy()
    expect(transcript?.childElementCount).toBeGreaterThan(0)

    expect(css).not.toMatch(/body:has\(#transcript:empty\)/)
    expect(css).toContain('body:has(#empty-state:not([hidden]))')
  })

  it('scrolls the whole middle column and keeps the content column on the inner node', () => {
    // 限宽留在 #transcript 上时，两侧留白属于不可滚动的祖先，鼠标停在上面滚轮无效。
    expect(rule('.workbench-split')).toMatch(/grid-template-rows: auto minmax\(0, 1fr\)/)
    expect(rule('#transcript')).toMatch(/width: 100%/)
    expect(rule('#transcript')).toMatch(/overflow-y: auto/)
    expect(rule('#transcript')).not.toMatch(/padding/)
    expect(rule('#transcript-content')).toMatch(/width: min\(100%, var\(--chat-content-width\)\)/)
    expect(rule('#transcript-content')).toMatch(/margin-inline: auto/)
  })

  it('shows the connection state only while the connection is unhealthy', () => {
    expect(css).toMatch(
      /body:not\(\[data-connection="reconnecting"\]\):not\(\[data-connection="closed"\]\) \.connection-group/,
    )
    expect(css).not.toMatch(/#disconnect/)
  })
})
