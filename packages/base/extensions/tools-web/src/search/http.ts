import { SearchProviderError } from './contract.js'

export type FetchLike = typeof fetch

export function callerAborted(caller: AbortSignal, timed: AbortSignal): boolean {
  return caller.aborted && !timed.aborted
}

export function mapTransportError(error: unknown, caller: AbortSignal, timed: AbortSignal): never {
  if (callerAborted(caller, timed)) throw error
  if (
    timed.aborted ||
    (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError'))
  )
    throw new SearchProviderError('SEARCH_TIMEOUT', 'The search provider timed out.')
  throw new SearchProviderError('SEARCH_NETWORK_FAILED', 'The search provider connection failed.')
}

export async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  caller: AbortSignal,
  timed: AbortSignal,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.any([caller, timed]) })
  } catch (error) {
    mapTransportError(error, caller, timed)
  }
  if (!response.ok) {
    // Classify only the HTTP status; upstream response bodies may contain credentials.
    const failures = {
      401: ['SEARCH_AUTH_FAILED', 'The search provider rejected the API key (HTTP 401).'],
      402: ['SEARCH_PAYMENT_REQUIRED', 'The search provider requires payment or credits (HTTP 402).'],
      403: ['SEARCH_ACCESS_DENIED', 'The search provider denied access (HTTP 403).'],
      429: ['SEARCH_RATE_LIMITED', 'The search provider rate limit was reached.'],
    } as const
    const failure = failures[response.status as keyof typeof failures]
    void response.body?.cancel().catch(() => undefined)
    throw new SearchProviderError(
      failure?.[0] ?? 'SEARCH_FAILED',
      failure?.[1] ?? `The search provider returned HTTP ${response.status}.`,
    )
  }
  let raw = ''
  try {
    raw = await response.text()
  } catch (error) {
    mapTransportError(error, caller, timed)
  }
  if (raw.length > 1_000_000)
    throw new SearchProviderError('SEARCH_FAILED', 'The search provider response was too large.')
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new SearchProviderError('SEARCH_FAILED', 'The search provider returned an unreadable response.')
  }
}
