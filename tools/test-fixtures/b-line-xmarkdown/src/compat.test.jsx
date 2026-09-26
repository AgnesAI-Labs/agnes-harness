// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AdaptedMarkdown, CoordinatedMarkdown, DefaultMarkdown } from './adapt.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const safetyCorpus =
  '<script>window.pwned = true</script>\n\nFish &amp; Chips\n\n[good](https://example.test/?a=1&amp;b=2) [fragment](#notes) [relative](../notes) [data](data:text/html,hi) [encoded](java&#x73;cript:alert(1))\n\n**保留粗体** \\<img src="https://example.test/literal.png" data-note="a&amp;b"> &lt;em&gt;literal entity&lt;/em&gt; 和 *强调*\n\n![diagram alt](https://example.test/diagram.png)'
const gfmCorpus =
  '# 标题\n\n正文有 **重点**、*强调* 和 `inline()`。\n\n- 第一项\n  - 子项\n\n> 引用\n\n```ts\nconst value = 1\n```\n\n| 名称 | 数值 |\n| :--- | ---: |\n| Agnes | 1 |\n\n[文档](https://example.test/docs)'

const active = []
function mount(Component, content, streaming = false, animation = false) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const update = (next, nextStreaming = streaming, nextAnimation = animation) =>
    act(() => root.render(<Component content={next} streaming={nextStreaming} animation={nextAnimation} />))
  update(content)
  active.push({ root, host })
  const dispose = () => {
    const index = active.findIndex((item) => item.root === root)
    if (index >= 0) active.splice(index, 1)
    act(() => root.unmount())
    host.remove()
  }
  return { host, update, dispose }
}

