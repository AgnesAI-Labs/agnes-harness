import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

/** Supplies credentials per HTTP request instead of fixing them when the connection opens. */
export type McpHttpAuthorizer = Readonly<{
  /**
   * Headers for one send of a request. Throwing refuses to send it; the error reaches the caller as
   * is. `resendOf` is set for the one resend: the headers the first send carried.
   */
  headers(
    signal?: AbortSignal,
    resendOf?: Readonly<Record<string, string>>,
  ): Promise<Readonly<Record<string, string>>>
  /**
   * Shown each 401 or 403 answer, with the object `headers()` returned for that send. For the first
   * send, 'retry' resends the request once. The resend's answer is `final`: there is no third send,
   * so 'retry' counts as 'fail'. Throwing ends the request with that error.
   */
  rejected(
    response: Response,
    sent: Readonly<Record<string, string>>,
    final: boolean,
  ): Promise<'retry' | 'fail'>
}>

/**
 * Wraps the transport fetch: every request asks the authorizer for its headers first, and a 401 or
 * 403 is shown to the authorizer, which may ask for one resend. The resend's 401 or 403 is shown
 * too, as final, so the authorizer can turn it into its own error; one request never costs more
 * than two sends.
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
  const refused = (response: Response) => response.status === 401 || response.status === 403
  const judge = async (response: Response, sent: Readonly<Record<string, string>>, final: boolean) => {
    try {
      return await ask(() => authorizer.rejected(response, sent, final))
    } catch (error) {
      await response.body?.cancel().catch(() => undefined)
      throw error
    }
  }
  return async (input, init) => {
    const signal = init?.signal ?? undefined
    const first = await ask(() => authorizer.headers(signal))
    const response = await send(input, init, first)
    if (!refused(response) || (await judge(response, first, false)) !== 'retry') return response
    await response.body?.cancel().catch(() => undefined)
    const second = await ask(() => authorizer.headers(signal, first))
    const resent = await send(input, init, second)
    if (refused(resent)) await judge(resent, second, true)
    return resent
  }
}
