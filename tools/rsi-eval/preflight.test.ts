import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { explainPreflight, preflightRequest, runPreflight } from './preflight.js'
import type { RunConfig } from './types.js'

const KEY = 'sk-live-preflight-secret-0123456789'
const cfg = (upstream: string, over: Partial<RunConfig> = {}): RunConfig => ({
  provider: 'deepseek',
  api: 'anthropic-messages',
  upstream,
  model: 'deepseek-chat',
  keyEnv: 'RSI_TEST_KEY',
  prices: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  proxyPort: 0,
  sessionTimeoutMs: 1000,
  ...over,
})

type Seen = { url: string; headers: http.IncomingHttpHeaders; body: string }
let server: http.Server | undefined
const seen: Seen[] = []
const upstream = async (status: number, body: unknown): Promise<string> => {
  seen.length = 0
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic`
}
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
})

describe('the preflight request', () => {
  it('is one small call in the wire format of the configured API', () => {
    expect(preflightRequest({ api: 'anthropic-messages', model: 'm' }, 'k')).toMatchObject({
      path: '/v1/messages',
      headers: { 'x-api-key': 'k' },
      body: { model: 'm', max_tokens: 8 },
    })
    expect(preflightRequest({ api: 'openai-completions', model: 'm' }, 'k')).toMatchObject({
      path: '/chat/completions',
      headers: { authorization: 'Bearer k' },
    })
    expect(preflightRequest({ api: 'openai-responses', model: 'm' }, 'k')?.path).toBe('/responses')
    expect(preflightRequest({ api: 'something-else', model: 'm' }, 'k')).toBeUndefined()
  })
})

describe('explaining the answer', () => {
  const c = { model: 'deepseek-chat', keyEnv: 'RSI_TEST_KEY', upstream: 'https://api.example.test' }
  it('says what each failure means', () => {
    expect(explainPreflight(200, '', c)).toMatchObject({ ok: true })
    expect(explainPreflight(402, '{"error":{"message":"Insufficient Balance"}}', c).message).toMatch(
      /out of balance.*Insufficient Balance/,
    )
    expect(explainPreflight(401, '', c).message).toContain('RSI_TEST_KEY')
    expect(
      explainPreflight(404, '{"error":{"message":"The model `x` does not exist"}}', c).message,
    ).toContain('model name looks wrong')
    expect(explainPreflight(404, 'not found', c).message).toContain('upstream')
    expect(explainPreflight(429, '', c).message).toContain('rate limiting')
    expect(explainPreflight(503, '', c).message).toContain('server problem')
    expect(explainPreflight(502, 'upstream unreachable: ECONNREFUSED', c).message).toContain(
      'cannot be reached',
    )
    for (const status of [401, 402, 404, 429, 503]) expect(explainPreflight(status, '', c).ok).toBe(false)
  })
})

describe('running the preflight', () => {
  const env = { RSI_TEST_KEY: KEY }

  it('passes when the upstream answers, with the key sent upstream and nowhere else', async () => {
    const url = await upstream(200, { model: 'deepseek-chat', usage: { input_tokens: 5, output_tokens: 2 } })
    const result = await runPreflight(cfg(url), env)
    expect(result).toEqual({ ok: true, message: 'the upstream answered 200 for model deepseek-chat' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('/anthropic/v1/messages')
    expect(seen[0]?.headers['x-api-key']).toBe(KEY)
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  it('tells the user when the balance is out, and never repeats the key from the upstream body', async () => {
    const url = await upstream(402, { error: { message: `Insufficient Balance for ${KEY}` } })
    const result = await runPreflight(cfg(url), env)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('out of balance')
    expect(result.message).toContain('Insufficient Balance')
    expect(result.message).not.toContain(KEY)
  })

  it('tells the user when the model name is wrong', async () => {
    const url = await upstream(400, { error: { message: 'Model Not Exist' } })
    expect((await runPreflight(cfg(url), env)).message).toContain('model name looks wrong')
  })

  it('makes no call and says the key is missing when the variable is not set', async () => {
    const url = await upstream(200, {})
    for (const empty of [{}, { RSI_TEST_KEY: '  ' }]) {
      const result = await runPreflight(cfg(url), empty)
      expect(result.ok).toBe(false)
      expect(result.message).toContain('RSI_TEST_KEY')
      expect(result.message).toContain('missing')
    }
    expect(seen).toHaveLength(0)
  })

  it('says so when the upstream cannot be reached', async () => {
    const url = await upstream(200, {})
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
    const result = await runPreflight(cfg(url), env)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('cannot be reached')
  })

  it('refuses an API it does not know', async () => {
    const result = await runPreflight(cfg('http://127.0.0.1:1', { api: 'weird' }), env)
    expect(result.message).toContain('does not know the API')
  })
})
