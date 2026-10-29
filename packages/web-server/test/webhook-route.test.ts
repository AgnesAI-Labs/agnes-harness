import { IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { validateAgainst } from '@agnes/protocol'
import type { WebhookRequest, WebhookResult, WebhookSnapshot } from '@agnes/protocol/gen/app-server'
import { WebhookRequest as WebhookRequestSchema } from '@agnes/protocol/gen/app-server'
import { describe, expect, it } from 'vitest'
import { webhookRoute } from '../src/webhook-route.js'

const origin = 'http://127.0.0.1:4177'
function setup(enabled = true, deliveryResult?: WebhookResult) {
  const inputs: WebhookRequest[] = []
  const snapshot: WebhookSnapshot = {
    config: { enabled, path: '/hooks/business', maxPayloadBytes: 16 },
    rules: [],
    deliveries: [],
    secretRefs: [],
  }
  const route = webhookRoute(origin, async (input): Promise<WebhookResult> => {
    if (!validateAgainst(WebhookRequestSchema, input).ok) throw new Error('Invalid webhook request')
    inputs.push(input)
    if (input.action !== 'deliver') return { snapshot }
    if (deliveryResult) return deliveryResult
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
    const request = new IncomingMessage(new Socket())
    request.url = options.path ?? '/hooks/business'
    request.method = options.method ?? 'POST'
    request.headers = Object.fromEntries(
      Object.entries(headers).map(([key, values]) => [key, values.join(', ')]),
    )
    request.rawHeaders = Object.entries(headers).flatMap(([key, values]) =>
      values.flatMap((value) => [key, value]),
    )
    request.headersDistinct = headers
    request.push(options.body ?? Buffer.from('{}'))
    request.push(null)
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
    expect(delivered?.headers).toMatchObject({ 'x-hub-signature-256': 'sha256=synthetic' })
    expect((await f.send({ body: Buffer.alloc(17) })).status).toBe(413)
    expect(f.inputs.at(-1)).toEqual({ action: 'deliver', tooLarge: true })
    await f.send({ headers: { authorization: ['Bearer one', 'Bearer two'] } })
    expect(f.inputs.at(-1)?.headers).toMatchObject({ 'content-type': '' })
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
    for (const input of [
      { action: 'list', unexpected: true },
      { action: 'list', ruleId: 123 },
      { action: 'list', config: { enabled: 'yes' } },
      null,
    ])
      expect(
        (
          await f.send({
            path: '/api/triggers',
            headers: { origin: [origin] },
            body: Buffer.from(JSON.stringify(input)),
          })
        ).status,
      ).toBe(400)
    const beforeList = f.inputs.length
    expect(
      (
        await f.send({
          path: '/api/triggers',
          headers: { origin: [origin] },
          body: Buffer.from('{"action":"list"}'),
        })
      ).status,
    ).toBe(200)
    expect(f.inputs.slice(beforeList)).toEqual([{ action: 'list' }])
    expect(f.inputs.some((input) => input.action === 'deliver')).toBe(false)
  })
})

it('preserves delivery status HTTP mappings and the missing-delivery fallback', async () => {
  for (const [status, httpStatus] of [
    ['accepted', 202],
    ['duplicate', 409],
    ['rate-limited', 429],
    ['capacity', 429],
    ['bad-signature', 401],
    ['too-large', 413],
    ['disabled', 404],
    ['failed', 503],
    ['invalid-payload', 422],
    ['pending', 422],
    ['no-rule', 422],
    ['replay', 422],
    ['unknown', 422],
    ['waiting_approval', 422],
    ['needs_attention', 422],
    ['ran', 422],
  ] as const) {
    const delivery = { id: 'synthetic', at: 1, status }
    const f = setup(true, { delivery })
    expect(await f.send()).toMatchObject({ status: httpStatus, body: { delivery } })
    expect(
      (
        await f.send({
          path: '/api/triggers',
          headers: { origin: [origin] },
          body: Buffer.from('{"action":"test","ruleId":"synthetic"}'),
        })
      ).status,
    ).toBe(200)
  }
  expect((await setup(true, {}).send()).status).toBe(422)
})
