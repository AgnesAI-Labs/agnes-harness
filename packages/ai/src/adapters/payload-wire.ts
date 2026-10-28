// What the payload-only adapters (TypeSafe System One, openai-audio) share: base-URL policy, the
// failure vocabulary, the event helpers and the bounded body reads. Nothing here opens a connection.
import type { AiErrorCode } from '@agnes/protocol'
import type { WireEvent } from '../adapter.js'

/** How much of an error body is read. It only feeds keyword classification and is then dropped. */
export const MAX_ERROR_BYTES = 16 * 1024

/** A reply that cannot be used. The message is the code alone, so nothing from the wire leaks. */
export class WireFailure extends Error {
  constructor(readonly code: AiErrorCode) {
    super(code)
  }
}

export const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
}

/**
 * A route's base URL as a URL, or the reason it cannot be used. The reason is a fixed phrase and
 * never quotes the URL, which may carry a secret.
 */
export function checkedPayloadBase(baseUrl: string): URL | string {
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
  return url
}

/** `base` with `suffix` (starting with `/`) appended to its path, ignoring trailing slashes on the base. */
export function appendPath(base: URL, suffix: string): URL {
  const url = new URL(base.href)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${suffix}`
  return url
}

export type Classified = {
  code: AiErrorCode
  retryable: boolean
  /** A fixed word naming the cause, for the message. Never taken from the response. */
  word?: string
  /** A rejected request was not run and not billed, so its spend is known to be zero. */
  zeroUsage: boolean
}

/** A refused request was not run and not billed. */
export const rejected = (code: AiErrorCode, word?: string): Classified => ({
  code,
  retryable: false,
  zeroUsage: true,
  ...(word === undefined ? {} : { word }),
})

/**
 * What a non-2xx status means to every payload-only vendor: a bad key, no credit, a rate limit
 * (429 was refused before it ran; 529 may have been billed), any other refused request, a server fault.
 */
export function classifyHttpStatus(status: number): Classified {
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

/** One error event. The message is built from constants only: the api, the code, the status, a fixed word. */
export function failureEvent(
  api: string,
  code: AiErrorCode,
  retryable: boolean,
  detail: FailureDetail = {},
): WireEvent {
  const { status, word, retryAfterMs, requestId } = detail
  return {
    type: 'error',
    reason: code === 'ABORTED' ? 'aborted' : 'error',
    code,
    message: `${api} ${code}${status === undefined ? '' : ` (HTTP ${status})`}${word === undefined ? '' : ` ${word}`}`,
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
export async function readBody(
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

/** A successful reply's bytes. A body over `max` bytes is FORMAT. */
export async function readCappedBytes(
  response: Response,
  max: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel().catch(() => undefined)
    throw new WireFailure('FORMAT')
  }
  const { bytes, truncated } = await readBody(response, max, signal)
  if (truncated) throw new WireFailure('FORMAT')
  return bytes
}

/** A successful reply's text. A body over `max` bytes, or one that is not UTF-8, is FORMAT. */
export async function readCapped(response: Response, max: number, signal: AbortSignal): Promise<string> {
  const bytes = await readCappedBytes(response, max, signal)
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
