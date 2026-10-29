import { useEffect, useRef } from 'react'

/** Served by the web server as an opaque-origin document with its own policy; see its module. */
export const HTML_PREVIEW_FRAME = '/__agnes/deliverable-preview'

/**
 * A page the model wrote runs in its own sandboxed document (`allow-scripts`, never
 * `allow-same-origin`) and is handed its text once, by message. Deliverables and workspace files
 * share this one renderer, so the policy that keeps the page away from the workbench is the same.
 */
export function HtmlPreviewFrame({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    const ready = (event: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (!target || event.source !== target || event.data?.type !== 'agnes-preview-ready') return
      // The frame's origin is opaque, so there is no origin to name; the source check above binds it.
      target.postMessage({ type: 'agnes-preview-html', html }, '*')
    }
    window.addEventListener('message', ready)
    return () => window.removeEventListener('message', ready)
  }, [html])
  return (
    <section data-document-preview="html" aria-label={title}>
      <iframe
        ref={frame}
        src={HTML_PREVIEW_FRAME}
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
    </section>
  )
}
