import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebhookRequest, WebhookResult } from '@agnes/protocol/gen/app-server'

export const TRIGGERS_ADMIN_PATH = '/api/triggers'
const HEADERS = [
  'x-hub-signature-256',
  'x-github-delivery',
  'x-github-event',
  'x-webhook-signature',
  'x-webhook-id',
  'x-webhook-event',
  'x-webhook-timestamp',
  'authorization',
  'content-type',
  'content-encoding',
]
function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}
/** HTTP holds no secret store or rules; a private daemon RPC owns both. */
export function webhookRoute(origin: string, invoke: (input: WebhookRequest) => Promise<WebhookResult>) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = new URL(request.url ?? '/', origin).pathname
    const admin = path === TRIGGERS_ADMIN_PATH
    if (!admin && !path.startsWith('/hooks/')) return false
    if (admin && request.url !== TRIGGERS_ADMIN_PATH) {
      reply(response, 404, { error: 'UNKNOWN_PATH' })
      return true
    }
    if (
      admin &&
      (request.headers.origin !== origin ||
        (request.headers['sec-fetch-site'] !== undefined &&
          request.headers['sec-fetch-site'] !== 'same-origin'))
    ) {
      reply(response, 403, { error: 'ORIGIN_REJECTED' })
      return true
    }
    if (request.method !== 'POST') {
      reply(response, 405, { error: 'METHOD_REJECTED' })
      return true
    }
    try {
      const snapshot = (await invoke({ action: 'list' })).snapshot
      if (!snapshot) throw new Error('Unavailable')
      if (!admin && request.url !== snapshot.config.path) {
        reply(response, 404, { error: 'UNKNOWN_PATH' })
        return true
      }
      if (!admin && !snapshot.config.enabled) {
        await invoke({ action: 'deliver' })
        reply(response, 404, { error: 'DISABLED' })
        return true
      }
      const limit = admin ? 1048576 : snapshot.config.maxPayloadBytes
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.length
        if (size > limit) {
          const result = admin ? { error: 'TOO_LARGE' } : await invoke({ action: 'deliver', tooLarge: true })
          reply(response, 413, result)
          return true
        }
        chunks.push(bytes)
      }
      if (
        admin &&
        (!/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(
          request.headers['content-type'] ?? '',
        ) ||
          request.headers['content-encoding'] !== undefined)
      ) {
        reply(response, 415, { error: 'INVALID_PAYLOAD' })
        return true
      }
      const body = Buffer.concat(chunks)
      let result: WebhookResult
      if (admin) {
        const input = JSON.parse(body.toString('utf8')) as WebhookRequest
        if (!['list', 'configure', 'upsert', 'delete', 'test'].includes(input.action)) {
          reply(response, 400, { error: 'INVALID_REQUEST' })
          return true
        }
        result = await invoke(input)
      } else {
        const headers: Record<string, string> = { 'content-type': request.headers['content-type'] ?? '' }
        let ambiguous = false
        for (const key of HEADERS) {
          const values = request.headersDistinct[key]
          // Duplicated security headers are not combined or silently selected.
          if (values && values.length !== 1) ambiguous = true
          if (values?.length === 1 && values[0]) headers[key] = values[0]
        }
        if (ambiguous) headers['content-type'] = ''
        result = await invoke({ action: 'deliver', body: body.toString('base64'), headers })
      }
      const status = result.delivery?.status
      reply(
        response,
        admin
          ? 200
          : status === 'accepted'
            ? 202
            : status === 'duplicate'
              ? 409
              : status === 'rate-limited' || status === 'capacity'
                ? 429
                : status === 'bad-signature'
                  ? 401
                  : status === 'too-large'
                    ? 413
                    : status === 'disabled'
                      ? 404
                      : status === 'failed'
                        ? 503
                        : 422,
        result,
      )
    } catch {
      reply(response, 400, { error: 'TRIGGER_REQUEST_FAILED' })
    }
    return true
  }
}
