import type { InferenceEvent } from '@agnes/protocol'

type Failure = { phase: 'connect' | 'body' | 'stream'; code: string; retryable: boolean }
const TRANSIENT = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EPIPE',
  'ECONNABORTED',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])
const PERMANENT = new Set([
  'ENOTFOUND',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

/** Keep only known transport facts. Neither exception bodies nor URLs enter stored events. */
export function networkFailure(error: unknown, phase: Failure['phase']): Failure | undefined {
  const seen = new Set<unknown>()
  const pending: unknown[] = [error]
  for (let inspected = 0; pending.length && inspected < 16; inspected++) {
    const next = pending.shift()
    if (!next || typeof next !== 'object' || seen.has(next)) continue
    seen.add(next)
    const value = next as { code?: unknown; cause?: unknown; errors?: unknown }
    if (typeof value.code === 'string' && (TRANSIENT.has(value.code) || PERMANENT.has(value.code)))
      return { phase, code: value.code, retryable: TRANSIENT.has(value.code) }
    pending.push(value.cause)
    if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 8))
  }
  return undefined
}
export function networkEvent(failure: Failure): Extract<InferenceEvent, { type: 'error' }> {
  return {
    type: 'error',
    reason: 'error',
    code: failure.code === 'ETIMEDOUT' || failure.code.includes('TIMEOUT') ? 'TIMEOUT' : 'TRANSPORT',
    message: `network phase=${failure.phase} code=${failure.code}`,
    retryable: failure.retryable,
  }
}

/** Observe the consumer's body reads without teeing or retaining response bytes. */
export function watchResponse(response: Response, failed: (error: unknown) => void): Response {
  if (!response.body) return response
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          controller.close()
          reader.releaseLock()
        } else controller.enqueue(next.value)
      } catch (error) {
        failed(error)
        controller.error(error)
        reader.releaseLock()
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        reader.releaseLock()
      }
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
