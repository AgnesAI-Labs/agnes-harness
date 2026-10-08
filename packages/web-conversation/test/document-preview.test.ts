/** @vitest-environment happy-dom */

import { zhT } from '@agnes/web-foundation/testkit/locale'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDocumentPreview, sanitizeDocumentHtml } from '../src/document-preview.js'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function host(): HTMLElement {
  const element = document.createElement('div')
  document.body.append(element)
  return element
}

describe('DSH document preview renderers', () => {
  it('preserves the synchronous update/dispose contract and makes retired updates inert', () => {
    const element = host()
    const preview = createDocumentPreview(element, { kind: 'markdown', title: 'old', content: '# old' }, zhT)
    expect(element.querySelector('h1')?.textContent).toBe('old')
    preview.update({ kind: 'html', content: '<p>new</p><a href="data:text/html,evil">literal</a>' })
    expect(element.textContent).toBe('newliteral')
    expect(element.querySelector('h1, a[href]')).toBeNull()
    expect(element.hasAttribute('aria-label')).toBe(false)
    preview.update({ kind: 'text' })
    expect(element.querySelector('pre')?.textContent).toBe('')
    preview.update({ kind: 'code' })
    expect(element.querySelector('code')?.textContent).toBe('')
    preview.update({ kind: 'markdown', content: '**last**' })
    expect(element.querySelector('strong')?.textContent).toBe('last')
    preview.dispose()
    preview.dispose()
    preview.update({ kind: 'image', resourceUrl: 'blob:https://example.test/retired' })
    expect(element.childNodes.length).toBe(0)
    expect(element.hasAttribute('data-preview-error')).toBe(false)
  })

  it('keeps detached HTML fragment semantics and rejects dangerous attributes and URLs', () => {
    const fragment = sanitizeDocumentHtml(
      '<p class="skin" title="safe" aria-label="label" id="clobber" style="url(https://evil.test)" onclick="evil()">one<br>two</p><a href="#good" ping="https://evil.test">three</a><a href="#bad%GG">four</a><object data="https://evil.test">five</object><link rel="stylesheet" href="https://evil.test"><meta http-equiv="refresh" content="0;url=https://evil.test">',
    )
    expect(fragment.nodeType).toBe(Node.DOCUMENT_FRAGMENT_NODE)
    expect(fragment.isConnected).toBe(false)
    const element = host()
    element.append(fragment)
    expect(element.textContent).toBe('onetwothreefourfive')
    expect(element.querySelector('p')?.outerHTML).toBe(
      '<p class="skin" title="safe" aria-label="label">one<br>two</p>',
    )
    expect(element.querySelector('object, link, meta, [id], [style], [onclick], [ping]')).toBeNull()
    expect([...element.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))).toEqual(['#good'])
  })

  it('leaves object URL ownership with the consumer across updates and disposal', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const element = host()
    const preview = createDocumentPreview(
      element,
      {
        kind: 'image',
        resourceUrl: 'blob:https://example.test/one',
      },
      zhT,
    )
    expect(element.querySelector('img')?.getAttribute('alt')).toBe('文档图片')
    preview.update({ kind: 'image', resourceUrl: '' })
    expect(element.querySelector('img')).toBeNull()
    expect(element.dataset.previewError).toBe('图片资源未获授权')
    preview.update({ kind: 'image', resourceUrl: 'blob:https://example.test/two', title: '' })
    expect(element.querySelector('img')?.getAttribute('alt')).toBe('')
    expect(element.hasAttribute('data-preview-error')).toBe(false)
    preview.dispose()
    expect(revoke).not.toHaveBeenCalled()
  })
  it('sanitizes HTML before it reaches the live DOM', () => {
    const fragment = sanitizeDocumentHtml(
      '<h2>安全标题</h2><script>window.pwned = true</script><img src="https://evil.test/a.png"><a href="https://evil.test">外链</a><a href="#notes">页内</a><button onclick="alert(1)">按钮</button>',
    )
    const element = host()
    element.append(fragment)

    expect(element.querySelector('script')).toBeNull()
    expect(element.querySelector('img')).toBeNull()
    expect(element.querySelector('button')).toBeNull()
    expect(element.querySelector('a[href^="http"]')).toBeNull()
    expect(element.querySelector('a[href="#notes"]')?.textContent).toBe('页内')
    expect(element.textContent).toContain('安全标题')
  })

  it('covers text, markdown, code and controlled resource renderer keys', () => {
    const element = host()
    const preview = createDocumentPreview(element, { kind: 'text', content: 'plain' }, zhT)
    expect(element.querySelector('pre')?.textContent).toBe('plain')

    preview.update({ kind: 'markdown', content: '# 标题' })
    expect(element.querySelector('h1')?.textContent).toBe('标题')
    preview.update({ kind: 'code', content: '<script>literal</script>' })
    expect(element.querySelector('code')?.textContent).toContain('<script>')
    expect(element.querySelector('script')).toBeNull()

    preview.update({ kind: 'image', resourceUrl: 'https://evil.test/image.png' })
    expect(element.querySelector('img')).toBeNull()
    expect(element.dataset.previewError).toBe('图片资源未获授权')
    preview.update({ kind: 'image', title: '截图', resourceUrl: 'blob:https://example.test/image-1' })
    expect(element.querySelector<HTMLImageElement>('img')?.src).toBe('blob:https://example.test/image-1')
    const pdfElement = document.createElement('div')
    const pdfPreview = createDocumentPreview(
      pdfElement,
      {
        kind: 'pdf',
        resourceUrl: 'blob:https://example.test/document-1',
      },
      zhT,
    )
    expect(pdfElement.querySelector<HTMLIFrameElement>('iframe')?.sandbox.value).toBe('')
    pdfPreview.dispose()
    preview.dispose()
    expect(element.childElementCount).toBe(0)
  })
})
