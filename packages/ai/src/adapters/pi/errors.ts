import type { AiErrorCode } from '@agnes/protocol'
import { type AssistantMessage, isContextOverflow } from '@earendil-works/pi-ai'

export type Classified = { code: AiErrorCode; message: string; retryable: boolean; retryAfterMs?: number }

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
export function classifyPiError(msg: AssistantMessage, contextWindow?: number): Classified {
  if (msg.stopReason === 'aborted') return { code: 'ABORTED', message: 'aborted', retryable: false }
  const text = msg.errorMessage ?? ''
  if (isContextOverflow(msg, contextWindow))
    return { code: 'OVERFLOW', message: redact(text), retryable: false }
  for (const [re, code, retryable] of TABLE) {
    if (re.test(text)) {
      const c: Classified = { code, message: redact(text), retryable }
      if (code === 'RATE_LIMIT') c.retryAfterMs = retryAfterMs(text)
      return c
    }
  }
  return { code: 'TRANSPORT', message: redact(text), retryable: false }
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
