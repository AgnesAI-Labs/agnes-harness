/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it } from 'vitest'
import { createDocumentPreview, sanitizeDocumentHtml } from '../src/document-preview.js'

afterEach(() => document.body.replaceChildren())

function host(): HTMLElement {
  const element = document.createElement('div')
  document.body.append(element)
  return element
}

describe('DSH document preview renderers', () => {
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
    const preview = createDocumentPreview(element, { kind: 'text', content: 'plain' })
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
    const pdfPreview = createDocumentPreview(pdfElement, {
      kind: 'pdf',
      resourceUrl: 'blob:https://example.test/document-1',
    })
    expect(pdfElement.querySelector<HTMLIFrameElement>('iframe')?.sandbox.value).toBe('')
    pdfPreview.dispose()
    preview.dispose()
    expect(element.childElementCount).toBe(0)
  })
})
