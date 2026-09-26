/** @vitest-environment happy-dom */

import { ConversationMarkdown, type ConversationMarkdownProps } from '@agnes/web-ui/assistant-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  document.getSelection()?.removeAllRanges()
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})
const render = async (source: string, streaming = true, props: Partial<ConversationMarkdownProps> = {}) =>
  act(async () =>
    root.render(createElement(ConversationMarkdown, { source, streaming, part: 'body', ...props })),
  )
function select(element: Node) {
  const selection = document.getSelection()
  const range = document.createRange()
  range.selectNodeContents(element)
  selection?.removeAllRanges()
  selection?.addRange(range)
  return selection
}

it('buffers incomplete emphasis, closes it, and flushes an unfinished terminal body or thinking', async () => {
  await render('stable\n\n**open')
  const first = host.querySelector('p')
  expect(first?.textContent).toBe('stable')
  expect(host.textContent).not.toContain('**open')
  await render('stable\n\n**opened**')
  expect(host.querySelector('strong')?.textContent).toBe('opened')
  expect(host.querySelector('p')).toBe(first)
  await render('stable\n\n**unfinished')
  expect(host.textContent).not.toContain('**unfinished')
  await render('stable\n\n**unfinished', false)
  expect(host.textContent).toContain('**unfinished')
  await render('`thinking', true, { part: 'thinking' })
  expect(host.textContent).not.toContain('`thinking')
  await render('`thinking', false, { part: 'thinking' })
  expect(host.textContent).toContain('`thinking')
})

it('appends to a paragraph, closes code, resolves a late reference and preserves stable blocks', async () => {
  const prefix = 'stable\n\n```ts\nfixed code\n```\n\n'
  await render(`${prefix}[doc][ref]`)
  const paragraph = host.querySelector('p')
  const pre = host.querySelector('pre')
  const copy = host.querySelector('.code-copy')
  await render(`${prefix}[doc][ref]\n\n[ref]: https://example.test/docs`)
  expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.test/docs')
  expect(host.querySelector('p')).toBe(paragraph)
  expect(host.querySelector('pre')).toBe(pre)
  expect(host.querySelector('.code-copy')).toBe(copy)
  await render(`${prefix}[doc][ref]\n\n[ref]: https://example.test/docs\n\ntail`)
  const tail = host.querySelector('p:last-child')
  await render(`${prefix}[doc][ref]\n\n[ref]: https://example.test/docs\n\ntail added`)
  expect(host.querySelector('p:last-child')).toBe(tail)
  expect(tail?.textContent).toBe('tail added')
  await render('```ts\nnew code')
  expect(host.querySelector('pre code')?.textContent).toContain('new code')
  await render('```ts\nnew code\n```', false)
  expect(host.querySelector('pre code')?.textContent).toBe('new code\n')
  expect(host.querySelector('.code-copy')).not.toBeNull()
})

it('retains a stable code control and its feedback when an earlier reference changes inline structure', async () => {
  const source = '[doc][ref]\n\n```ts\nfixed code\n```'
  const onCopy = vi.fn().mockResolvedValue(undefined)
  await render(source, true, { onCopy })
  const pre = host.querySelector('pre')
  const copy = host.querySelector<HTMLButtonElement>('.code-copy')
  await act(async () => copy?.click())
  expect(copy?.textContent).toBe('已复制')
  await render(`${source}\n\n[ref]: https://example.test/docs`, true, { onCopy })
  expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.test/docs')
  expect(host.querySelector('pre')).toBe(pre)
  expect(host.querySelector('.code-copy')).toBe(copy)
  expect(copy?.textContent).toBe('已复制')
})

it('holds selected DOM across deltas and terminal replacement, then flushes only the latest snapshot', async () => {
  await render('stable\n\nselected tail')
  const stable = host.querySelector('p')
  const tail = host.querySelector('p:last-child')
  const selection = select(tail ?? host)
  await render('stable\n\nselected tail extended')
  await render('stable\n\nfinal **answer**', false)
  expect(host.querySelector('p:last-child')).toBe(tail)
  expect(selection?.toString()).toBe('selected tail')
  expect(host.textContent).not.toContain('answer')
  await act(async () => {
    selection?.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
  })
  expect(host.querySelector('p')).toBe(stable)
  expect(host.querySelector('strong')?.textContent).toBe('answer')
  expect(host.textContent).not.toContain('extended')
})

