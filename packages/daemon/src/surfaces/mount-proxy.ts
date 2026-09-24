import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { FORGED_IDENTITY_KEYS, normalizeKey } from './routes.js'
import { surfaceSecurityHeaders } from './security-headers.js'
import { mountMatches } from './types.js'

/** The narrow slice of a mount-table row `createMountProxy` actually reads: a loopback host/port and
 * the mount prefix it was matched against. M3 (final review, Minor): this used to be
 * `{ endpoint: SurfaceEndpoint; mount: string }`, which forced every caller -- including
 * `packages/cli/launch/surface-mounts.ts`, whose Task-15 RPC row only ever carries
 * `{mount, host, port}` -- to fabricate a `healthPath` field purely to satisfy the wider type. Narrow
 * to what is used instead of widening the caller. */
export type MountProxyMatch = Readonly<{ mount: string; host: string; port: number }>

/**
 * Shared mount-lookup predicate: an exact path match or a `mount/...` sub-path. I3 (final review,
 * Important): this exact rule used to be hand-duplicated in three places (this file's own
 * `surfaceMountProxy` closure in `supervisor.ts` -- since retired, see that file's history --,
 * `packages/cli/launch/surface-mounts.ts`, and `routes.ts`'s `routeTarget`). `routes.ts` matches over
 * a different table shape (`ResolvedSurface[]`, mount nested under `.instance.mount`) so it calls
 * `mountMatches` directly from `types.js` (mount-proxy.ts already depends on routes.ts for
 * `FORGED_IDENTITY_KEYS`, so the reverse edge would be circular); every `{mount: string}`-shaped
 * table -- including this file's own callers -- can use `matchMount` below instead.
 */
export function matchMount<T extends { mount: string }>(
  table: readonly T[],
  pathname: string,
): T | undefined {
  return table.find((row) => mountMatches(row.mount, pathname))
}

/** Normalizes Node's raw `IncomingHttpHeaders` (values may be `string | string[] | undefined`) into
 * the `Record<string, string>` shape `surfaceSecurityHeaders()` accepts, joining a multi-value header
 * with `, ` per HTTP list syntax. Dropping to `Record<string,string>` here is what lets the shared
 * `\r\n\0` filter (`security-headers.ts`'s `safeHeaderValue`) actually see every value. */
function normalizeUpstreamHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    output[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return output
}

/**
 * Forwards browser traffic for a mounted Surface to that Surface's loopback port. This is the only
 * production path by which a browser reaches a Surface at all -- routes.ts solves the opposite
 * direction (a Surface calling back into Agnes services over the SDK relay) and the two are not
 * merged here or routed through one another.
 *
 * Identity stripping reuses routes.ts's already-reviewed FORGED_IDENTITY_KEYS set (and its
 * normalizeKey case/punctuation rule) rather than re-deriving either: this is a new externally
 * reachable HTTP surface and must not bypass those protections. Response security headers likewise
 * come from surfaceSecurityHeaders() so this module cannot silently drift from the shared policy.
 */
export function createMountProxy(deps: {
  lookup(pathname: string): MountProxyMatch | undefined
}): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    const rawUrl = req.url ?? '/'
    let pathname: string
    try {
      pathname = new URL(rawUrl, 'http://127.0.0.1').pathname
    } catch {
      return false
    }
    const match = deps.lookup(pathname)
    if (!match) return false

    const suffix = pathname.slice(match.mount.length) || '/'
    const queryIndex = rawUrl.indexOf('?')
    const search = queryIndex < 0 ? '' : rawUrl.slice(queryIndex)
    const headers: Record<string, string | string[]> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      if (FORGED_IDENTITY_KEYS.has(normalizeKey(key))) continue
      headers[key] = value
    }
    headers.host = `${match.host}:${match.port}`

    const upstream = httpRequest(
      {
        host: match.host,
        port: match.port,
        path: `${suffix}${search}`,
        method: req.method ?? 'GET',
        headers,
      },
      (upstreamRes) => {
        // M2 (final review, Minor): reuse routes.ts's own pattern -- pass upstream headers THROUGH
        // surfaceSecurityHeaders(input) so its `\r\n\0` filter (security-headers.ts's
        // `safeHeaderValue`) actually runs on them, instead of spreading `upstreamRes.headers`
        // straight into `writeHead` unfiltered and calling surfaceSecurityHeaders() with no argument
        // (which only contributes the fixed security headers, never sees -- let alone filters --
        // what the upstream Surface sent). `writeHead` can also throw (Node's HTTP parser rejects a
        // header value with ERR_INVALID_CHAR) even after filtering catches the common case, so this
        // is wrapped and falls back to the same 502 this file already uses when the upstream socket
        // itself is unreachable.
        try {
          res.writeHead(
            upstreamRes.statusCode ?? 502,
            surfaceSecurityHeaders(normalizeUpstreamHeaders(upstreamRes.headers)),
          )
        } catch {
          upstreamRes.destroy()
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
          res.end('surface unavailable')
          return
        }
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('surface unavailable')
    })
    req.pipe(upstream)
    return true
  }
}
