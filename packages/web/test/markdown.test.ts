// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMarkdownRenderer } from '../src/markdown.js'
import { createTimelineRenderer } from '../src/timeline.js'

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
    createMarkdownRenderer(element, '```\nshown code\n```')
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
    expect(element.querySelector('.code-copy')).not.toBe(copy)
    expect(element.querySelector('pre code')?.textContent).toBe('new code')
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
    expect(element.querySelectorAll('p')[1]).not.toBe(unresolved)
    expect(element.querySelectorAll('p')[1]?.querySelector<HTMLAnchorElement>('a')?.href).toBe(
      'https://example.test/docs',
    )
  })
})

it('preserves a selected assistant block while the answer is already streaming', () => {
  const transcript = container()
  const newContent = document.createElement('button')
  const timeline = createTimelineRenderer({ transcript, newContentButton: newContent })
  timeline.render([
    {
      kind: 'assistant',
      id: 'assistant-1',
      seq: 1,
      text: '已完成段落\n\n正在输出',
      thinking: '内部推理',
      streaming: true,
    },
  ])
  const details = transcript.querySelector<HTMLDetailsElement>('.thinking')
  const completed = transcript.querySelector('.node-body p')
  // 正文已经开始（text 非空）⇒ 思考阶段结束 ⇒ 自动收起；展开态由新用例单独覆盖。
  expect(details?.open).toBe(false)
  expect(details?.querySelector('summary')?.textContent).toBe('深度思考')

  const selection = document.getSelection()
  const range = document.createRange()
  range.selectNodeContents(completed?.firstChild ?? transcript)
  selection?.removeAllRanges()
  selection?.addRange(range)
  timeline.render([
    {
      kind: 'assistant',
      id: 'assistant-1',
      seq: 1,
      text: '已完成段落\n\n正在输出 **完成**',
      thinking: '内部推理\n\n补充',
      streaming: true,
    },
  ])
  expect(transcript.querySelector('.node-body p')).toBe(completed)
  expect(transcript.querySelector('.node-body strong')).toBeNull()

  selection?.removeAllRanges()
  document.dispatchEvent(new Event('selectionchange'))
  expect(transcript.querySelector('.node-body p')).toBe(completed)
  expect(transcript.querySelector('.node-body strong')?.textContent).toBe('完成')
})

it('keeps historical thinking closed and preserves a manual collapse across streaming updates', () => {
  const transcript = container()
  const timeline = createTimelineRenderer({ transcript, newContentButton: document.createElement('button') })
  // text 留空：这一例要的是「思考阶段本身」的展开态与手动收起。
  const node = { kind: 'assistant' as const, id: 'thinking-1', seq: 1, text: '', thinking: 'thought' }
  timeline.render([node])
  const details = transcript.querySelector<HTMLDetailsElement>('.thinking')
  expect(details?.open).toBe(false)
  timeline.render([{ ...node, streaming: true }])
  expect(details?.open).toBe(true)
  details?.querySelector('summary')?.click()
  // happy-dom does not supply the browser's details activation default action.
  if (details) details.open = false
  timeline.render([{ ...node, thinking: 'thought continued', streaming: true }])
  expect(details?.open).toBe(false)
  timeline.render([{ ...node, thinking: 'thought completed', streaming: false }])
  expect(details?.open).toBe(false)
})

