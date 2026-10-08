/** Host-owned public retrieval policy; never applied to model/MCP endpoint traffic. */
export const LIMITS = {
  url: 2048,
  bytes: 2 * 1024 * 1024,
  chars: 100_000,
  hops: 5,
  timeoutMs: 30_000,
} as const

export class WebFetchError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'WebFetchError'
  }
}

export function fetchUrl(input: string): URL {
  if (
    !input.trim() ||
    input.length > LIMITS.url ||
    Array.from(input).some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
  )
    throw new WebFetchError(
      'Expected a bounded HTTP(S) URL without whitespace or controls',
      'WEB_INVALID_URL',
    )
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new WebFetchError('Invalid URL', 'WEB_INVALID_URL')
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new WebFetchError('Only HTTP(S) URLs are supported', 'WEB_INVALID_URL')
  if (url.username || url.password)
    throw new WebFetchError('Credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  url.hash = ''
  if (url.href.length > LIMITS.url)
    throw new WebFetchError('Normalized URL exceeds the length limit', 'WEB_INVALID_URL')
  return url
}

export function bodyFormat(value: string): { kind: 'html' | 'text'; decoder: TextDecoder } {
  const mime = value.split(';')[0]?.trim().toLowerCase() ?? ''
  const html = mime === 'text/html' || mime === 'application/xhtml+xml'
  if (!html && !mime.startsWith('text/') && !/^application\/(?:json|xml|[^;\s]+\+(?:json|xml))$/u.test(mime))
    throw new WebFetchError('Unsupported or missing Content-Type', 'WEB_UNSUPPORTED_CONTENT_TYPE')
  const charset = /;\s*charset\s*=\s*"?([^";]+)/iu.exec(value)?.[1]?.trim()
  try {
    return { kind: html ? 'html' : 'text', decoder: new TextDecoder(charset ?? 'utf-8') }
  } catch {
    throw new WebFetchError('Unsupported response charset', 'WEB_UNSUPPORTED_CHARSET')
  }
}

export function assertDirect(env: NodeJS.ProcessEnv): void {
  if (Object.entries(env).some(([name, value]) => /^(?:http|https|all)_proxy$/iu.test(name) && value?.trim()))
    throw new WebFetchError(
      'Public web retrieval does not support configured proxies; no direct bypass was attempted',
      'WEB_PROXY_UNSUPPORTED',
    )
}
