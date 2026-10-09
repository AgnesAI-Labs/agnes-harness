import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { WebhookRequest, WebhookResult, WebhookSnapshot } from '@agnes/protocol/gen/app-server'
import { describe, expect, it } from 'vitest'
import { webhookRoute } from '../src/webhook-route.js'

const origin = 'http://127.0.0.1:4177'
function setup(enabled = true) {
  const inputs: WebhookRequest[] = []
  const snapshot: WebhookSnapshot = {
    config: { enabled, path: '/hooks/business', maxPayloadBytes: 16 },
    rules: [],
    deliveries: [],
    secretRefs: [],
  }
  const route = webhookRoute(origin, async (input): Promise<WebhookResult> => {
    inputs.push(input)
    if (input.action !== 'deliver') return { snapshot }
    return {
      delivery: {
        id: 'receipt',
        at: 1,
        status: !enabled ? 'disabled' : input.tooLarge ? 'too-large' : 'accepted',
        sessionId: 'synthetic-session',
      },
    }
  })
  async function send(
    options: { path?: string; method?: string; body?: Buffer; headers?: Record<string, string[]> } = {},
  ) {
    const headers = { 'content-type': ['application/json'], ...options.headers }
    const request = Object.assign(Readable.from([options.body ?? Buffer.from('{}')]), {
      url: options.path ?? '/hooks/business',
      method: options.method ?? 'POST',
      headers: Object.fromEntries(Object.entries(headers).map(([key, values]) => [key, values.join(', ')])),
      headersDistinct: headers,
    }) as IncomingMessage
    let status = 0
    let body = ''
    const response = {
      writeHead(code: number) {
        status = code
        return this
      },
      end(value: string) {
        body = value
      },
    } as unknown as ServerResponse
    const handled = await route(request, response)
    return { handled, status, body: body ? JSON.parse(body) : undefined }
  }
  return { send, inputs }
}

describe('webhook HTTP boundary', () => {
  it('keeps the endpoint off by default and serves only the exact opted-in path', async () => {
    const off = setup(false)
    expect((await off.send()).status).toBe(404)
    expect(off.inputs).toContainEqual({ action: 'deliver' })
    const on = setup()
    expect((await on.send({ path: '/hooks/other' })).status).toBe(404)
    expect((await on.send({ path: '/hooks/business?alias=1' })).status).toBe(404)
    expect((await on.send({ path: '/other' })).handled).toBe(false)
    expect((await on.send({ method: 'GET' })).status).toBe(405)
    expect(on.inputs.some((input) => input.action === 'deliver')).toBe(false)
  })
  it('preserves exact signed bytes, bounds payloads, and rejects ambiguous security headers', async () => {
    const f = setup()
    const bytes = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])
    expect(
      (await f.send({ body: bytes, headers: { 'x-hub-signature-256': ['sha256=synthetic'] } })).status,
    ).toBe(202)
    const delivered = f.inputs.find((input) => input.action === 'deliver')
    expect(Buffer.from(delivered?.body ?? '', 'base64')).toEqual(bytes)
    expect(delivered?.headers?.['x-hub-signature-256']).toBe('sha256=synthetic')
    expect((await f.send({ body: Buffer.alloc(17) })).status).toBe(413)
    expect(f.inputs.at(-1)).toEqual({ action: 'deliver', tooLarge: true })
    await f.send({ headers: { authorization: ['Bearer one', 'Bearer two'] } })
    expect(f.inputs.at(-1)?.headers?.['content-type']).toBe('')
  })
  it('requires same-origin administration and blocks raw delivery actions at the UI endpoint', async () => {
    const f = setup()
    expect((await f.send({ path: '/api/triggers' })).status).toBe(403)
    expect(
      (
        await f.send({
          path: '/api/triggers',
          headers: { origin: [origin], 'sec-fetch-site': ['cross-site'] },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await f.send({
          path: '/api/triggers',
          headers: { origin: [origin] },
          body: Buffer.from('{"action":"deliver"}'),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await f.send({
          path: '/api/triggers',
          headers: { origin: [origin] },
          body: Buffer.from('{"action":"list"}'),
        })
      ).status,
    ).toBe(200)
    expect(f.inputs.some((input) => input.action === 'deliver')).toBe(false)
  })
})
