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

export const DEFAULT_MHS_SITE_ORIGIN = 'https://agh.agnes-ai.cn'
const DEFAULT_MHS_HUB_ORIGIN = 'https://agnes-hardware-website-test.aisi-devops.com'
const DEV_MHS_ORIGINS = ['http://127.0.0.1:4321', 'http://127.0.0.1:4173']

/** Exact MHS site origin injected into `index.html`; falls back to production when unset or unsafe. */
export function resolveMhsSiteOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return exactEmbedOrigin(env.AGNES_MHS_SITE_URL) ?? DEFAULT_MHS_SITE_ORIGIN
}

function privateIpv4Host(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false
  const [first, second] = parts.map(Number)
  return (
    first === 10 ||
    (first === 192 && second === 168) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31)
  )
}

function exactEmbedOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return undefined
  }
  if (parsed.username || parsed.password) return undefined
  if (parsed.protocol === 'https:') return parsed.origin
  if (
    parsed.protocol === 'http:' &&
    (LOOPBACK_NAMES.includes(parsed.hostname) || privateIpv4Host(parsed.hostname))
  )
    return parsed.origin
  return undefined
}

/** Exact origins `index.html` admits in `frame-src` for embedded MHS surfaces; never wildcards. */
export function mhsFrameSources(
  options?: { developmentReload?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const origins = new Set<string>(["'self'", 'blob:', DEFAULT_MHS_SITE_ORIGIN, DEFAULT_MHS_HUB_ORIGIN])
  if (options?.developmentReload) {
    for (const origin of DEV_MHS_ORIGINS) origins.add(origin)
  }
  for (const candidate of [env.AGNES_MHS_SITE_URL, env.AGNES_MHS_HUB_URL]) {
    const origin = exactEmbedOrigin(candidate)
    if (origin) origins.add(origin)
  }
  return [...origins].join(' ')
}
