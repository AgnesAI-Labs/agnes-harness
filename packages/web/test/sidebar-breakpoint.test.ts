/** @vitest-environment happy-dom */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// 侧栏在窄屏是「点按钮开抽屉」还是「折叠成 rail」，由 JS 的媒体查询决定；侧栏是不是
// 覆盖层，由 CSS 的媒体查询决定。两边断点必须一致：不一致时中间那段宽度里 JS 走桌面
// 折叠分支、CSS 已经把侧栏移出视口，按钮点下去没有任何可见反应。
const sidebarSource = readFileSync(resolve(__dirname, '../../web-units/src/sidebar.ts'), 'utf8')
const css = readFileSync(resolve(__dirname, '../public/style.css'), 'utf8')

function narrowBreakpoint(): number {
  const match = /matchMedia\('\(max-width:\s*(\d+)px\)'\)/.exec(sidebarSource)
  if (!match) throw new Error('未找到 sidebar.ts 里的窄屏媒体查询')
  return Number(match[1])
}

/** 抽屉模式：`.sidebar-backdrop` 的固定定位规则所在的那个媒体查询。 */
function drawerBreakpoint(): number {
  const backdrop = css.indexOf('.sidebar-backdrop {')
  expect(backdrop).toBeGreaterThan(-1)
  const media = css.lastIndexOf('@media (max-width: ', backdrop)
  expect(media).toBeGreaterThan(-1)
  const match = /@media \(max-width: (\d+)px\)/.exec(css.slice(media))
  if (!match) throw new Error('未找到 style.css 里的抽屉媒体查询')
  return Number(match[1])
}

/** 桌面 rail 模式：`.sidebar-collapsed` 收起样式所在的那个媒体查询。 */
function railBreakpoint(): number {
  const collapsed = css.indexOf('body.sidebar-collapsed .sidebar {')
  expect(collapsed).toBeGreaterThan(-1)
  const media = css.lastIndexOf('@media (min-width: ', collapsed)
  expect(media).toBeGreaterThan(-1)
  const match = /@media \(min-width: (\d+)px\)/.exec(css.slice(media))
  if (!match) throw new Error('未找到 style.css 里的 rail 媒体查询')
  return Number(match[1])
}

describe('sidebar narrow breakpoint', () => {
  it('matches the CSS drawer breakpoint', () => {
    expect(narrowBreakpoint()).toBe(drawerBreakpoint())
  })

  it('hands the viewport over to the rail breakpoint without a gap', () => {
    // 抽屉覆盖 `<= N`，rail 覆盖 `>= N + 1`。中间留空的话又会回到「两边都不管」的状态。
    expect(railBreakpoint()).toBe(drawerBreakpoint() + 1)
  })
})
