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

/** Input constraint only. The consumer must obtain this URL from its resource service. */
export function documentResourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value, globalThis.location?.href)
    return url.protocol === 'blob:' ? url.href : undefined
  } catch {
    return undefined
  }
}
