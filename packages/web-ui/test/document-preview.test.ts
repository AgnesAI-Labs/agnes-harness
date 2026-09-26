/** @vitest-environment happy-dom */

import { DocumentPreview, type DocumentPreviewProps } from '@agnes/web-ui/assistant-ui'
import { act, createElement, StrictMode } from 'react'
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
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function render(props: DocumentPreviewProps) {
  await act(async () => root.render(createElement(DocumentPreview, props)))
}

it('renders literal text and code with stable nodes, empty defaults and removable title', async () => {
  await render({ kind: 'text', title: '预览', content: '<script>literal</script>' })
  const preview = host.querySelector('[data-document-preview]')
  const pre = host.querySelector('pre')
  expect(pre?.textContent).toBe('<script>literal</script>')
  expect(preview?.getAttribute('aria-label')).toBe('预览')
  expect(host.querySelector('script')).toBeNull()
  await render({ kind: 'text' })
  expect(host.querySelector('pre')).toBe(pre)
  expect(pre?.textContent).toBe('')
  expect(preview?.hasAttribute('aria-label')).toBe(false)
  await render({ kind: 'code', content: '<img src="https://evil.test">' })
  const code = host.querySelector('code')
  expect(code?.textContent).toBe('<img src="https://evil.test">')
  expect(host.querySelector('img')).toBeNull()
  await render({ kind: 'code' })
  expect(host.querySelector('code')).toBe(code)
  expect(code?.textContent).toBe('')
})

it('renders only the existing HTML allowlist, preserving order, table attributes and safe fragments', async () => {
  await render({
    kind: 'html',
    content:
      '<h2 class="heading" title="标题" aria-label="节标题">一</h2><p style="color:red" onclick="evil()">二 <em>强调</em></p><table><tbody><tr><th scope="row" colspan="2" rowspan="3">三</th></tr></tbody></table><a href="#notes">四</a><a href="#bad%GG">五</a><a href="#' +
      'x'.repeat(256) +
      '">六</a><script>script literal</script><svg><a href="https://evil.test">svg literal</a></svg><iframe src="https://evil.test"></iframe><img srcset="https://evil.test" src="https://evil.test"><form><input name="x"></form><a href="javascript:evil()">七</a><a href="data:text/html,evil">八</a>',
  })
  expect(host.querySelector('h2')?.outerHTML).toBe(
    '<h2 class="heading" title="标题" aria-label="节标题">一</h2>',
  )
  expect(host.querySelector('th')?.outerHTML).toBe('<th scope="row" colspan="2" rowspan="3">三</th>')
  expect(host.textContent).toBe('一二 强调三四五六script literalsvg literal七八')
  expect(host.querySelector('script, svg, iframe, img, form, input, [style], [onclick]')).toBeNull()
  expect([...host.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))).toEqual(['#notes'])
  await render({ kind: 'html' })
  expect(host.querySelector('[data-document-preview]')?.childNodes.length).toBe(0)
})

it.each(['image', 'pdf'] as const)(
  'rejects remote, relative and active %s URLs without creating a loading element',
  async (kind) => {
    for (const resourceUrl of [
      'https://evil.test/file',
      '//evil.test/file',
      '/file',
      'data:text/html,evil',
      'javascript:evil()',
      'file:///tmp/a',
      'not a url',
    ]) {
      await render({ kind, resourceUrl })
      expect(host.querySelector('img, iframe')).toBeNull()
      expect(host.querySelector('[data-preview-error]')?.getAttribute('data-preview-error')).toBe(
        kind === 'image' ? '图片资源未获授权' : 'PDF 资源未获授权',
      )
    }
  },
)

