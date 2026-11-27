import { setTimeout as delay } from 'node:timers/promises'
import { CLOUD_AUTHORIZATION_TIMEOUT_MS } from '@agnes/protocol'

const MAX_AUTHORIZATION_BYTES = 16_384

export function discardCloudBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined)
}

export async function readCloudAuthorizationBody(response: Response, signal?: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length')
  if (length !== null && Number(length) > MAX_AUTHORIZATION_BYTES) {
    discardCloudBody(response)
    throw new Error('authorization response too large')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('missing authorization response')
  const cancel = () => void reader.cancel().catch(() => undefined)
  signal?.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const next = await reader.read()
      signal?.throwIfAborted()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_AUTHORIZATION_BYTES) throw new Error('authorization response too large')
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    signal?.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}

/** Retry only credential discovery/authorization, never a forwarded business request. */
export function cloudAuthorizationRequests(fetcher: typeof fetch, cancellation?: AbortSignal) {
  const deadline = Date.now() + CLOUD_AUTHORIZATION_TIMEOUT_MS
  const timeout = AbortSignal.timeout(CLOUD_AUTHORIZATION_TIMEOUT_MS)
  const lifetime = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout
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
          if (lifetime.aborted) discardCloudBody(response)
          lifetime.throwIfAborted()
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
        if (response) discardCloudBody(response)
        retried = true
        await delay(1000, undefined, {
          signal: init?.signal ? AbortSignal.any([lifetime, init.signal]) : lifetime,
        })
      }
    }
  return { connection: request(25_000), authorize: request(15_000), signal: lifetime }
}
