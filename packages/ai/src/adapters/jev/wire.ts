// The TypeSafe System One wire format as pure functions: the request body, the reply envelope, the
// status classification and the bounded body reads. Nothing here opens a connection; index.ts does.
import type { AiErrorCode, JsonValue, RequestBody } from '@agnes/protocol'
import type { WireEvent } from '../../adapter.js'

export const JEV_WIRE_API = 'typesafe-systemone'
/** The largest reply accepted: far above any answer set, and small enough to hold in memory. */
export const MAX_RESPONSE_BYTES = 1024 * 1024
/** How much of an error body is read. It only feeds keyword classification and is then dropped. */
export const MAX_ERROR_BYTES = 16 * 1024

/** A reply that cannot be used. The message is the code alone, so nothing from the wire leaks. */
export class WireFailure extends Error {
  constructor(readonly code: AiErrorCode) {
    super(code)
  }
}

const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
}

/**
 * Where a route's calls go: the base URL with `/systemone` appended, or the reason the base URL
 * cannot be used. The reason is a fixed phrase and never quotes the URL, which may carry a secret.
 */
export function endpointFor(baseUrl: string): URL | string {
  if (/[{}]/.test(baseUrl)) return 'the base URL contains a template'
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return 'the base URL is not an absolute URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'the base URL is not http or https'
  if (url.username !== '' || url.password !== '') return 'the base URL carries credentials'
  if (/[?#]/.test(baseUrl)) return 'the base URL has a query or a fragment'
  if (/[{}]/.test(url.hostname)) return 'the base URL contains a template'
  // The key travels as a bearer token, so it is never sent in the clear to another machine.
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) return 'plain http is for loopback only'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/systemone`
  return url
}

export type JevPayload = { state: JsonValue; questions: Record<string, JsonValue> }

/**
 * The `{state, questions}` a request carries, or why this is not a request the vendor can answer.
 * Only the shape is checked. How many questions, what their ids look like and how large the state is
 * are the vendor's rules and the caller's business; a second set of limits here would only disagree.
 */
export function readPayload(req: RequestBody): JevPayload | string {
  if (req.tools.length > 0) return 'tools are not supported'
  if (req.messages.length > 0) return 'messages are not supported'
  if (req.system !== '') return 'a system prompt is not supported'
  const payload = req.payload
  if (payload === undefined) return 'answers payload requests only'
  if (!plain(payload) || Object.keys(payload).sort().join() !== 'questions,state')
    return 'payload must be {state, questions}'
  if (payload.state === undefined) return 'payload must be {state, questions}'
  if (!plain(payload.questions)) return 'payload.questions must be an object'
  return { state: payload.state as JsonValue, questions: payload.questions as Record<string, JsonValue> }
}

/** The model id goes out exactly as the catalogue records it. */
export const vendorBody = (model: string, payload: JevPayload): string =>
  JSON.stringify({ model, state: payload.state, questions: payload.questions })

export type JevReply = {
  model: string
  answers: Record<string, unknown>
  inputTokens: number
  outputTokens: number
  /** The vendor's price for this call in whole micro-dollars, when it reported one. */
  usdMicros?: number
  id?: string
}

/**
 * Checks the envelope and nothing inside the answers. A missing answer, an extra one or
 * probabilities that do not sum to one are handed on untouched, because the caller validates answers
 * strictly and a repair here would hide a vendor fault from it.
 */
export function parseReply(text: string): JevReply {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new WireFailure('FORMAT')
  }
  if (!plain(body)) throw new WireFailure('FORMAT')
  const { model, answers, usage, id } = body
  if (typeof model !== 'string' || model.length === 0 || model.length > 256) throw new WireFailure('FORMAT')
  if (!plain(answers) || !Object.values(answers).every(plain)) throw new WireFailure('FORMAT')
  if (!plain(usage) || !count(usage.input_tokens) || !count(usage.output_tokens))
    throw new WireFailure('FORMAT')
  const cost = usage.cost
  const micros = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 1e6) : -1
  return {
    model,
    answers,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(Number.isSafeInteger(micros) && micros >= 0 ? { usdMicros: micros } : {}),
    ...(typeof id === 'string' && id.length > 0 && id.length <= 128 ? { id } : {}),
  }
}

/**
 * The answers as compact JSON with every `<` written as an escape. A parser reads the result back to
 * the same value, and the decoder that sits between an adapter and its caller never sees the opening
 * of a tag - the vendor echoes option keys and labels verbatim, so `<think>` can appear in them.
 */
export const answersText = (answers: Record<string, unknown>): string =>
  JSON.stringify(answers).replace(/</g, '\\u003c')

/** The vendor's id for a call, when the header holds something that is safe to record. */
export function generationId(headers: Headers): string | undefined {
  const value = headers.get('x-generation-id')
  return value !== null && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined
}

export type Classified = {
  code: AiErrorCode
  retryable: boolean
  /** A fixed word naming the cause, for the message. Never taken from the response. */
  word?: string
  /** A rejected request was not run and not billed, so its spend is known to be zero. */
  zeroUsage: boolean
}

const rejected = (code: AiErrorCode, word?: string): Classified => ({
  code,
  retryable: false,
  zeroUsage: true,
  ...(word === undefined ? {} : { word }),
})

/** What a non-2xx status means. The body is consulted only for two keywords on a 400. */
export function classifyStatus(status: number, body: string): Classified {
  if (status === 400) {
    if (body.includes('max_tokens_exceeded')) return rejected('OVERFLOW', 'max_tokens_exceeded')
    if (body.includes('does not exist')) return rejected('NO_MODEL', 'model_not_found')
    return rejected('CONTRACT_MISMATCH')
  }
  if (status === 401 || status === 403) return rejected('AUTH')
  if (status === 402) return rejected('QUOTA')
  if (status === 429) return { code: 'RATE_LIMIT', retryable: true, zeroUsage: true }
  if (status === 529) return { code: 'RATE_LIMIT', retryable: true, zeroUsage: false }
  if (status >= 400 && status < 500) return rejected('CONTRACT_MISMATCH')
  return { code: 'TRANSPORT', retryable: true, zeroUsage: false }
}

/** `retry-after` as milliseconds: whole or fractional seconds, or an HTTP date. Anything else is none. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  const text = value?.trim() ?? ''
  let ms: number | undefined
  if (/^\d+(\.\d+)?$/.test(text)) ms = Math.round(Number(text) * 1000)
  else if (/[A-Za-z]/.test(text)) {
    const at = Date.parse(text)
    if (Number.isFinite(at)) ms = Math.max(0, at - now)
  }
  return ms !== undefined && Number.isSafeInteger(ms) ? ms : undefined
}

export type FailureDetail = {
  status?: number | undefined
  word?: string | undefined
  retryAfterMs?: number | undefined
  requestId?: string | undefined
}

/** One error event. The message is built from constants only: the code, the status, a fixed word. */
export function failureEvent(code: AiErrorCode, retryable: boolean, detail: FailureDetail = {}): WireEvent {
  const { status, word, retryAfterMs, requestId } = detail
  return {
    type: 'error',
    reason: code === 'ABORTED' ? 'aborted' : 'error',
    code,
    message: `${JEV_WIRE_API} ${code}${status === undefined ? '' : ` (HTTP ${status})`}${word === undefined ? '' : ` ${word}`}`,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(status === undefined
      ? {}
      : { response: { status, ...(requestId === undefined ? {} : { id: requestId }) } }),
  }
}

/** Usage for a call the vendor refused: nothing was processed and nothing is charged. */
export const zeroUsageEvent = (status: number, id?: string): WireEvent => ({
  type: 'usage',
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  creditSource: 'estimated',
  billing: { usdMicros: 0, source: 'gateway', subscription: false },
  response: { status, ...(id === undefined ? {} : { id }) },
})

/**
 * Reads at most `max` bytes of a body. Reading past it stops and cancels, and `truncated` says so.
 * Cancelling the signal cancels the read, for a network layer that would not otherwise notice.
 */
async function readBody(
  response: Response,
  max: number,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader()
  if (!reader) return { bytes: new Uint8Array(), truncated: false }
  const stop = () => void reader.cancel().catch(() => undefined)
  signal.addEventListener('abort', stop, { once: true })
  const parts: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      parts.push(next.value)
      total += next.value.byteLength
      if (total > max) {
        truncated = true
        break
      }
    }
  } finally {
    signal.removeEventListener('abort', stop)
    if (truncated) await reader.cancel().catch(() => undefined)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.byteLength
  }
  return { bytes: bytes.subarray(0, Math.min(total, max)), truncated }
}

/** A successful reply's text. A body over `max` bytes, or one that is not UTF-8, is FORMAT. */
export async function readCapped(response: Response, max: number, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel().catch(() => undefined)
    throw new WireFailure('FORMAT')
  }
  const { bytes, truncated } = await readBody(response, max, signal)
  if (truncated) throw new WireFailure('FORMAT')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new WireFailure('FORMAT')
  }
}

/** The start of an error body, for keyword classification. A body that cannot be read is empty. */
export async function readHead(response: Response, max: number, signal: AbortSignal): Promise<string> {
  try {
    return new TextDecoder().decode((await readBody(response, max, signal)).bytes)
  } catch {
    return ''
  }
}