it.each(['image', 'pdf'] as const)(
  'distinguishes missing %s resources and displays delivered object URLs with stable elements',
  async (kind) => {
    // Happy DOM cannot navigate blob iframe URLs; inspect the actual PDF DOM in a detached host.
    if (kind === 'pdf') host.remove()
    for (const resourceUrl of [undefined, '']) {
      await render({ kind, ...(resourceUrl === undefined ? {} : { resourceUrl }) })
      expect(host.querySelector('.document-preview-unavailable')?.textContent).toBe(
        kind === 'image' ? '图片资源不可用' : 'PDF 资源不可用',
      )
      expect(host.querySelector('img, iframe')).toBeNull()
    }
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    await render({ kind, title: '文档', resourceUrl: 'blob:https://example.test/one' })
    const element = host.querySelector('img, iframe')
    expect(element?.getAttribute('src')).toBe('blob:https://example.test/one')
    expect(element?.getAttribute(kind === 'image' ? 'alt' : 'title')).toBe('文档')
    if (kind === 'pdf') expect(element?.getAttribute('sandbox')).toBe('')
    else expect(element?.getAttribute('decoding')).toBe('async')
    expect(host.querySelector('[data-preview-error]')).toBeNull()
    await render({ kind, resourceUrl: 'blob:https://example.test/two' })
    expect(host.querySelector('img, iframe')).toBe(element)
    expect(element?.getAttribute('src')).toBe('blob:https://example.test/two')
    expect(element?.getAttribute(kind === 'image' ? 'alt' : 'title')).toBe(
      kind === 'image' ? '文档图片' : 'PDF 文档',
    )
    await render({ kind: 'text', content: 'next' })
    expect(host.textContent).toBe('next')
    expect(revoke).not.toHaveBeenCalled()
  },
)

it('uses real static Markdown with stable copy controls, safe links, theme and injected callbacks', async () => {
  const onCopy = vi.fn(async () => {})
  const onFragment = vi.fn()
  const source =
    '# 标题\n\n[页内](#notes) ![alt](https://evil.test/image) [bad](javascript:evil())\n\n```ts\nconst x = 1\n```'
  await render({ kind: 'markdown', content: source, theme: 'dark', onCopy, onFragment })
  expect(host.querySelector('h1')?.textContent).toBe('标题')
  expect(host.querySelector('img')).toBeNull()
  expect(host.querySelector('.x-markdown-dark')).not.toBeNull()
  expect([...host.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['#notes'])
  const button = host.querySelector<HTMLButtonElement>('.code-copy')
  expect(button).not.toBeNull()
  button?.focus()
  await render({
    kind: 'markdown',
    title: 'new',
    content: `${source}\n\n末尾`,
    theme: 'dark',
    onCopy,
    onFragment,
  })
  expect(host.querySelector('.code-copy')).toBe(button)
  expect(document.activeElement).toBe(button)
  await act(async () => button?.click())
  expect(onCopy).toHaveBeenCalledWith('const x = 1')
  await act(async () => button?.blur())
  expect(host.textContent).toContain('末尾')
  await act(async () => host.querySelector<HTMLAnchorElement>('a')?.click())
  expect(onFragment).toHaveBeenCalledWith('notes')
  await render({ kind: 'markdown' })
  expect(host.textContent).toBe('')
})

it('keeps one React DOM owner through strict mount, parent replacement and return without lifecycle warnings', async () => {
  const errors = vi.spyOn(console, 'error')
  function Parent({ show }: { show: boolean }) {
    return show
      ? createElement(DocumentPreview, { kind: 'markdown', content: '# owned' })
      : createElement('strong', null, 'replacement')
  }
  for (const show of [true, false, true, false]) {
    await act(async () => root.render(createElement(StrictMode, null, createElement(Parent, { show }))))
    expect(host.textContent).toBe(show ? 'owned\n' : 'replacement')
  }
  expect(errors.mock.calls).toEqual([])
})

it('retires Markdown copy work and ignores its late completion after format replacement', async () => {
  vi.useFakeTimers()
  let complete: (() => void) | undefined
  const onCopy = () =>
    new Promise<void>((resolve) => {
      complete = resolve
    })
  await render({ kind: 'markdown', content: '```\nold\n```', onCopy })
  const button = host.querySelector<HTMLButtonElement>('.code-copy')
  expect(button).not.toBeNull()
  await act(async () => button?.click())
  await render({ kind: 'text', content: 'new' })
  const timers = vi.getTimerCount()
  await act(async () => complete?.())
  expect(host.textContent).toBe('new')
  expect(vi.getTimerCount()).toBe(timers)
})
