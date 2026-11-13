import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { CLOUD_AUTHORIZATION_PATH } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { cloudAuthorizationRelay } from './cloud-authorization.js'

it('accepts only same-origin credential references and never reflects raw daemon failures or secret-bearing responses', async () => {
  const origin = 'http://127.0.0.1:4177'
  const input = {
    origin: 'http://cloud.fixture:8443',
    credentialRef: 'secret://generic/11111111-1111-1111-1111-111111111111',
  }
  const authorization = {
    token: `zzzzzzzz.${'A'.repeat(22)}.${'B'.repeat(43)}`,
    expiresAt: Date.now() + 60_000,
  }
  let mode = 'success'
  let calls = 0
  const relay = cloudAuthorizationRelay(origin, async (value) => {
    expect(value).toEqual(input)
    calls++
    if (mode === 'throw') throw new Error('private-fixture-Key')
    return mode === 'echo' ? { ...authorization, key: 'private-fixture-Key' } : authorization
  })
  async function call(body: object, headers: Record<string, string> = {}, url = CLOUD_AUTHORIZATION_PATH) {
    const request = Object.assign(Readable.from([JSON.stringify(body)]), {
      url,
      method: 'POST',
      headers: { host: new URL(origin).host, origin, 'content-type': 'application/json', ...headers },
    }) as IncomingMessage
    let status = 0
    let result = ''
    const response = {
      writeHead(code: number) {
        status = code
        return this
      },
      end(text: string) {
        result = text
      },
    } as unknown as ServerResponse
    expect(await relay(request, response)).toBe(true)
    return { status, body: JSON.parse(result) }
  }
  for (const headers of [
    { origin: 'http://foreign.test' },
    { host: 'foreign.test' },
    { 'sec-fetch-site': 'cross-site' },
  ])
    expect((await call(input, headers)).status).toBe(403)
  expect((await call({ ...input, key: 'must-not-accept-a-raw-key' })).status).toBe(400)
  expect(calls).toBe(0)
  expect(await call(input)).toEqual({ status: 200, body: authorization })
  for (mode of ['throw', 'echo']) {
    const denied = await call(input)
    expect(denied.status).toBe(400)
    expect(JSON.stringify(denied)).not.toContain('private-fixture-Key')
    expect(denied.body).toEqual({ error: 'CLOUD_AUTH_UNAVAILABLE' })
  }
})
