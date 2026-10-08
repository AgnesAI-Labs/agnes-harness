const SECURITY_HEADERS = new Set([
  'content-security-policy',
  'permissions-policy',
  'referrer-policy',
  'x-content-type-options',
  'x-frame-options',
])

export const DEFAULT_SURFACE_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join('; ')

export type SurfaceHeaders = Readonly<Record<string, string>>

/** Security headers are authoritative: an upstream Surface cannot weaken them. */
export function surfaceSecurityHeaders(input: SurfaceHeaders = {}): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase()
    if (!SECURITY_HEADERS.has(lower) && safeHeaderValue(value)) headers[lower] = value
  }
  return {
    ...headers,
    'content-security-policy': DEFAULT_SURFACE_CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy':
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  }
}

export type SafeSurfaceContent = {
  body: string
  contentType: 'application/json; charset=utf-8' | 'text/html; charset=utf-8' | 'text/plain; charset=utf-8'
}

/**
 * HTML is executable content and therefore requires an explicit sanitizer. Unknown and malformed
 * payloads become inert text instead of being reflected under an attacker-controlled MIME type.
 */
export function safeSurfaceContent(
  body: unknown,
  contentType: string | undefined,
  options: { sanitizeHtml?: (html: string) => string } = {},
): SafeSurfaceContent {
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType === 'application/json') {
    try {
      return {
        body: typeof body === 'string' ? JSON.stringify(JSON.parse(body)) : JSON.stringify(body ?? null),
        contentType: 'application/json; charset=utf-8',
      }
    } catch {
      return unsupported()
    }
  }
  if (mediaType === 'text/html' && options.sanitizeHtml !== undefined && typeof body === 'string') {
    return {
      body: options.sanitizeHtml(body),
      contentType: 'text/html; charset=utf-8',
    }
  }
  if (mediaType === 'text/plain' || mediaType === 'text/html') {
    return {
      body: typeof body === 'string' ? body : String(body ?? ''),
      contentType: 'text/plain; charset=utf-8',
    }
  }
  return unsupported()
}

function unsupported(): SafeSurfaceContent {
  return { body: '[unsupported surface content]', contentType: 'text/plain; charset=utf-8' }
}

function safeHeaderValue(value: string): boolean {
  return !/[\r\n\0]/.test(value)
}
