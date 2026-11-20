import type { AiErrorCode } from '@agnes/protocol'
import { type AssistantMessage, isContextOverflow } from '@earendil-works/pi-ai'

export type Classified = { code: AiErrorCode; message: string; retryable: boolean; retryAfterMs?: number }

const QUOTA_TEXT =
  /insufficient[_ ](?:user[_ ])?(?:credit|quota|balance)|quota[_ ]exceeded|exceeded your current quota|额度不足|余额不足/i
/**
 * Quota words that describe a throttle: a per-minute limit (Gemini, Vertex: "Quota exceeded for
 * metric … Please retry in 41s"), an allocated rate (DashScope: "Allocated quota exceeded") or a
 * rate limit. Both lookaheads must hold, anywhere in the text.
 */
const THROTTLED_QUOTA =
  /^(?=[\s\S]*(?:quota|额度))(?=[\s\S]*(?:retry (?:in|after)|retry-after|per[ _-]?minute|throttl|allocated quota|rate[ _-]?limit))/i

/**
 * Failure text to a code and a verdict on asking again, in order. The order is the meaning: an
 * authentication failure whose text also mentions a 500 is an authentication failure, and reading it
 * the other way would retry a request that can never succeed. That 500 is a number quoted in the
 * text; a 5xx response status is read before this table (see `classifyPiError`).
 */
const TABLE: Array<[RegExp, AiErrorCode, boolean]> = [
  // An account out of quota is read from its words before its status: gateways answer it with 403
  // (llm.sg: "用户额度不足") or 429 (OpenAI: "You exceeded your current quota"), and calling it a
  // rejected key or a busy server sends the reader to the wrong fix or retries a request that
  // cannot succeed until someone tops the account up. A throttle worded as quota is not that: it
  // clears in seconds, so it stays a retryable rate limit and is read first.
  [THROTTLED_QUOTA, 'RATE_LIMIT', true],
  [QUOTA_TEXT, 'QUOTA', false],
  // `no api key` is the wire library refusing to send an unauthenticated request at all, which is a
  // route that was never going to work rather than a moment when the far end was busy. It used to
  // land in the unclassified bucket and be retried under backoff.
  [/\b(401|403)\b|invalid api key|no api key|missing api key|unauthorized|forbidden/i, 'AUTH', false],
  [/\b429\b|rate limit/i, 'RATE_LIMIT', true],
  [/\b402\b/, 'QUOTA', false],
  [/timed? ?out|ETIMEDOUT|deadline/i, 'TIMEOUT', true],
  [/overloaded|at capacity/i, 'TRANSPORT', true],
  [/\b404\b.*model|model .*not (found|exist)|unknown model/i, 'NO_MODEL', false],
  [/unexpected token|invalid json|malformed|parse error/i, 'FORMAT', false],
  [/\b5\d{2}\b|ECONN|EAI_AGAIN|socket hang up/i, 'TRANSPORT', true],
]

/**
 * What kind of failure this was, and whether asking again could help.
 *
 * Order: an abort, then a context overflow, then the HTTP status, then the text table, then the
 * fallback. The status goes ahead of the text because the text only describes a symptom: a gateway
 * that answers 520 with an HTML page makes the wire library report a JSON parse error, which the
 * table would read as a permanent FORMAT failure. A 5xx is the far end failing, so it is a
 * retryable TRANSPORT whatever the body said. Any other status (4xx, or a 200 whose stream broke
 * part way) and no status at all leave the decision to the text, so a 401 is still AUTH and a 400
 * with an unparseable body is still FORMAT. `status` is the response status the wire layer recorded,
 * never a number guessed out of the text.
 *
 * The fallback is deliberately not retryable. A failure nobody recognised is as likely to be a
 * permanent misconfiguration as a blip, and retrying one of those spends the whole budget on a
 * request that cannot succeed; a blip that is reported once instead of three times costs a turn.
 *
 * `contextWindow` comes from the catalogue record for the model the request actually went to. It is
 * what separates an overflow a provider spelled out - which the patterns catch on their own - from
 * one it never mentioned, where the only signal is that the input filled the declared window.
 */
export function classifyPiError(msg: AssistantMessage, contextWindow?: number, status?: number): Classified {
  if (msg.stopReason === 'aborted') return { code: 'ABORTED', message: 'aborted', retryable: false }
  const text = msg.errorMessage ?? ''
  if (isContextOverflow(msg, contextWindow))
    return { code: 'OVERFLOW', message: redact(text), retryable: false }
  if (status !== undefined && status >= 500)
    return { code: 'TRANSPORT', message: redact(text), retryable: true }
  for (const [re, code, retryable] of TABLE) {
    if (re.test(text)) {
      const note = code === 'QUOTA' ? quotaNote(text) : undefined
      const message = note ? `${redact(text)} note=${JSON.stringify(note)}` : redact(text)
      const c: Classified = { code, message, retryable }
      if (code === 'RATE_LIMIT') c.retryAfterMs = retryAfterMs(text)
      return c
    }
  }
  return { code: 'TRANSPORT', message: redact(text), retryable: false }
}

/** What the far end asked us to wait ("retry-after: 7", "retry in 41.5s"), when it said; a second otherwise. */
function retryAfterMs(text: string): number {
  const m = /retry(?:[- ]after:?| in)\s*(\d+(?:\.\d+)?)/i.exec(text)
  return m ? Math.ceil(Number(m[1]) * 1000) : 1000
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
  const reqId =
    /req[_-]?[A-Za-z0-9]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(text)?.[0] ??
    REQUEST_ID_LABEL.exec(text)?.[1]
  return [status ? `status=${status}` : 'status=?', reqId ? `requestId=${reqId}` : '']
    .filter(Boolean)
    .join(' ')
}

/** New API style gateways (Agnes, llm.sg) append "(request id: 2026…)" to their messages. */
const REQUEST_ID_LABEL = /request id:\s*([A-Za-z0-9-]{6,64})/i
const STATUS_PREFIX = /^\s*(?:error:?\s*)?[1-5]\d{2}\b[\s:]*/i
const REQUEST_ID_NOTE = /\s*[(（]\s*request id:[^)）]*[)）]/gi
/** Anything that could be key material, a bearer value or a URL carrying parameters. */
const SECRETISH =
  /\b(?:sk|pk|rk)-[A-Za-z0-9]{6,}|bearer\s+\S+|api[_ -]?key\s*[:=]|[A-Za-z0-9_-]{24,}|https?:\/\/\S*[?=&]/i
const NOTE_MAX = 160

/**
 * A quota refusal is the far end's own account message, such as "用户额度不足，剩余额度: ＄0", and
 * the reader needs those words to know what to fix. It is written by the gateway about the account
 * rather than echoed from the request, so it is kept once it is short and carries nothing shaped like
 * a credential; otherwise it is dropped. Every other failure stays reduced to its status and id.
 */
export function quotaNote(text: string): string | undefined {
  const body = text.replace(STATUS_PREFIX, '')
  const note = (bodyMessage(body) ?? body).replace(REQUEST_ID_NOTE, '').replace(/\s+/g, ' ').trim()
  if (!note || note.length > NOTE_MAX || SECRETISH.test(note)) return undefined
  return note
}

/** A gateway whose body is passed through raw keeps its readable words in `message`. */
function bodyMessage(body: string): string | undefined {
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as {
      message?: unknown
      error?: { message?: unknown }
    }
    const message = parsed.error?.message ?? parsed.message
    return typeof message === 'string' ? message : undefined
  } catch {
    return undefined
  }
}