it('keeps focused copy, displayed code and feedback until blur even at terminal replacement', async () => {
  const onCopy = vi.fn().mockResolvedValue(undefined)
  await render('```\nold code\n```', true, { onCopy })
  const copy = host.querySelector<HTMLButtonElement>('.code-copy')
  await act(async () => {
    copy?.focus()
    copy?.click()
  })
  await render('```\nintermediate code\n```', true, { onCopy })
  await render('```\nnew code\n```', false, { onCopy })
  expect(host.querySelector('.code-copy')).toBe(copy)
  expect(document.activeElement).toBe(copy)
  expect(host.querySelector('pre code')?.textContent).toBe('old code\n')
  expect(copy?.textContent).toBe('已复制')
  await act(async () => copy?.click())
  expect(onCopy).toHaveBeenLastCalledWith('old code')
  await act(async () => {
    copy?.blur()
    await Promise.resolve()
  })
  expect(host.querySelector('pre code')?.textContent).toBe('new code\n')
  expect(host.querySelector('.code-copy')).toBe(copy)
})

it('replaces divergent recovery snapshots, ignores repeats, clears content and flushes terminal caches', async () => {
  await render('first **pending')
  await render('recovered [pending')
  expect(host.textContent).not.toContain('first')
  await render('recovered [pending', false)
  const paragraph = host.querySelector('p')
  expect(host.querySelector('p')?.textContent).toBe('recovered [pending')
  await render('recovered [pending', false)
  expect(host.querySelector('p')).toBe(paragraph)
  await render('')
  expect(host.textContent).toBe('')
  await render('next request', true)
  expect(host.querySelector('p')?.textContent).toBe('next request')
})

it('removes pending interaction listeners and ignores queued focus release after unmount', async () => {
  const add = vi.spyOn(document, 'addEventListener')
  const remove = vi.spyOn(document, 'removeEventListener')
  await render('```\nold\n```')
  const copy = host.querySelector<HTMLButtonElement>('.code-copy')
  await act(async () => copy?.focus())
  await render('pending [tail')
  expect(add.mock.calls.some(([type]) => type === 'selectionchange')).toBe(true)
  await act(async () => {
    copy?.blur()
    root.unmount()
    await Promise.resolve()
  })
  for (const [type, listener] of add.mock.calls.filter(([type]) =>
    ['selectionchange', 'pointerup', 'keyup', 'focusout'].includes(type),
  )) {
    expect(
      remove.mock.calls.some(
        ([removedType, removedListener]) => removedType === type && removedListener === listener,
      ),
    ).toBe(true)
  }
  document.dispatchEvent(new Event('selectionchange'))
  expect(host.textContent).toBe('')
  root = createRoot(host)
})

it('keeps readers in one Markdown part from blocking the other part', async () => {
  const update = async (body: string, thinking: string) =>
    act(async () =>
      root.render(
        createElement(
          'section',
          null,
          createElement(ConversationMarkdown, { source: body, streaming: true, part: 'body' }),
          createElement(ConversationMarkdown, { source: thinking, streaming: true, part: 'thinking' }),
        ),
      ),
    )
  await update('selected body', 'thought')
  const body = host.querySelector('[data-conversation-markdown="body"] p')
  const selection = select(body ?? host)
  await update('latest body', 'latest **thought**')
  expect(body?.textContent).toBe('selected body')
  expect(host.querySelector('[data-conversation-markdown="thinking"] strong')?.textContent).toBe('thought')
  expect(selection?.toString()).toBe('selected body')
  await act(async () => {
    selection?.removeAllRanges()
    document.dispatchEvent(new Event('keyup'))
  })
  expect(host.querySelector('[data-conversation-markdown="body"] p')?.textContent).toBe('latest body')
})

it('keeps copy controls mounted when injected callbacks change and rejects literal key attributes', async () => {
  const first = vi.fn().mockResolvedValue(undefined)
  const next = vi.fn().mockResolvedValue(undefined)
  const source = '<pre key="forged">literal</pre>\n\n```\ncode\n```'
  await render(source, false, { onCopy: first })
  const copy = host.querySelector<HTMLButtonElement>('.code-copy')
  await render(source, false, { onCopy: next })
  expect(host.querySelector('.code-copy')).toBe(copy)
  await act(async () => copy?.click())
  expect(next).toHaveBeenCalledWith('code')
  expect(first).not.toHaveBeenCalled()
  expect(host.querySelectorAll('pre')).toHaveLength(1)
  expect(host.textContent).toContain('<pre key="forged">literal</pre>')
})

it('does not turn streamed escaped tags or code literals into links or images', async () => {
  const prefix = 'stable\n\n\\<img src="https://example.test/'
  await render(prefix)
  expect(host.querySelector('p')?.textContent).toBe('stable')
  expect(host.querySelector('img,a')).toBeNull()
  await render(`${prefix}literal.png">\n\n\`\`\`txt\n[ref]: https://example.test/code`)
  expect(host.querySelector('img,a')).toBeNull()
  expect(host.textContent).toContain('<img src="https://example.test/literal.png">')
  expect(host.querySelector('pre code')?.textContent).toContain('[ref]: https://example.test/code')
  await render(`${prefix}literal.png">\n\n\`\`\`txt\n[ref]: https://example.test/code\n\`\`\``, false)
  expect(host.querySelector('pre code')?.textContent).toBe('[ref]: https://example.test/code\n')
})
