import type { FetchInit } from '@agnes/extension-api'

/**
 * The fetch a tool reaches through ToolContext.net when the deployment supplies none. It is not
 * global fetch: FetchInit carries `timeoutMs`, which fetch does not understand and would silently
 * drop, and a body of Bytes, which is copied into an ArrayBuffer-backed view because a view over
 * shared memory is not a legal request body.
 */
export function createNetFetch(
  options: { signal?: AbortSignal; redirect?: 'error' } = {},
): (url: string, init?: FetchInit) => Promise<Response> {
  return (url, init) => {
    const { timeoutMs, body, ...rest } = init ?? {}
    const signals = [
      ...(options.signal ? [options.signal] : []),
      ...(timeoutMs === undefined ? [] : [AbortSignal.timeout(timeoutMs)]),
    ]
    return fetch(url, {
      ...rest,
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : new Uint8Array(body) }),
      ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
      ...(options.redirect ? { redirect: options.redirect } : {}),
    })
  }
}