it('collapses thinking once it ends and keeps a manual re-expand afterwards', () => {
  const transcript = container()
  const timeline = createTimelineRenderer({ transcript, newContentButton: document.createElement('button') })
  const node = {
    kind: 'assistant' as const,
    id: 'thinking-2',
    seq: 1,
    text: '',
    thinking: '推理中',
    streaming: true,
  }
  timeline.render([node])
  const details = transcript.querySelector<HTMLDetailsElement>('.thinking')
  expect(details?.open).toBe(true)

  // 正文开始输出 ⇒ 思考结束 ⇒ 自动收起一次。
  timeline.render([{ ...node, text: '第一段', thinking: '推理完成' }])
  expect(details?.open).toBe(false)

  // 手动展开后，后续投影（继续流式、以及最终落定）都不再把它压回去。
  details?.querySelector('summary')?.click()
  // happy-dom does not supply the browser's details activation default action.
  if (details) details.open = true
  timeline.render([{ ...node, text: '第一段第二句', thinking: '推理完成' }])
  expect(details?.open).toBe(true)
  timeline.render([{ ...node, text: '第一段第二句', thinking: '推理完成', streaming: false }])
  expect(details?.open).toBe(true)

  // 用户再手动收起同样保留。
  details?.querySelector('summary')?.click()
  if (details) details.open = false
  timeline.render([{ ...node, text: '第一段第二句', thinking: '推理完成', streaming: false }])
  expect(details?.open).toBe(false)
})

it('still collapses at the end of the thinking phase when it was expanded by hand during it', () => {
  const transcript = container()
  const timeline = createTimelineRenderer({ transcript, newContentButton: document.createElement('button') })
  const node = {
    kind: 'assistant' as const,
    id: 'thinking-3',
    seq: 1,
    text: '',
    thinking: '推理中',
    streaming: true,
  }
  timeline.render([node])
  const details = transcript.querySelector<HTMLDetailsElement>('.thinking')

  // 思考阶段手动收起再展开：这一段的开合结束于「思考结束」那一刻，
  // 与回合过程区（turns.ts 的 processPreference）同语义，会被结束时的自动收起覆盖。
  details?.querySelector('summary')?.click()
  if (details) details.open = false
  details?.querySelector('summary')?.click()
  if (details) details.open = true
  expect(details?.open).toBe(true)

  timeline.render([{ ...node, text: '第一段', thinking: '推理完成' }])
  expect(details?.open).toBe(false)

  // 结束之后再手动展开，则不再被覆盖。
  details?.querySelector('summary')?.click()
  if (details) details.open = true
  timeline.render([{ ...node, text: '第一段', thinking: '推理完成', streaming: false }])
  expect(details?.open).toBe(true)
})

it('replaces an entry whose node kind changes without leaving its prior DOM or listeners behind', () => {
  const transcript = container()
  const newContent = document.createElement('button')
  const timeline = createTimelineRenderer({ transcript, newContentButton: newContent })
  timeline.render([{ kind: 'assistant', id: 'same-id', seq: 1, text: 'first', streaming: true }])
  timeline.render([
    {
      kind: 'tool',
      id: 'same-id',
      seq: 2,
      toolUseId: 'call-1',
      name: 'read_file',
      status: 'completed',
      summary: 'read a file',
      enforcement: { level: 'full', scope: [] },
      children: [],
      slots: [],
    },
  ])
  expect(transcript.querySelectorAll('[data-node-id="same-id"]')).toHaveLength(1)
  expect(transcript.querySelector('.assistant')).toBeNull()
  expect(transcript.querySelector('.tool-name')?.textContent).toBe('read_file')
})

it('labels unreported usage honestly and keeps verified amounts, including zero', () => {
  const transcript = container()
  const newContent = document.createElement('button')
  const timeline = createTimelineRenderer({ transcript, newContentButton: newContent })

  timeline.render([{ kind: 'cost', id: 'cost-1', seq: 1, source: 'estimated' }])
  expect(transcript.querySelector('.call-usage summary')?.textContent).toBe('费用未提供')

  timeline.render([{ kind: 'cost', id: 'cost-1', seq: 1, source: 'estimated', credits: 1.25 }])
  expect(transcript.querySelector('.call-usage summary')?.textContent).toBe('1.25 credits（估算）')

  timeline.render([{ kind: 'cost', id: 'cost-1', seq: 1, source: 'gateway', credits: 0 }])
  expect(transcript.querySelector('.call-usage summary')?.textContent).toBe('0 credits（网关记录）')
})
