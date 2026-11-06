import { deploymentFetch } from '@agnes/system-node/deployment-network'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

/** How long one OAuth request (discovery, registration, code exchange, refresh) may take. */
export const OAUTH_REQUEST_TIMEOUT_MS = 10_000

/**
 * The one timeout + `redirect: 'error'` guard for every OAuth network call (discovery,
 * registration, code exchange, refresh). Every SDK call that accepts a `fetchFn`/`fetchImpl` must
 * receive a fetch wrapped by this; the option is easy to forget on a new call, and leaving it out
 * exempts that request from both protections.
 */
export function withTimeout(fetchImpl: FetchLike | undefined, timeoutMs: number): FetchLike {
  const base = fetchImpl ?? fetch
  return async (input, init) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      // `redirect: 'error'` (found by independent security review): every OAuth fetch (PRM
      // discovery, RFC 8414 discovery, DCR registration, token exchange) targets a
      // URL that has already been validated (see oauth-client.ts's SSRF guards), but a redirect response's own
      // `Location` header is not itself something that validation ever inspects - a compromised or
      // malicious endpoint could otherwise 30x this daemon-side request to an arbitrary internal host
      // after the fact, silently bypassing every check already done on the *requested* URL. `fetch`'s
      // own default (`redirect: 'follow'`) would do exactly that. None of these calls have a
      // legitimate reason to redirect (they are metadata/credential exchanges, not content fetches),
      // so refusing outright - matching `packages/base/src/mcp/connect.ts`'s
      // `policedHttpFetch` own no-validator fallback behavior, rather than reimplementing its full
      // revalidate-then-follow loop for a flow that never needs it - is the correct default.
      return await base(input, { ...init, redirect: 'error', signal: init?.signal ?? controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}

/** The fetch for OAuth requests made outside the daemon: the deployment's network settings, under
 * the same timeout and redirect guard. */
export const guardedOAuthFetch: FetchLike = withTimeout(deploymentFetch, OAUTH_REQUEST_TIMEOUT_MS)
