import { RuntimeClientTransportPolicy } from '@agnes/protocol/gen/runtime-client-transport'
import { useEffect, useRef, useState } from 'react'
import { fallbackT, type Translate } from '../locales/index.js'

/**
 * Internal mirror of the proposed `HtmlViewerRequest` wire type. The generated wire type replaces
 * it, so it stays out of the package entry.
 */
export type HtmlViewerRequest = Readonly<{
  /** The document itself, at most `MAX_RANGE_BYTES` UTF-8 bytes. Never a URL or a reference. */
  html: string
  /** The frame's accessible name: 1 to 256 UTF-8 bytes. */
  title: string
  /** Frame height in CSS pixels, an integer from 64 to 4096. The content scrolls inside it. */
  height: number
  /**
   * Run the content's inline scripts. Refused unless the host policy allows it. Such scripts get
   * no network, storage, cookie or parent page, but they can navigate the frame itself to an
   * external URL and can send what the frame shows out over WebRTC or DNS: no browser primitive
   * blocks those two, and the host removes a navigated frame only after the request has left.
   */
  scripts: boolean
}>

/** Why a request is refused: it breaks the request shape, or it asks for scripts the host does not allow. */
export type HtmlViewerRefusal = 'invalid_request' | 'scripts_not_allowed'

export interface HtmlViewerProps {
  readonly request: HtmlViewerRequest
  /** Same-origin address of the viewer document, supplied by the host. */
  readonly viewerUrl: string
  /** Host policy for `request.scripts`. Defaults to false, which refuses a request for scripts. */
  readonly allowScripts?: boolean
  /** BCP 47 language of the content; anything else is left out. */
  readonly lang?: string
  /** Called when the frame leaves the viewer document; the frame is removed at the same time. */
  readonly onNavigatedAway?: () => void
  readonly t?: Translate
}

const REQUEST_KEYS = ['html', 'title', 'height', 'scripts']
// The general semantic tokens of the page theme. Only these names cross into the frame, and only
// with a short value that cannot close a declaration or a block.
const THEME_TOKENS = [
  '--agnes-brand-primary',
  '--agnes-text-primary',
  '--agnes-text-secondary',
  '--agnes-text-tertiary',
  '--agnes-text-emphasis',
  '--agnes-bg-page',
  '--agnes-bg-surface',
  '--agnes-bg-card',
  '--agnes-bg-code',
  '--agnes-line-primary',
  '--agnes-line-emphasis',
  '--agnes-status-success-text',
  '--agnes-status-success-bg',
  '--agnes-status-warning-text',
  '--agnes-status-warning-bg',
  '--agnes-status-danger-text',
  '--agnes-status-danger-bg',
  '--agnes-status-info-text',
]

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length

/** The refusal for a request, or undefined when it may be shown. `allowScripts` is the host policy. */
export function htmlViewerRefusal(request: unknown, allowScripts: boolean): HtmlViewerRefusal | undefined {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return 'invalid_request'
  const fields = request as Record<string, unknown>
  const { html, title, height, scripts } = fields
  if (
    Object.keys(fields).length !== REQUEST_KEYS.length ||
    !REQUEST_KEYS.every((key) => Object.hasOwn(fields, key)) ||
    typeof html !== 'string' ||
    utf8Bytes(html) > RuntimeClientTransportPolicy.maxRangeBytes ||
    typeof title !== 'string' ||
    title.length === 0 ||
    utf8Bytes(title) > 256 ||
    typeof height !== 'number' ||
    !Number.isInteger(height) ||
    height < 64 ||
    height > 4096 ||
    typeof scripts !== 'boolean'
  )
    return 'invalid_request'
  return scripts && !allowScripts ? 'scripts_not_allowed' : undefined
}

function themeTokens(element: Element): Record<string, string> {
  const style = getComputedStyle(element)
  const tokens: Record<string, string> = {}
  for (const name of THEME_TOKENS) {
    const value = style.getPropertyValue(name).trim()
    if (value && utf8Bytes(value) <= 256 && !/[;{}]/.test(value)) tokens[name] = value
  }
  return tokens
}

const colorScheme = (): 'light' | 'dark' =>
  document.documentElement.classList.contains('dark') ? 'dark' : 'light'

/**
 * Shows renderer-generated HTML in the sandboxed viewer frame. The frame has an opaque origin, gets
 * the content once on its first load, and has no channel back. A second load means the frame left
 * the viewer document, so it is removed until the content changes. A theme switch or new content
 * mounts a fresh frame: the viewer takes one message only, and a new address for a live frame would
 * read as navigation.
 */
export function HtmlViewer({
  request,
  viewerUrl,
  allowScripts = false,
  lang = '',
  onNavigatedAway,
  t = fallbackT,
}: HtmlViewerProps) {
  const [scheme, setScheme] = useState(colorScheme)
  const refusal = htmlViewerRefusal(request, allowScripts)
  const html = refusal === 'invalid_request' ? undefined : request.html
  // Each new content counts one mount, which keys its frame in place of the content itself.
  const [content, setContent] = useState({ html, mount: 0, navigated: false })
  if (content.html !== html) setContent({ html, mount: content.mount + 1, navigated: false })
  const loaded = useRef(new WeakSet<HTMLIFrameElement>())
  useEffect(() => {
    const observer = new MutationObserver(() => setScheme(colorScheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    setScheme(colorScheme())
    return () => observer.disconnect()
  }, [])
  if (refusal || content.navigated)
    return (
      <p className="html-viewer-notice" role="alert" data-html-viewer-refused={refusal ?? 'navigated'}>
        {t(refusal ? 'htmlViewer.unavailable' : 'htmlViewer.navigated')}
      </p>
    )
  const src = `${viewerUrl}?scripts=${request.scripts ? 1 : 0}`
  const contentLang = /^[A-Za-z0-9-]{1,35}$/.test(lang) ? lang : ''
  return (
    <iframe
      key={`${scheme} ${src} ${contentLang} ${content.mount}`}
      src={src}
      sandbox="allow-scripts"
      allow=""
      referrerPolicy="no-referrer"
      loading="lazy"
      title={request.title}
      style={{ display: 'block', width: '100%', height: request.height, border: 0 }}
      onLoad={(event) => {
        const frame = event.currentTarget
        if (loaded.current.has(frame)) {
          setContent((current) => ({ ...current, navigated: true }))
          onNavigatedAway?.()
          return
        }
        loaded.current.add(frame)
        // An opaque origin cannot be named as a target. The first load is still the viewer document.
        frame.contentWindow?.postMessage(
          {
            kind: 'agnes.html-viewer/v1',
            html: request.html,
            lang: contentLang,
            colorScheme: scheme,
            tokens: themeTokens(frame.parentElement ?? frame),
          },
          '*',
        )
      }}
    />
  )
}
