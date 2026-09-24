import { Agent, request } from 'undici'
import { createPinnedLookup, resolvePublicAddresses } from './network.js'

export interface PublicResponse {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: AsyncIterable<Uint8Array>
  close(): Promise<void>
}
export type PublicTransport = (url: URL, signal: AbortSignal) => Promise<PublicResponse>

/** A private dispatcher prevents reuse of a connection resolved under a different policy. */
export const requestPublic: PublicTransport = async (url, signal) => {
  const addresses = await resolvePublicAddresses(url.hostname, signal)
  signal.throwIfAborted()
  const dispatcher = new Agent({
    maxHeaderSize: 16 * 1024,
    autoSelectFamily: true,
    connect: { lookup: createPinnedLookup(addresses) },
  })
  try {
    // request (unlike fetch) does not transparently decompress the response body.
    const result = await request(url, {
      dispatcher,
      method: 'GET',
      signal,
      headers: {
        'user-agent': 'agnes-harness',
        accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
        'accept-encoding': 'identity',
      },
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
    })
    // Observing stream errors also covers early MIME/redirect rejection before iteration starts.
    result.body.on('error', () => {})
    return {
      ...result,
      close: async () => {
        result.body.destroy()
        await dispatcher.destroy()
      },
    }
  } catch (error) {
    await dispatcher.destroy()
    throw error
  }
}
