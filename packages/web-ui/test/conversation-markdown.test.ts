/** @vitest-environment happy-dom */

import { ConversationMarkdown } from '@agnes/web-ui/assistant-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { zhT } from './locale.js'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function render(
  source: string,
  part: 'body' | 'thinking' = 'body',
  theme: 'light' | 'dark' = 'light',
  onCopy?: (text: string) => Promise<void>,
) {
  await act(async () =>
    root.render(createElement(ConversationMarkdown, { source, part, theme, onCopy, t: zhT })),
  )
}

it('renders GFM blocks in body and thinking without interpreting user HTML', async () => {
  await render(
    '# 标题\n\n正文 **重点** 和 `inline()`\n\n- 第一项\n  - 子项\n\n> 引用\n\n| 名称 | 数值 |\n| :--- | ---: |\n| Agnes | 1 |\n\n<script>window.pwned = true</script>',
  )
  expect(host.querySelector('h1')?.textContent).toBe('标题')
  expect(host.querySelector('strong')?.textContent).toBe('重点')
  expect(host.querySelector('p code')?.textContent).toBe('inline()')
  expect(host.querySelector('ul ul li')?.textContent).toBe('子项')
  expect(host.querySelector('blockquote')?.textContent).toContain('引用')
  expect(host.querySelector('table tbody td:last-child')?.textContent).toBe('1')
  expect(host.querySelector('script')).toBeNull()
  expect(host.textContent).toContain('<script>window.pwned = true</script>')
  await render('思考 **文本**', 'thinking', 'dark')
  expect(host.querySelector('[data-conversation-markdown="thinking"] strong')?.textContent).toBe('文本')
  expect(host.querySelector('.x-markdown-dark')).not.toBeNull()
})

it('keeps images textual and rejects unsafe, relative and entity-encoded URLs', async () => {
  await render(
    '![diagram alt](https://example.test/diagram.png) [good](https://example.test/docs) [fragment](#notes) [relative](../notes) [data](data:text/html,hi) [encoded](java&#x73;cript:alert(1)) \\<img src="https://example.test/literal.png">',
  )
  expect(host.querySelector('img')).toBeNull()
  expect(host.textContent).toContain('diagram alt')
  expect(host.textContent).toContain('[relative](../notes)')
  expect(host.textContent).toContain('[data](data:text/html,hi)')
  expect(host.textContent).toContain('[encoded](java&#x73;cript:alert(1))')
  expect(host.textContent).toContain('<img src="https://example.test/literal.png">')
  expect([...host.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'))).toEqual([
    'https://example.test/docs',
    '#notes',
  ])
  expect(host.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
})

it('resolves a reference and copies exact displayed code with success and failure feedback', async () => {
  const onCopy = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'))
  await render(
    '[文档][ref]\n\n[ref]: https://example.test/docs\n\n```ts\nshown code\n```',
    'body',
    'light',
    onCopy,
  )
  expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.test/docs')
  expect(host.querySelector('.code-language')?.textContent).toBe('ts')
  const button = host.querySelector<HTMLButtonElement>('.code-copy')
  expect(button?.getAttribute('aria-label')).toBe('复制代码')
  await act(async () => button?.click())
  expect(onCopy).toHaveBeenCalledWith('shown code')
  expect(button?.textContent).toBe('已复制')
  await act(async () => button?.click())
  expect(button?.textContent).toBe('复制失败')
})

it('preserves escaped tags in code and entities in prose without creating image requests', async () => {
  await render(
    'Fish &amp; Chips and &lt;em&gt;literal&lt;/em&gt;\n\n`\\<img src="https://example.test/inline.png">`\n\n```txt\n\\<img src="https://example.test/code.png">\n```',
  )
  expect(host.textContent).toContain('Fish & Chips and <em>literal</em>')
  expect(host.querySelector('p code')?.textContent).toContain('\\<img src="https://example.test/inline.png">')
  expect(host.querySelector('pre code')?.textContent).toContain('\\<img src="https://example.test/code.png">')
  expect(host.querySelector('img')).toBeNull()
})

it('keeps an unterminated escaped tag literal and does not autolink its URL', async () => {
  await render('前文 \\<img src="https://example.test/unclosed.png"\n\n[正常](https://example.test/docs)')
  expect(host.textContent).toContain('<img src="https://example.test/unclosed.png"')
  expect(host.querySelector('img')).toBeNull()
  expect([...host.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
    'https://example.test/docs',
  ])
  expect(host.textContent).not.toContain('AGH_LITERAL_')
})

it('sends a decoded heading fragment to the caller without changing the page hash', async () => {
  const onFragment = vi.fn()
  await act(async () =>
    root.render(
      createElement(ConversationMarkdown, {
        source: '[跳转](#reading-notes) [不安全](#bad%0Aname)',
        part: 'body',
        onFragment,
      }),
    ),
  )
  const before = location.hash
  await act(async () => host.querySelector('a')?.click())
  expect(onFragment).toHaveBeenCalledWith('reading-notes')
  expect(host.querySelectorAll('a')).toHaveLength(1)
  expect(location.hash).toBe(before)
})

it('restores copy feedback and ignores an asynchronous completion after unmount', async () => {
  vi.useFakeTimers()
  let complete: (() => void) | undefined
  const onCopy = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve
      }),
  )
  await render('```\nshown code\n```', 'body', 'light', onCopy)
  const button = host.querySelector<HTMLButtonElement>('.code-copy')
  await act(async () => {
    button?.click()
    complete?.()
  })
  expect(button?.textContent).toBe('已复制')
  await act(async () => vi.advanceTimersByTimeAsync(1_600))
  expect(button?.textContent).toBe('复制')
  await act(async () => button?.click())
  const timer = vi.spyOn(globalThis, 'setTimeout')
  const prior = timer.mock.calls.length
  await act(async () => root.unmount())
  await act(async () => complete?.())
  expect(timer.mock.calls.length).toBe(prior)
  root = createRoot(host)
})
