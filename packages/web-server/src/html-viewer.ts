import { createHash } from 'node:crypto'

/**
 * Read-only address of the sandboxed viewer for renderer-generated HTML. The page frames it with
 * `sandbox="allow-scripts"` and never `allow-same-origin`, then posts the content in one message.
 * The document is served over HTTP rather than as srcdoc or blob so that its own response policy
 * applies: a local-scheme document would inherit the page policy, which blocks inline content.
 */
export const HTML_VIEWER_PATH = '/__agnes/viewer/html'

// Runs inside the opaque-origin frame. It does nothing when opened as a top-level page. Otherwise
// it accepts the first well-formed message whose source is the embedding window and whose origin is
// the origin that served this document, stops listening, and replaces this document with the posted
// content. There is no outbound channel. The string holds no backslash or template placeholder, so
// the served script body is exactly these bytes and the hash below covers them.
const BOOTSTRAP = `(() => {
  if (window.parent === window) return
  const own = new URL(location.href)
  const scripts = own.searchParams.get('scripts') === '1'
  const tokenName = /^--agnes-[a-z0-9-]{1,64}$/
  const valid = (data) =>
    data !== null && typeof data === 'object' && data.kind === 'agnes.html-viewer/v1' &&
    typeof data.html === 'string' && typeof data.lang === 'string' && /^[A-Za-z0-9-]{0,35}$/.test(data.lang) &&
    (data.colorScheme === 'light' || data.colorScheme === 'dark') &&
    data.tokens !== null && typeof data.tokens === 'object' &&
    Object.entries(data.tokens).every(([name, value]) =>
      tokenName.test(name) && typeof value === 'string' && value.length <= 256 && !/[;{}]/.test(value))
  const receive = (event) => {
    if (event.source !== window.parent || event.origin !== own.origin || !valid(event.data)) return
    window.removeEventListener('message', receive)
    const { html, lang, colorScheme, tokens } = event.data
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    for (const node of parsed.querySelectorAll('base, meta[http-equiv], link')) node.remove()
    const root = parsed.documentElement
    for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value)
    root.style.setProperty('color-scheme', colorScheme)
    if (lang) root.setAttribute('lang', lang)
    window.addEventListener('click', (click) => {
      const link = click.target && click.target.closest ? click.target.closest('a, area') : null
      if (link && !(link.getAttribute('href') || '').startsWith('#')) click.preventDefault()
    }, true)
    document.documentElement.remove()
    document.append(document.adoptNode(root))
    if (!scripts) return
    for (const parsedScript of document.querySelectorAll('script')) {
      const script = document.createElement('script')
      for (const attribute of parsedScript.attributes) script.setAttribute(attribute.name, attribute.value)
      script.textContent = parsedScript.textContent
      parsedScript.replaceWith(script)
    }
  }
  window.addEventListener('message', receive)
})()`

export const HTML_VIEWER_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><title></title></head><body><script>${BOOTSTRAP}</script></body></html>`

const BOOTSTRAP_HASH = createHash('sha256').update(BOOTSTRAP, 'utf8').digest('base64')

/**
 * Headers for one viewer variant. The page policy is untouched; this policy belongs to the viewer
 * document alone. `sandbox` keeps it in an opaque origin even when opened directly, and everything
 * except `data:` resources is refused, including every connection.
 *
 * With `scripts`, script-src is `'unsafe-inline'` without a hash (a hash makes browsers ignore
 * `'unsafe-inline'`) and without `'self'` (so content cannot load `/vendor` or `/plugins`). Such
 * scripts still reach no network, storage, cookie or parent page, but they can navigate the frame
 * itself to an external URL and can send what the frame shows out over WebRTC or DNS. No policy or
 * sandbox flag blocks those two; the page removes a frame that navigates only after it has left.
 */
export function htmlViewerHeaders(scripts: boolean): Record<string, string> {
  const script = scripts ? "'unsafe-inline'" : `'sha256-${BOOTSTRAP_HASH}'`
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `sandbox allow-scripts; default-src 'none'; script-src ${script}; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-DNS-Prefetch-Control': 'off',
    'Permissions-Policy':
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), clipboard-read=()',
  }
}
