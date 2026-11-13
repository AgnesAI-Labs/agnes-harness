import type { IncomingMessage, ServerResponse } from 'node:http'
import { CLOUD_AUTHORIZATION_PATH, validateMethod } from '@agnes/protocol'
import type { AdminCloudAuthorization, AdminCloudAuthorize } from '@agnes/protocol/gen/app-server'

/** A-only fixed BFF. The daemon resolves the reference and exchanges the Key; it never returns it. */
export function cloudAuthorizationRelay(
  origin: string,
  invoke: (input: AdminCloudAuthorize) => Promise<AdminCloudAuthorization>,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', origin)
    if (url.pathname !== CLOUD_AUTHORIZATION_PATH) return false
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(value))
    }
    if (
      request.method !== 'POST' ||
      url.search ||
      request.headers.host !== new URL(origin).host ||
      request.headers.origin !== origin ||
      (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')
    ) {
      request.resume()
      reply(403, { error: 'CLOUD_ORIGIN_DENIED' })
      return true
    }
    try {
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw Error('input')
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        const part = Buffer.from(chunk)
        bytes += part.length
        if (bytes > 8192) throw Error('input')
        chunks.push(part)
      }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!validateMethod('_agnes/v1/admin.cloud.authorize', 'params', input).ok) throw Error('input')
      const result = await invoke(input as AdminCloudAuthorize)
      if (!validateMethod('_agnes/v1/admin.cloud.authorize', 'result', result).ok) throw Error('response')
      reply(200, result)
    } catch (error) {
      const reason = (error as { data?: { reason?: unknown } })?.data?.reason
      reply(400, {
        error:
          reason === 'CONFIG_CREDENTIAL_NOT_FOUND' || reason === 'CONFIG_CREDENTIAL_REJECTED'
            ? reason
            : 'CLOUD_AUTH_UNAVAILABLE',
      })
    }
    return true
  }
}
