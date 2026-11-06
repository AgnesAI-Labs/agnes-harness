import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

/** Supplies credentials per HTTP request instead of fixing them when the connection opens. */
export type McpHttpAuthorizer = Readonly<{
  /** Headers for this request. Throwing refuses to send it; the error reaches the caller as is. */
  headers(signal?: AbortSignal): Promise<Readonly<Record<string, string>>>
  /**
   * Called at most once per request, with its 401 or 403 response and the object `headers()`
   * returned for it. 'retry' resends it once with fresh headers; throwing ends the request with
   * that error.
   */
  rejected(response: Response, sent: Readonly<Record<string, string>>): Promise<'retry' | 'fail'>
}>

/**
 * Wraps the transport fetch: every request asks the authorizer for its headers first, and a 401 or
 * 403 is shown to the authorizer once, which may ask for one resend. The second answer goes back
 * as is, so one request never costs more than two sends.
 *
 * Every header name the authorizer hands out joins `credentialHeaderNames`, the set the redirect
 * handling strips on a cross-origin hop. `onRefusal` sees every error the authorizer throws, so the
 * caller can report it even where the SDK replaces it with its own error (the SSE event stream does).
 */
export function authorizedFetch(
  fetchImpl: FetchLike,
  authorizer: McpHttpAuthorizer,
  credentialHeaderNames: Set<string>,
  onRefusal: (error: unknown) => void,
): FetchLike {
  const ask = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step()
    } catch (error) {
      onRefusal(error)
      throw error
    }
  }
  const send = (
    input: string | URL,
    init: RequestInit | undefined,
    extra: Readonly<Record<string, string>>,
  ) => {
    const headers = new Headers(init?.headers)
    for (const [name, value] of Object.entries(extra)) {
      credentialHeaderNames.add(name.toLowerCase())
      headers.set(name, value)
    }
    return fetchImpl(input, { ...init, headers: Object.fromEntries(headers.entries()) })
  }
  return async (input, init) => {
    const signal = init?.signal ?? undefined
    const first = await ask(() => authorizer.headers(signal))
    const response = await send(input, init, first)
    if (response.status !== 401 && response.status !== 403) return response
    let decision: 'retry' | 'fail'
    try {
      decision = await ask(() => authorizer.rejected(response, first))
    } catch (error) {
      await response.body?.cancel().catch(() => undefined)
      throw error
    }
    if (decision !== 'retry') return response
    await response.body?.cancel().catch(() => undefined)
    return send(input, init, await ask(() => authorizer.headers(signal)))
  }
}
