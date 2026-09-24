// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { toolIcon } from '../src/tool-icon.js'

const paths = (name: string): string =>
  [...toolIcon(name).querySelectorAll('path')].map((node) => node.getAttribute('d') ?? '').join(' ')

it('按工具名给不同字形：搜索类拿放大镜、目录类拿文件夹、未知的拿扳手', () => {
  // lucide search 的镜身
  expect(paths('tool_search')).toContain('m21 21-4.34-4.34')
  expect(paths('web_search')).toContain('m21 21-4.34-4.34')
  expect(paths('grep_files')).toContain('m21 21-4.34-4.34')
  // lucide folder
  expect(paths('ls')).toContain('h-7.9a2 2 0 0 1-1.69-.9')
  expect(paths('list_dir')).toContain('h-7.9a2 2 0 0 1-1.69-.9')
  // lucide terminal
  expect(paths('bash_shell')).toContain('M12 19h8')
  // 未匹配到任何片段时回落到扳手
  expect(paths('mystery_tool')).toContain('M14.7 6.3a1 1 0')
  expect(paths('mystery_tool')).not.toContain('m21 21-4.34-4.34')
})

it('图标沿用全站 .icon 的 24 网格描边口径', () => {
  const svg = toolIcon('tool_search')
  expect(svg.getAttribute('class')).toBe('icon tool-icon')
  expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
  expect(svg.getAttribute('aria-hidden')).toBe('true')
  // 镜身是 path、镜圈是 circle：两种节点都要能建出来
  expect(svg.querySelectorAll('circle')).toHaveLength(1)
})
