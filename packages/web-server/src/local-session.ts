import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { LOCAL_WEB_CODE_PARAM, LOCAL_WEB_TICKET_PATH } from '@agnes/protocol'

/** Unused launch codes kept at once; the oldest is dropped first. */
const MAX_CODES = 32
/** The cookie only lives as long as this launcher's secret, so it may outlive a browser restart. */
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

export type LocalWebSession = ReturnType<typeof createLocalWebSession>

/**
 * Per-launch browser session for the local Web launcher.
 *
 * Whoever starts the launcher gets a URL with a one-time code. Opening it trades the code for an
 * `HttpOnly; SameSite=Strict` cookie holding a random per-launch secret and redirects to the same
 * URL without the code. The page itself stays public (it carries no secret); the BFF routes and
 * every non-read request need the cookie, and the page gets each daemon WebSocket ticket from
 * {@link LOCAL_WEB_TICKET_PATH} with it.
 */
export function createLocalWebSession(options: {
  origin: URL
  /** Signs a single-use daemon WebSocket ticket with the daemon's current per-launch secret. */
  wsTicket(): Promise<string>
}) {
  const cookieValue = randomBytes(32).toString('base64url')
  const cookieDigest = digest(cookieValue)
  // Cookies are scoped by host, not port; a per-port name keeps two launchers from clobbering each other.
  const cookieName = `agnes_web_${options.origin.port || '80'}`
  const codes = new Set<string>()

  const authenticated = (request: IncomingMessage): boolean => {
    let ok = false
    for (const part of (request.headers.cookie ?? '').split(';')) {
      const index = part.indexOf('=')
      if (index < 0 || part.slice(0, index).trim() !== cookieName) continue
      if (timingSafeEqual(digest(part.slice(index + 1).trim()), cookieDigest)) ok = true
    }
    return ok
  }

  return {
    /** A fresh one-time code; it is valid until it is exchanged or this launcher exits. */
    issueCode(): string {
      const code = randomBytes(24).toString('base64url')
      codes.add(digest(code).toString('hex'))
      while (codes.size > MAX_CODES) codes.delete(codes.values().next().value as string)
      return code
    },
    /** The launch URL for a person to open: this origin plus a fresh one-time code. */
    launchUrl(): string {
      const url = new URL('/', options.origin)
      url.searchParams.set(LOCAL_WEB_CODE_PARAM, this.issueCode())
      return url.href
    },
    authenticated,
    /**
     * Trade `/?code=` for the session cookie and strip the code from the address bar. An unknown or
     * used code sets nothing; the redirect still removes it, and the page explains how to sign in.
     */
    exchange(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
      if (url.pathname !== '/' || !url.searchParams.has(LOCAL_WEB_CODE_PARAM)) return false
      if (request.method !== 'GET' && request.method !== 'HEAD') return false
      const code = url.searchParams.get(LOCAL_WEB_CODE_PARAM) ?? ''
      const key = digest(code).toString('hex')
      // A HEAD (a link preview, say) must not spend the code the person is about to open.
      const valid = request.method === 'GET' && codes.delete(key)
      const target = new URL(url.href)
      target.searchParams.delete(LOCAL_WEB_CODE_PARAM)
      response.writeHead(303, {
        Location: `${target.pathname}${target.search}`,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        ...(valid
          ? {
              'Set-Cookie': `${cookieName}=${cookieValue}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}`,
            }
          : {}),
      })
      response.end()
      return true
    },
    /** BFF reads, every non-read request and the ticket route need the session. */
    required(request: IncomingMessage, pathname: string): boolean {
      // Own credentials: webhook path secrets and the signed OAuth `state` of an external redirect.
      if (pathname.startsWith('/hooks/') || /^\/oauth\/[^/]+\/callback$/.test(pathname)) return false
      if (pathname === '/healthz') return false
      if (request.method !== 'GET' && request.method !== 'HEAD') return true
      return (
        pathname.startsWith('/api/') ||
        /^\/admin\/(?:plugins\/|resources\/)?api\//.test(pathname) ||
        pathname.startsWith('/oauth/')
      )
    },
    /** POST {@link LOCAL_WEB_TICKET_PATH}: a signed-in page asks for one daemon WebSocket ticket. */
    async ticket(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      if (request.method !== 'POST') {
        response.writeHead(405, { ...headers, Allow: 'POST' }).end()
        return
      }
      if (request.headers.origin !== options.origin.origin) {
        response.writeHead(403, headers).end(JSON.stringify({ error: { code: 'E_WEB_ORIGIN' } }))
        return
      }
      if (!authenticated(request)) {
        response.writeHead(401, headers).end(JSON.stringify({ error: { code: 'E_WEB_SESSION' } }))
        return
      }
      let ticket: string
      try {
        ticket = await options.wsTicket()
      } catch {
        response.writeHead(503, headers).end(JSON.stringify({ error: { code: 'E_HOST_CLOSED' } }))
        return
      }
      response.writeHead(200, headers).end(JSON.stringify({ ticket }))
    },
  }
}
