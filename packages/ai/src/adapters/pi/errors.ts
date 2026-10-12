import type { AiErrorCode } from '@agnes/protocol'
import { type AssistantMessage, isContextOverflow } from '@earendil-works/pi-ai'

export type Classified = { code: AiErrorCode; message: string; retryable: boolean; retryAfterMs?: number }

/** Optional transport facts; only exact known codes and names may reach the stored diagnosis. */
export type PiTransportFailure = { code?: string; name?: string }

const TRANSPORT_CODES = new Map<string, AiErrorCode>([
  ...['UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].map(
    (code): [string, AiErrorCode] => [code, 'TIMEOUT'],
  ),
  ...[
    'UND_ERR_SOCKET',
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'EPIPE',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
  ].map((code): [string, AiErrorCode] => [code, 'TRANSPORT']),
])
const TRANSPORT_NAMES = new Map<string, AiErrorCode>([
  ['BodyTimeoutError', 'TIMEOUT'],
  ['HeadersTimeoutError', 'TIMEOUT'],
  ['ConnectTimeoutError', 'TIMEOUT'],
  ['APIConnectionTimeoutError', 'TIMEOUT'],
  ['SocketError', 'TRANSPORT'],
  ['APIConnectionError', 'TRANSPORT'],
])

/** Keep bounded, allowlisted facts before a provider SDK discards the original cause chain. */
export function piTransportFailure(error: unknown): PiTransportFailure | undefined {
  const seen = new Set<object>()
  const result: PiTransportFailure = {}
  let current = error
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth++) {
    if (seen.has(current)) break
    seen.add(current)
    try {
      const cause = current as { code?: unknown; name?: unknown; cause?: unknown }
      if (typeof cause.code === 'string' && TRANSPORT_CODES.has(cause.code)) result.code = cause.code
      if (typeof cause.name === 'string' && TRANSPORT_NAMES.has(cause.name)) result.name = cause.name
      current = cause.cause
    } catch {
      break
    }
  }
  return result.code || result.name ? result : undefined
}

/**
 * Failure text to a code and a verdict on asking again, in order. The order is the meaning: an
 * authentication failure that also mentions a 500 is an authentication failure, and reading it the
 * other way would retry a request that can never succeed.
 */
const TABLE: Array<[RegExp, AiErrorCode, boolean]> = [
  // `no api key` is the wire library refusing to send an unauthenticated request at all, which is a
  // route that was never going to work rather than a moment when the far end was busy. It used to
  // land in the unclassified bucket and be retried under backoff.
  [/\b(401|403)\b|invalid api key|no api key|missing api key|unauthorized|forbidden/i, 'AUTH', false],
  [/\b429\b|rate limit/i, 'RATE_LIMIT', true],
  [/\b402\b|insufficient (credit|quota|balance)|quota exceeded/i, 'QUOTA', false],
  [/timed? ?out|ETIMEDOUT|deadline/i, 'TIMEOUT', true],
  [/\b404\b.*model|model .*not (found|exist)|unknown model/i, 'NO_MODEL', false],
  [/unexpected token|invalid json|malformed|parse error/i, 'FORMAT', false],
  [/\b5\d{2}\b|ECONN|EAI_AGAIN|socket hang up/i, 'TRANSPORT', true],
]

/**
 * What kind of failure this was, and whether asking again could help.
 *
 * The fallback is deliberately not retryable. A failure nobody recognised is as likely to be a
 * permanent misconfiguration as a blip, and retrying one of those spends the whole budget on a
 * request that cannot succeed; a blip that is reported once instead of three times costs a turn.
 *
 * `contextWindow` comes from the catalogue record for the model the request actually went to. It is
 * what separates an overflow a provider spelled out - which the patterns catch on their own - from
 * one it never mentioned, where the only signal is that the input filled the declared window.
 */
export function classifyPiError(
  msg: AssistantMessage,
  contextWindow?: number,
  transportFailure?: PiTransportFailure,
): Classified {
  if (msg.stopReason === 'aborted') return { code: 'ABORTED', message: 'aborted', retryable: false }
  const text = msg.errorMessage ?? ''
  const transportCode =
    typeof transportFailure?.code === 'string' && TRANSPORT_CODES.has(transportFailure.code)
      ? transportFailure.code
      : undefined
  const cause =
    typeof transportFailure?.name === 'string' && TRANSPORT_NAMES.has(transportFailure.name)
      ? transportFailure.name
      : undefined
  const message = [
    redact(text),
    ...(transportCode ? [`transportCode=${transportCode}`] : []),
    ...(cause ? [`cause=${cause}`] : []),
  ].join(' ')
  if (isContextOverflow(msg, contextWindow)) return { code: 'OVERFLOW', message, retryable: false }
  for (const [re, code, retryable] of TABLE) {
    if (re.test(text)) {
      const c: Classified = { code, message, retryable }
      if (code === 'RATE_LIMIT') c.retryAfterMs = retryAfterMs(text)
      return c
    }
  }
  if (/^(?:Error: )?Provider finish_reason: network_error$/.test(text.trim()))
    return { code: 'TRANSPORT', message: `${message} reason=provider_network_error`, retryable: true }
  if (/^(?:Error: )?Stream ended without finish_reason$/.test(text.trim()))
    return { code: 'TRANSPORT', message: `${message} reason=stream_incomplete`, retryable: true }
  const code =
    (transportCode ? TRANSPORT_CODES.get(transportCode) : undefined) ??
    (cause ? TRANSPORT_NAMES.get(cause) : undefined)
  return { code: code ?? 'TRANSPORT', message, retryable: code !== undefined }
}

/** What the far end asked us to wait, when it said; a second otherwise. */
function retryAfterMs(text: string): number {
  const m = /retry[- ]after:?\s*(\d+)/i.exec(text)
  return m ? Number(m[1]) * 1000 : 1000
}

/**
 * Provider error text is written by the far end and routinely quotes the request - a URL, a prompt
 * fragment, sometimes the key itself - and these messages are going into an event that is stored
 * and displayed. So nothing is forwarded: the text is replaced by the two facts that are useful for
 * diagnosis and safe to keep, a status code and a request id, both matched out of the original
 * rather than copied through.
 */
export function redact(text: string): string {
  const status = /\b([1-5]\d{2})\b/.exec(text)?.[1]
  const reqId = /req[_-]?[A-Za-z0-9]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(
    text,
  )?.[0]
  return [status ? `status=${status}` : 'status=?', reqId ? `requestId=${reqId}` : '']
    .filter(Boolean)
    .join(' ')
}
