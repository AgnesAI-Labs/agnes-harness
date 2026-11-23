import { setTimeout as delay } from 'node:timers/promises'
import { CLOUD_AUTHORIZATION_TIMEOUT_MS } from '@agnes/protocol'

/** Retry only credential discovery/authorization, never a forwarded business request. */
export function cloudAuthorizationRequests(fetcher: typeof fetch) {
  const deadline = Date.now() + CLOUD_AUTHORIZATION_TIMEOUT_MS
  const lifetime = AbortSignal.timeout(CLOUD_AUTHORIZATION_TIMEOUT_MS)
  let retried = false
  const request =
    (timeoutMs: number): typeof fetch =>
    async (input, init) => {
      while (true) {
        lifetime.throwIfAborted()
        init?.signal?.throwIfAborted()
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new DOMException('Authorization timed out', 'TimeoutError')
        const signal = AbortSignal.any([
          lifetime,
          AbortSignal.timeout(Math.min(timeoutMs, remaining)),
          ...(init?.signal ? [init.signal] : []),
        ])
        let response: Response | undefined
        try {
          response = await fetcher(input, { ...init, signal })
          if (![502, 503, 504].includes(response.status)) return response
        } catch (error) {
          if (!(error instanceof TypeError) && !(error instanceof Error && error.name === 'TimeoutError'))
            throw error
          if (retried || lifetime.aborted || init?.signal?.aborted) throw error
        }
        // Share a single retry across discovery and sandbox authorization. A failed
        // body/identity check is deliberately outside this transport retry loop.
        if (retried || lifetime.aborted || init?.signal?.aborted || deadline - Date.now() <= 1000) {
          if (response) return response
          throw new DOMException('Authorization timed out', 'TimeoutError')
        }
        await response?.body?.cancel().catch(() => undefined)
        retried = true
        await delay(1000, undefined, {
          signal: init?.signal ? AbortSignal.any([lifetime, init.signal]) : lifetime,
        })
      }
    }
  return { connection: request(25_000), authorize: request(15_000) }
}
