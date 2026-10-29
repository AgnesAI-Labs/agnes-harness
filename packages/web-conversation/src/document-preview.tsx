import type { LocaleVars } from '@agnes/web-client'
import { createRegionRenderer } from '@agnes/web-ui'
import { DocumentPreview, type DocumentPreviewInput, documentResourceUrl } from '@agnes/web-ui/conversation'
import { flushSync } from 'react-dom'

export type { DocumentPreviewInput, DocumentPreviewKind } from '@agnes/web-ui/conversation'
export { sanitizeDocumentHtml } from '@agnes/web-ui/conversation'

export interface DocumentPreviewRenderer {
  update(input: DocumentPreviewInput): void
  dispose(): void
}

/** Synchronous facade; the consumer retains resource acquisition and object URL ownership. */
export function createDocumentPreview(
  element: HTMLElement,
  initial: DocumentPreviewInput,
  t: (key: string, vars?: LocaleVars) => string = (key) => key,
): DocumentPreviewRenderer {
  const root = createRegionRenderer(element)
  let disposed = false
  const apply = (input: DocumentPreviewInput): void => {
    if (disposed) return
    element.dataset.documentPreview = input.kind
    if (input.title) element.setAttribute('aria-label', input.title)
    else element.removeAttribute('aria-label')
    // The compatibility host has always reported a missing resource as unauthorized.
    const unavailable =
      (input.kind === 'image' || input.kind === 'pdf') && !documentResourceUrl(input.resourceUrl)
        ? t('doc.preview.unavailable', {
            kind: t(input.kind === 'image' ? 'doc.kind.image' : 'doc.kind.pdf'),
            reason: t('doc.reason.unauthorized'),
          })
        : undefined
    if (unavailable) element.dataset.previewError = unavailable
    else element.removeAttribute('data-preview-error')
    flushSync(() =>
      root.render(
        <DocumentPreview
          {...input}
          t={(key, vars) => (key === 'doc.reason.unavailable' ? t('doc.reason.unauthorized') : t(key, vars))}
        />,
      ),
    )
  }
  apply(initial)
  return {
    update: apply,
    dispose() {
      if (disposed) return
      disposed = true
      flushSync(() => root.unmount())
      element.removeAttribute('data-preview-error')
    },
  }
}
