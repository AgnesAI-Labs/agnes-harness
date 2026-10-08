import type { LocaleVars } from '@agnes/web-client'
import {
  type DocumentPreviewInput,
  documentResourceUrl,
  sanitizeDocumentHtml,
} from '@agnes/web-ui/assistant-ui'
import { createMarkdownRenderer, type MarkdownRenderer } from './markdown.js'

export type { DocumentPreviewInput, DocumentPreviewKind } from '@agnes/web-ui/assistant-ui'
export { sanitizeDocumentHtml } from '@agnes/web-ui/assistant-ui'

export interface DocumentPreviewRenderer {
  update(input: DocumentPreviewInput): void
  dispose(): void
}

function clear(element: HTMLElement): void {
  element.replaceChildren()
  element.removeAttribute('data-preview-error')
}

function unavailable(element: HTMLElement, message: string): void {
  element.dataset.previewError = message
  const fallback = document.createElement('p')
  fallback.className = 'document-preview-unavailable'
  fallback.textContent = message
  element.append(fallback)
}

function renderInput(
  element: HTMLElement,
  input: DocumentPreviewInput,
  t: (key: string, vars?: LocaleVars) => string,
): MarkdownRenderer | undefined {
  clear(element)
  element.dataset.documentPreview = input.kind
  if (input.title) element.setAttribute('aria-label', input.title)
  else element.removeAttribute('aria-label')

  switch (input.kind) {
    case 'text': {
      const pre = document.createElement('pre')
      pre.textContent = input.content ?? ''
      element.append(pre)
      return undefined
    }
    case 'code': {
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      code.textContent = input.content ?? ''
      pre.append(code)
      element.append(pre)
      return undefined
    }
    case 'markdown':
      return createMarkdownRenderer(element, input.content ?? '')
    case 'html':
      element.append(sanitizeDocumentHtml(input.content ?? ''))
      return undefined
    case 'image': {
      const url = documentResourceUrl(input.resourceUrl)
      if (!url) {
        unavailable(
          element,
          t('doc.preview.unavailable', { kind: t('doc.kind.image'), reason: t('doc.reason.unauthorized') }),
        )
        return undefined
      }
      const image = document.createElement('img')
      image.src = url
      image.alt = input.title ?? t('doc.imageFallback')
      image.decoding = 'async'
      element.append(image)
      return undefined
    }
    case 'pdf': {
      const url = documentResourceUrl(input.resourceUrl)
      if (!url) {
        unavailable(
          element,
          t('doc.preview.unavailable', { kind: t('doc.kind.pdf'), reason: t('doc.reason.unauthorized') }),
        )
        return undefined
      }
      const frame = document.createElement('iframe')
      frame.src = url
      frame.title = input.title ?? t('doc.pdfFallback')
      frame.setAttribute('sandbox', '')
      element.append(frame)
      return undefined
    }
  }
}

/**
 * Synchronous compatibility facade for an exclusively owned DOM container.
 * React consumers render DocumentPreview in their parent tree instead of calling this in a lifecycle.
 */
export function createDocumentPreview(
  element: HTMLElement,
  initial: DocumentPreviewInput,
  t: (key: string, vars?: LocaleVars) => string = (key) => key,
): DocumentPreviewRenderer {
  let markdown: MarkdownRenderer | undefined
  let disposed = false
  const apply = (input: DocumentPreviewInput): void => {
    if (disposed) return
    markdown?.dispose()
    markdown = renderInput(element, input, t)
  }
  apply(initial)
  return {
    update(input) {
      apply(input)
    },
    dispose() {
      if (disposed) return
      disposed = true
      markdown?.dispose()
      markdown = undefined
      clear(element)
    },
  }
}