afterEach(() => {
  for (const { root, host } of active.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  document.body.replaceChildren()
  document.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('records installed defaults separately from the Agnes contract', () => {
  const { host } = mount(DefaultMarkdown, safetyCorpus)
  expect(host.querySelector('script')).toBeNull()
  expect(host.querySelector('img')).not.toBeNull()
  expect(host.querySelector('a[href="../notes"]')).not.toBeNull()
  expect(host.textContent).not.toContain('<script>window.pwned = true</script>')
})

it('renders the existing GFM semantics through the real package and candidate components', () => {
  const { host } = mount(AdaptedMarkdown, gfmCorpus)
  expect(host.querySelector('h1')?.textContent).toBe('标题')
  expect(host.querySelector('strong')?.textContent).toBe('重点')
  expect(host.querySelector('em')?.textContent).toBe('强调')
  expect(host.querySelector('p code')?.textContent).toBe('inline()')
  expect(host.querySelector('ul ul li')?.textContent).toBe('子项')
  expect(host.querySelector('blockquote')?.textContent).toContain('引用')
  expect(host.querySelector('.code-block pre code')?.textContent).toContain('const value = 1')
  expect(host.querySelector('.code-language')?.textContent).toBe('ts')
  expect(host.querySelector('table tbody td:last-child')?.textContent).toBe('1')
  expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.test/docs')
})

it('adapts the current Markdown safety corpus and code copy', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const { host } = mount(AdaptedMarkdown, `${safetyCorpus}\n\n\`\`\`ts\nshown code\n\`\`\``)
  expect(host.querySelector('script,img')).toBeNull()
  expect(host.textContent).toContain('<script>window.pwned = true</script>')
  expect(host.textContent).toContain('Fish & Chips')
  expect(host.textContent).toContain('<img src="https://example.test/literal.png" data-note="a&b">')
  expect(host.textContent).toContain('<em>literal entity</em>')
  expect(host.textContent).toContain('[relative](../notes)')
  expect(host.textContent).toContain('[data](data:text/html,hi)')
  expect(host.textContent).toContain('[encoded](java&#x73;cript:alert(1))')
  expect(host.textContent).toContain('diagram alt')
  expect([...host.querySelectorAll('a')].map((node) => node.textContent)).toEqual(['good', 'fragment'])
  expect(host.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
  expect(host.querySelector('.code-copy')?.getAttribute('aria-label')).toBe('复制代码')
  act(() => host.querySelector('.code-copy')?.click())
  await act(async () => Promise.resolve())
  expect(writeText).toHaveBeenCalledWith('shown code')
  expect(host.querySelector('.code-copy')?.textContent).toBe('已复制')
})

it('re-resolves references and keeps settled blocks over deltas', () => {
  const { host, update } = mount(AdaptedMarkdown, '固定段落\n\n[文档][ref]', true)
  const stable = host.querySelector('p')
  update('固定段落\n\n[文档][ref]\n\n[ref]: https://example.test/docs', true)
  expect(host.querySelector('p')).toBe(stable)
  expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.test/docs')
  update('固定段落\n\n[文档][ref]\n\n[ref]: https://example.test/docs', false)
  expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.test/docs')
})

it('shows the published stream cache gap for an unterminated reference definition', () => {
  const { host, update } = mount(DefaultMarkdown, '固定段落\n\n[文档][ref]', true)
  update('固定段落\n\n[文档][ref]\n\n[ref]: https://example.test/docs', true)
  expect(host.querySelector('a')).toBeNull()
  update('固定段落\n\n[文档][ref]\n\n[ref]: https://example.test/docs', false)
  expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.test/docs')
})

it('closes emphasis and a fenced block over multiple deltas and terminal replacement', () => {
  const { host, update } = mount(AdaptedMarkdown, '稳定段落\n\n**加', true)
  update('稳定段落\n\n**加粗**', true)
  expect(host.querySelector('strong')?.textContent).toBe('加粗')
  update('稳定段落\n\n**加粗**\n\n```ts\nconst x = 1', true)
  expect(host.querySelector('code')?.textContent).toContain('const x = 1')
  update('稳定段落\n\n**加粗**\n\n```ts\nconst x = 1\n```', false)
  expect(host.querySelector('.code-copy')).not.toBeNull()
  expect(host.textContent).toContain('const x = 1')
})

it('defers updates under selection and focused copy control, then flushes the latest source', async () => {
  const { host, update } = mount(CoordinatedMarkdown, '固定段落\n\n流式尾部', true)
  const stable = host.querySelector('p')
  const selection = document.getSelection()
  const range = document.createRange()
  range.selectNodeContents(stable)
  selection.removeAllRanges()
  selection.addRange(range)
  update('固定段落\n\n流式尾部 **完成**', true)
  expect(host.textContent).not.toContain('完成')
  expect(host.querySelector('p')).toBe(stable)
  act(() => {
    selection.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
  })
  expect(host.querySelector('strong')?.textContent).toBe('完成')
  expect(host.querySelector('p')).toBe(stable)

  update('```\nold code\n```', false)
  const copy = host.querySelector('.code-copy')
  act(() => copy.focus())
  update('```\nnew code\n```', false)
  expect(host.querySelector('.code-copy')).toBe(copy)
  expect(host.querySelector('code')?.textContent).toContain('old code')
  await act(async () => {
    copy.blur()
    await Promise.resolve()
  })
  expect(host.querySelector('code')?.textContent).toContain('new code')
})

it('reports failed copy and restores the label after its timer', async () => {
  vi.useFakeTimers()
  const writeText = vi.fn().mockRejectedValueOnce(new Error('denied'))
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const { host } = mount(AdaptedMarkdown, '```\nshown code\n```')
  await act(async () => host.querySelector('.code-copy')?.click())
  expect(writeText).toHaveBeenCalledWith('shown code')
  expect(host.querySelector('.code-copy')?.textContent).toBe('复制失败')
  await act(async () => vi.advanceTimersByTimeAsync(1600))
  expect(host.querySelector('.code-copy')?.textContent).toBe('复制')
})

it('does not start a copy feedback timer after the code block unmounts', async () => {
  let complete
  const writeText = vi.fn(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const timer = vi.spyOn(globalThis, 'setTimeout')
  const { host, dispose } = mount(AdaptedMarkdown, '```\nshown code\n```')
  act(() => host.querySelector('.code-copy')?.click())
  const before = timer.mock.calls.length
  dispose()
  await act(async () => {
    complete()
    await Promise.resolve()
  })
  expect(timer.mock.calls.length).toBe(before)
})

it('keeps the prior animated span during suffix append and renders a divergent final replacement', () => {
  const { host, update } = mount(AdaptedMarkdown, '逐字', true, true)
  const previous = host.querySelector('p span')
  expect(previous?.textContent).toBe('逐字')
  update('逐字追加', true, true)
  expect([...host.querySelectorAll('p span')].map((span) => span.textContent)).toEqual(['逐字', '追加'])
  expect(host.querySelector('p span')).toBe(previous)
  update('最终结果', false, false)
  expect(host.textContent).toContain('最终结果')
  expect(host.textContent).not.toContain('逐字')
})

it('does not rewrite escaped-tag text inside fenced code', () => {
  const { host } = mount(AdaptedMarkdown, '```txt\n\\<img src="https://example.test/code.png">\n```')
  expect(host.querySelector('code')?.textContent).toContain('\\<img src="https://example.test/code.png">')
})

it('keeps escaped tags inside inline code literal', () => {
  const { host } = mount(AdaptedMarkdown, '`\\<img src="https://example.test/inline.png">`')
  expect(host.querySelector('code')?.textContent).toContain('\\<img src="https://example.test/inline.png">')
  expect(host.querySelector('img')).toBeNull()
})

it('handles heading fragments without mutating the launcher hash', () => {
  const target = document.createElement('h2')
  target.id = 'reading-notes'
  const scroll = vi.fn()
  target.scrollIntoView = scroll
  document.body.append(target)
  const { host } = mount(AdaptedMarkdown, '[跳转](#reading-notes) [不存在](#none)')
  const before = location.hash
  act(() => host.querySelector('a')?.click())
  expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
  expect(document.activeElement).toBe(target)
  expect(location.hash).toBe(before)
  act(() => host.querySelectorAll('a')[1]?.click())
  expect(location.hash).toBe(before)
})
