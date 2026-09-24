import { createMarkdownRenderer, type MarkdownRenderer } from './markdown.js'

export type DocumentPreviewKind = 'text' | 'markdown' | 'html' | 'image' | 'pdf' | 'code'

export interface DocumentPreviewInput {
  readonly kind: DocumentPreviewKind
  readonly title?: string
  readonly content?: string
  /** Only object URLs created by an authorized resource service are accepted. */
  readonly resourceUrl?: string
}

export interface DocumentPreviewRenderer {
  update(input: DocumentPreviewInput): void
  dispose(): void
}

const HTML_TAGS = new Set([
  'A',
  'B',
  'BLOCKQUOTE',
  'BR',
  'CODE',
  'DEL',
  'EM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'I',
  'LI',
  'OL',
  'P',
  'PRE',
  'STRONG',
  'TABLE',
  'TBODY',
  'TD',
  'TH',
  'THEAD',
  'TR',
  'UL',
])

const HTML_ATTRIBUTES = new Set(['aria-label', 'class', 'colspan', 'rowspan', 'scope', 'title'])

function safeFragment(value: string): string | undefined {
  if (!value.startsWith('#') || value.length > 256) return undefined
  try {
    decodeURIComponent(value.slice(1))
    return value
  } catch {
    return undefined
  }
}

/**
 * Parse into a detached template, then copy only the allowlisted tree into the result.
 * The source is never assigned to a live element's innerHTML and URL-bearing attributes are
 * removed, so a document cannot create scripts or network fetches in the workbench realm.
 */
export function sanitizeDocumentHtml(source: string): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = source
  const result = document.createDocumentFragment()

  const appendNode = (parent: DocumentFragment | HTMLElement, node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.append(document.createTextNode(node.nodeValue ?? ''))
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const sourceElement = node as HTMLElement
    if (!HTML_TAGS.has(sourceElement.tagName)) {
      if (sourceElement.textContent) parent.append(document.createTextNode(sourceElement.textContent))
      return
    }
    const target = document.createElement(sourceElement.tagName.toLowerCase())
    for (const attribute of Array.from(sourceElement.attributes)) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || name === 'style' || name === 'src' || name === 'srcset') continue
      if (name === 'href') {
        const href = safeFragment(attribute.value)
        if (href) target.setAttribute('href', href)
        continue
      }
      if (HTML_ATTRIBUTES.has(name)) target.setAttribute(name, attribute.value)
    }
    for (const child of Array.from(sourceElement.childNodes)) appendNode(target, child)
    parent.append(target)
  }

  for (const child of Array.from(template.content.childNodes)) appendNode(result, child)
  return result
}

function authorizedResourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value, globalThis.location?.href)
    return url.protocol === 'blob:' ? url.href : undefined
  } catch {
    return undefined
  }
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

function renderInput(element: HTMLElement, input: DocumentPreviewInput): MarkdownRenderer | undefined {
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
      const url = authorizedResourceUrl(input.resourceUrl)
      if (!url) {
        unavailable(element, '图片资源未获授权')
        return undefined
      }
      const image = document.createElement('img')
      image.src = url
      image.alt = input.title ?? '文档图片'
      image.decoding = 'async'
      element.append(image)
      return undefined
    }
    case 'pdf': {
      const url = authorizedResourceUrl(input.resourceUrl)
      if (!url) {
        unavailable(element, 'PDF 资源未获授权')
        return undefined
      }
      const frame = document.createElement('iframe')
      frame.src = url
      frame.title = input.title ?? 'PDF 文档'
      frame.setAttribute('sandbox', '')
      element.append(frame)
      return undefined
    }
  }
}

export function createDocumentPreview(
  element: HTMLElement,
  initial: DocumentPreviewInput,
): DocumentPreviewRenderer {
  let markdown: MarkdownRenderer | undefined
  let disposed = false
  const apply = (input: DocumentPreviewInput): void => {
    if (disposed) return
    markdown?.dispose()
    markdown = renderInput(element, input)
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
