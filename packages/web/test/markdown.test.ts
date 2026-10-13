// @vitest-environment happy-dom

import { createMarkdownRenderer } from '@agnes/web-conversation/markdown'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zhT } from './helpers/locale.js'

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  vi.useRealTimers()
  document.body.replaceChildren()
})

function container(): HTMLElement {
  const element = document.createElement('div')
  document.body.append(element)
  return element
}

describe('Markdown DOM renderer', () => {
  it('renders readable GFM through an explicit element allowlist', () => {
    const element = container()
    createMarkdownRenderer(
      element,
      '# 标题\n\n正文有 **重点**、*强调* 和 `inline()`。\n\n- 第一项\n  - 子项\n\n> 引用\n\n```ts\nconst value = 1\n```\n\n| 名称 | 数值 |\n| :--- | ---: |\n| Agnes | 1 |\n\n[文档](https://example.test/docs)',
      { t: zhT },
    )

    expect(element.querySelector('h1')?.textContent).toBe('标题')
    expect(element.querySelector('strong')?.textContent).toBe('重点')
    expect(element.querySelector('em')?.textContent).toBe('强调')
    expect(element.querySelector('p code')?.textContent).toBe('inline()')
    expect(element.querySelector('ul ul li')?.textContent).toBe('子项')
    expect(element.querySelector('blockquote')?.textContent).toContain('引用')
    expect(element.querySelector('.code-block pre code')?.textContent).toBe('const value = 1')
    expect(element.querySelector('.code-language')?.textContent).toBe('ts')
    expect(element.querySelector('.code-copy')?.getAttribute('aria-label')).toBe('复制代码')
    expect(element.querySelector('.table-scroll table tbody td:last-child')?.textContent).toBe('1')
    const link = element.querySelector<HTMLAnchorElement>('a')
    expect(link?.href).toBe('https://example.test/docs')
    expect(link?.rel).toBe('noopener noreferrer')
  })

  it('keeps HTML literal, decodes text entities, and rejects unsafe destinations without image requests', () => {
    const element = container()
    createMarkdownRenderer(
      element,
      '<script>window.pwned = true</script>\n\nFish &amp; Chips\n\n[good](https://example.test/?a=1&amp;b=2) [fragment](#notes) [relative](../notes) [data](data:text/html,hi) [encoded](java&#x73;cript:alert(1))\n\n**保留粗体** \\<img src="https://example.test/literal.png" data-note="a&amp;b"> &lt;em&gt;literal entity&lt;/em&gt; 和 *强调*\n\n![diagram alt](https://example.test/diagram.png)',
    )

    expect(element.querySelector('script')).toBeNull()
    expect(element.querySelector('img')).toBeNull()
    expect(element.textContent).toContain('<script>window.pwned = true</script>')
    expect(element.textContent).toContain('Fish & Chips')
    expect(element.textContent).toContain('[relative](../notes)')
    expect(element.textContent).toContain('[data](data:text/html,hi)')
    expect(element.textContent).toContain('[encoded](java&#x73;cript:alert(1))')
    expect(element.textContent).toContain('<img src="https://example.test/literal.png" data-note="a&b">')
    expect(element.textContent).toContain('<em>literal entity</em>')
    expect(Array.from(element.querySelectorAll('strong')).map((item) => item.textContent)).toContain(
      '保留粗体',
    )
    expect(Array.from(element.querySelectorAll('em')).map((item) => item.textContent)).toContain('强调')
    expect(element.textContent).toContain('diagram alt')
    const links = Array.from(element.querySelectorAll<HTMLAnchorElement>('a'))
    expect(links.map((link) => link.textContent)).toEqual(['good', 'fragment'])
    expect(links[0]?.href).toBe('https://example.test/?a=1&b=2')
    expect(links[1]?.getAttribute('href')).toBe('#notes')
    expect(links[1]?.getAttribute('target')).toBeNull()
  })

  it('copies only displayed code and reports success or failure after a user action', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const element = container()
    createMarkdownRenderer(element, '```\nshown code\n```', { t: zhT })
    const copy = element.querySelector<HTMLButtonElement>('.code-copy')
    copy?.click()
    await vi.runAllTicks()
    expect(writeText).toHaveBeenCalledWith('shown code')
    expect(copy?.textContent).toBe('已复制')
    await vi.advanceTimersByTimeAsync(1_600)
    expect(copy?.textContent).toBe('复制')

    writeText.mockRejectedValueOnce(new Error('denied'))
    copy?.click()
    await vi.runAllTicks()
    expect(copy?.textContent).toBe('复制失败')
  })

  it('defers a code replacement while its copy control is focused and disposes its timer on release', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout')
    const element = container()
    const markdown = createMarkdownRenderer(element, '```\nold code\n```')
    const copy = element.querySelector<HTMLButtonElement>('.code-copy')
    copy?.focus()
    copy?.click()
    await vi.runAllTicks()
    markdown.update('```\nnew code\n```')
    expect(element.querySelector('.code-copy')).toBe(copy)
    expect(element.querySelector('pre code')?.textContent).toBe('old code')

    copy?.blur()
    await vi.runAllTicks()
    expect(element.querySelector('.code-copy')).toBe(copy)
    expect(element.querySelector('pre code')?.textContent).toBe('new code')
    markdown.dispose()
    expect(clearTimer).toHaveBeenCalled()
  })

  it('scrolls and focuses an existing heading fragment without changing the launcher hash', () => {
    const target = document.createElement('h2')
    target.id = 'reading-notes'
    const scrollIntoView = vi.fn()
    Object.defineProperty(target, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    document.body.append(target)
    const element = container()
    createMarkdownRenderer(element, '[跳转](#reading-notes) [不存在](#none)')
    const links = element.querySelectorAll<HTMLAnchorElement>('a')
    const before = window.location.hash
    links[0]?.click()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(document.activeElement).toBe(target)
    expect(window.location.hash).toBe(before)
    links[1]?.click()
    expect(window.location.hash).toBe(before)
  })

  it('keeps completed selected blocks connected and applies the latest formatting when selection releases', () => {
    const element = container()
    const markdown = createMarkdownRenderer(element, '固定段落\n\n流式尾部')
    const completed = element.querySelector('p')
    const selection = document.getSelection()
    const range = document.createRange()
    range.selectNodeContents(completed?.firstChild ?? element)
    selection?.removeAllRanges()
    selection?.addRange(range)

    markdown.update('固定段落\n\n流式尾部 **完成**')
    expect(element.querySelector('p')).toBe(completed)
    expect(element.textContent).not.toContain('完成')

    selection?.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
    expect(element.querySelector('p')).toBe(completed)
    expect(element.querySelector('strong')?.textContent).toBe('完成')
  })

  it('re-resolves reference links when a later stream delta supplies their definition', () => {
    const element = container()
    const markdown = createMarkdownRenderer(element, '稳定段落\n\n[文档][ref]')
    const stable = element.querySelector('p')
    const unresolved = element.querySelectorAll('p')[1]

    markdown.update('稳定段落\n\n[文档][ref]\n\n[ref]: https://example.test/docs')
    expect(element.querySelector('p')).toBe(stable)
    expect(element.querySelectorAll('p')[1]).toBe(unresolved)
    expect(element.querySelectorAll('p')[1]?.querySelector<HTMLAnchorElement>('a')?.href).toBe(
      'https://example.test/docs',
    )
  })
})
