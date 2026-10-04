import type { ModelSettlement } from '@agnes/jev-runtime'
import { type DecisionTransport, decodeDecisionResponse } from '@agnes/runtime-jev'

const TIMEOUT_MS = 120_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** One Host-owned attempt. Retryability is classification only; this transport never retries.
 * Secrets remain in headers, never in durable request/response errors. */
export function createJevDecisionTransport(options: {
  endpoint: string
  token?: string
  fetcher: typeof fetch
}): DecisionTransport {
  return {
    async invoke(request, signal) {
      const started = performance.now()
      const failed = (code: string, message: string, retryable = false): ModelSettlement => ({
        error: { code, message, retryable },
        latencyMs: performance.now() - started,
      })
      const timeout = AbortSignal.timeout(TIMEOUT_MS)
      const combined = AbortSignal.any([signal, timeout])
      const aborted = () =>
        signal.aborted
          ? failed('DECISION_CANCELLED', 'Jev 决策请求已取消。')
          : failed('DECISION_TIMEOUT', 'Jev 决策请求超时。', true)
      if (combined.aborted) return aborted()
      let body: string
      try {
        body = JSON.stringify(request)
      } catch {
        return failed('DECISION_INVALID_REQUEST', 'Jev 决策请求无法编码。')
      }
      try {
        const response = await options.fetcher(options.endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: combined,
          headers: {
            'content-type': 'application/json',
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
          body,
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          return failed(
            'DECISION_HTTP',
            `Jev 决策服务返回 HTTP ${response.status}。`,
            response.status === 429 || response.status >= 500,
          )
        }
        const reader = response.body?.getReader()
        if (!reader) return failed('DECISION_EMPTY_RESPONSE', 'Jev 决策服务未返回响应正文。')
        const parts: Uint8Array[] = []
        let bytes = 0
        try {
          for (;;) {
            combined.throwIfAborted()
            const part = await reader.read()
            if (part.done) break
            bytes += part.value.byteLength
            if (bytes > MAX_RESPONSE_BYTES)
              return failed('DECISION_RESPONSE_TOO_LARGE', 'Jev 决策响应超过大小上限。')
            parts.push(part.value)
          }
        } finally {
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
        if (combined.aborted) return aborted()
        if (bytes === 0) return failed('DECISION_EMPTY_RESPONSE', 'Jev 决策服务未返回响应正文。')
        let text: string
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))
        } catch {
          return failed('DECISION_INVALID_UTF8', 'Jev 决策响应不是有效的 UTF-8。')
        }
        let value: unknown
        try {
          value = JSON.parse(text)
        } catch {
          return failed('DECISION_INVALID_JSON', 'Jev 决策响应不是有效的 JSON。')
        }
        try {
          return { ...decodeDecisionResponse(value), latencyMs: performance.now() - started }
        } catch {
          return failed('DECISION_INVALID_RESPONSE', 'Jev 决策响应格式无效。')
        }
      } catch {
        return combined.aborted
          ? aborted()
          : failed('DECISION_TRANSPORT', '无法完成 Jev 决策服务请求。', true)
      }
    },
  }
}
