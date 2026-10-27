// The TypeSafe System One wire format as pure functions: the request body, the reply envelope, the
// status classification and the bounded body reads. Nothing here opens a connection; index.ts does.
import type { AiErrorCode, JsonValue, RequestBody } from '@agnes/protocol'
import type { WireEvent } from '../../adapter.js'
import {
  appendPath,
  type Classified,
  checkedPayloadBase,
  type FailureDetail,
  failureEvent as payloadFailureEvent,
  plain,
  WireFailure,
} from '../payload-wire.js'

// The shared half of the payload-only wire code lives in payload-wire.ts; the names the Jev adapter and
// its tests import stay available from here.
export {
  type Classified,
  type FailureDetail,
  MAX_ERROR_BYTES,
  parseRetryAfter,
  readCapped,
  readHead,
  WireFailure,
  zeroUsageEvent,
} from '../payload-wire.js'

export const JEV_WIRE_API = 'typesafe-systemone'
/** The largest reply accepted: far above any answer set, and small enough to hold in memory. */
export const MAX_RESPONSE_BYTES = 1024 * 1024

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

/**
 * Where a route's calls go: the base URL with `/systemone` appended, or the reason the base URL
 * cannot be used.
 */
export function endpointFor(baseUrl: string): URL | string {
  const base = checkedPayloadBase(baseUrl)
  return typeof base === 'string' ? base : appendPath(base, '/systemone')
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

/** One error event. The message is built from constants only: the code, the status, a fixed word. */
export const failureEvent = (code: AiErrorCode, retryable: boolean, detail: FailureDetail = {}): WireEvent =>
  payloadFailureEvent(JEV_WIRE_API, code, retryable, detail)
