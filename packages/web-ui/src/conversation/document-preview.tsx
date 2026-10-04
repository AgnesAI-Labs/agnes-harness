import { createElement, type ReactNode, useMemo } from 'react'
import { fallbackT, type Translate } from '../locales/index.js'
import { documentResourceUrl, sanitizeDocumentHtml } from './document-preview-policy.js'
import { ConversationMarkdown } from './markdown.js'

export type DocumentPreviewKind = 'text' | 'markdown' | 'html' | 'image' | 'pdf' | 'code'

export interface DocumentPreviewInput {
  readonly kind: DocumentPreviewKind
  readonly title?: string
  readonly content?: string
  /** The consumer supplies a resource-service object URL; scheme checks do not prove provenance. */
  readonly resourceUrl?: string
}

export interface DocumentPreviewProps extends DocumentPreviewInput {
  theme?: 'light' | 'dark'
  onCopy?: ((text: string) => Promise<void>) | undefined
  onFragment?: ((id: string) => void) | undefined
  /** Locale-bound translate injected by the host; render-time lookup only. */
  t?: Translate
}

/** Display only: the consumer owns resource acquisition, authorization and release. */
export function DocumentPreview({
  kind,
  content = '',
  title,
  resourceUrl,
  theme = 'light',
  onCopy,
  onFragment,
  t = fallbackT,
}: DocumentPreviewProps) {
  const html = useMemo(
    () => (kind === 'html' ? htmlNodes(sanitizeDocumentHtml(content)) : undefined),
    [kind, content],
  )
  const url = documentResourceUrl(resourceUrl)
  const unavailable =
    (kind === 'image' || kind === 'pdf') && !url
      ? t('doc.preview.unavailable', {
          kind: t(kind === 'image' ? 'doc.kind.image' : 'doc.kind.pdf'),
          reason: t(resourceUrl ? 'doc.reason.unauthorized' : 'doc.reason.unavailable'),
        })
      : undefined
  let children: ReactNode
  switch (kind) {
    case 'text':
      children = <pre>{content}</pre>
      break
    case 'code':
      children = (
        <pre>
          <code>{content}</code>
        </pre>
      )
      break
    case 'html':
      children = html
      break
    case 'markdown':
      children = content ? (
        <ConversationMarkdown
          source={content}
          part="body"
          syntax="immediate"
          theme={theme}
          onCopy={onCopy}
          onFragment={onFragment}
          t={t}
        />
      ) : undefined
      break
    case 'image':
      children = url ? <img src={url} alt={title ?? t('doc.imageFallback')} decoding="async" /> : undefined
      break
    case 'pdf':
      children = url ? <iframe src={url} title={title ?? t('doc.pdfFallback')} sandbox="" /> : undefined
      break
  }
  return (
    <section data-document-preview={kind} aria-label={title || undefined} data-preview-error={unavailable}>
      {unavailable ? <p className="document-preview-unavailable">{unavailable}</p> : children}
    </section>
  )
}

/** Only the detached sanitizer's allowlisted tree is converted; React owns every live node. */
function htmlNodes(parent: DocumentFragment | HTMLElement): ReactNode[] {
  return Array.from(parent.childNodes, (node, key) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue
    const element = node as HTMLElement
    const props: Record<string, string | number> = { key }
    const names: Record<string, string> = { class: 'className', colspan: 'colSpan', rowspan: 'rowSpan' }
    for (const attribute of Array.from(element.attributes))
      props[names[attribute.name] ?? attribute.name] = attribute.value
    return createElement(element.tagName.toLowerCase(), props, ...htmlNodes(element))
  })
}
