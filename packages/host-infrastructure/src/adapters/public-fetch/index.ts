import type { PublicFetch } from '@agnes/extension-api'
import { assertDirect, fetchUrl, LIMITS, WebFetchError } from './policy.js'
import { header, readResponse } from './read.js'
import { type PublicTransport, requestPublic } from './transport.js'

const REDIRECTS = new Set([301, 302, 303, 307, 308])

/** Transport injection is for focused tests, never a deployment/model-controlled policy bypass. */
export function createPublicFetch(
  env: NodeJS.ProcessEnv = process.env,
  transport: PublicTransport = requestPublic,
): PublicFetch {
  return async (input, options) => {
    options.signal.throwIfAborted()
    let url = fetchUrl(input)
    assertDirect(env)
    const budget = Math.min(options.timeoutMs, LIMITS.timeoutMs)
    if (!Number.isFinite(budget) || budget <= 0)
      throw new WebFetchError('Public web retrieval timed out', 'WEB_FETCH_TIMEOUT')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budget)
    const signal = AbortSignal.any([options.signal, controller.signal])
    try {
      for (let hops = 0; ; hops++) {
        signal.throwIfAborted()
        const response = await transport(url, signal)
        try {
          signal.throwIfAborted()
          if (!REDIRECTS.has(response.statusCode))
            return await readResponse(response, url, signal, options.responseType)
          if (hops >= LIMITS.hops) throw new WebFetchError('Too many redirects', 'WEB_REDIRECT_BLOCKED')
          const location = header(response, 'location')
          if (!location) throw new WebFetchError('Redirect has no Location', 'WEB_REDIRECT_BLOCKED')
          let target: URL
          try {
            target = fetchUrl(new URL(location, url).href)
          } catch {
            throw new WebFetchError('Invalid redirect target', 'WEB_REDIRECT_BLOCKED')
          }
          if (target.origin !== url.origin)
            throw new WebFetchError(
              `Cross-origin redirect blocked; call web_fetch directly with ${target.href}`,
              'WEB_REDIRECT_BLOCKED',
            )
          url = target
        } finally {
          await response.close()
        }
      }
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason
      if (controller.signal.aborted)
        throw new WebFetchError('Public web retrieval timed out', 'WEB_FETCH_TIMEOUT')
      if (error instanceof WebFetchError) throw error
      throw new WebFetchError(
        'Public web retrieval failed (DNS, TLS, connection or response stream)',
        'WEB_NETWORK_ERROR',
      )
    } finally {
      clearTimeout(timer)
    }
  }
}
