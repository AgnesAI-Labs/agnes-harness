export function loopbackOrigin(value: string): URL {
  let origin: URL
  try {
    origin = new URL(value)
  } catch {
    throw new Error('Web origin must be an exact loopback HTTP origin')
  }
  if (
    origin.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('Web origin must be an exact loopback HTTP origin')
  return origin
}

export function loopbackWs(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('WebSocket endpoint must be a credential-free loopback URL')
  }
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('WebSocket endpoint must be a credential-free loopback URL')
  return url
}

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]']

/**
 * Classify a request's Host for a listener on `listenPort`: `canonical` is the exact page origin's
 * host, `alias` another loopback name for the same port, and `undefined` anything else - including a
 * DNS-rebinding domain that resolves to 127.0.0.1, which must never reach a route.
 */
export function loopbackHost(
  host: string | undefined,
  canonical: string,
  listenPort: number,
): 'canonical' | 'alias' | undefined {
  if (!host) return undefined
  if (host === canonical) return 'canonical'
  let url: URL
  try {
    url = new URL(`http://${host}`)
  } catch {
    return undefined
  }
  return LOOPBACK_NAMES.includes(url.hostname) &&
    url.port === String(listenPort) &&
    url.host === host.toLowerCase()
    ? 'alias'
    : undefined
}

/**
 * Browser-only CSRF floor for every state-changing request: a page on another site can make the
 * browser send a form POST or a no-cors fetch here, and browsers mark it with a foreign `Origin` or
 * `Sec-Fetch-Site`. A request with neither is a local non-browser client, which is the user's own.
 * Routes keep their stricter checks on top.
 */
export function crossSiteWrite(expectedOrigin: string, request: SecurityRequest): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? 'GET')) return false
  const site = request.headers['sec-fetch-site']
  const origin = request.headers.origin
  return (
    (site !== undefined && site !== 'same-origin' && site !== 'none') ||
    (origin !== undefined && origin !== expectedOrigin)
  )
}

export function port(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error('invalid Web port')
  return value
}

type RequestSecurityMode =
  | 'exact-navigation'
  | 'post-origin'
  | 'file-upload'
  | 'history-search'
  | 'webhook-path'
  | 'webhook-admin'
  | 'mount-write'

type SecurityRequest = {
  method?: string | undefined
  url?: string | undefined
  headers: { origin?: string | undefined; 'sec-fetch-site'?: string | string[] | undefined }
}

/** Preserve the routes' distinct browser admission policies; callers own method/error replies. */
export function acceptsWebRequest(
  mode: RequestSecurityMode,
  expectedOrigin: string,
  request: SecurityRequest,
  exactPath?: string,
): boolean {
  // Webhook path refusals precede the administration origin/method checks.
  if (mode === 'webhook-path') return exactPath !== undefined && request.url === exactPath
  const origin = request.headers.origin
  // Picker/plan check this only after their method refusal, unlike upload's initial gate.
  if (mode === 'post-origin') return origin === expectedOrigin
  const rawSite = request.headers['sec-fetch-site']
  const site = mode === 'history-search' && Array.isArray(rawSite) ? rawSite[0] : rawSite
  const strict = mode === 'webhook-admin' || mode === 'mount-write'
  if (
    (site !== undefined && site !== 'same-origin' && (strict || site !== 'none')) ||
    (origin !== undefined && origin !== expectedOrigin)
  )
    return false
  if (strict || (mode === 'file-upload' && request.method === 'POST')) return origin === expectedOrigin
  if (mode === 'exact-navigation') {
    if (exactPath === undefined || request.url !== exactPath) return false
    const url = new URL(request.url, expectedOrigin)
    return url.origin === expectedOrigin && url.search === ''
  }
  return true
}
