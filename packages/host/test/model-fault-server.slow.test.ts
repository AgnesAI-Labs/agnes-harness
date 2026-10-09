import { expect, it } from 'vitest'
import { startModelFaultServer } from '@agnes/host/author-testkit'

it('scripts latency, 429/5xx, SSE, truncation and malformed chunks without capturing secrets', async () => {
  const server = await startModelFaultServer([
    { kind: 'http', status: 429, retryAfterMs: 1500 },
    { kind: 'http', status: 503 },
    { kind: 'sse', chunks: [{ choices: [{ delta: { content: 'hello' } }] }], latencyMs: 1, chunkDelayMs: 1 },
    { kind: 'truncated', chunks: [{ partial: true }] },
    { kind: 'malformed' },
  ])
  try {
    expect(() => server.assertConsumed()).toThrow()
    const send = () =>
      fetch(server.baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer synthetic-private-value' },
        body: '{}',
      })
    const limited = await send()
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('2')
    await limited.text()
    const failed = await send()
    expect(failed.status).toBe(503)
    await failed.text()
    const sse = await send()
    expect(sse.headers.get('content-type')).toBe('text/event-stream')
    expect(await sse.text()).toContain('data: [DONE]')
    expect(await (await send()).text()).not.toContain('[DONE]')
    expect(await (await send()).text()).toContain('{malformed-json')
    expect(JSON.stringify(server.requests)).not.toContain('synthetic-private-value')
    server.assertConsumed()
    const exhausted = await send()
    expect(exhausted.status).toBe(500)
    expect(await exhausted.text()).toContain('FIXTURE_EXHAUSTED')
    expect(() => server.assertConsumed()).toThrow()
  } finally {
    await server.close()
  }
  await server.close()
})

it('force-closes delayed connections and rejects invalid timer/status scripts', async () => {
  await expect(startModelFaultServer([{ kind: 'http', status: 429, latencyMs: -1 }])).rejects.toThrow('timer')
  await expect(startModelFaultServer([{ kind: 'http', status: 999 }])).rejects.toThrow('status')
  const server = await startModelFaultServer([
    { kind: 'sse', chunks: [{ delayed: true }], chunkDelayMs: 60000 },
  ])
  const response = await fetch(server.baseUrl)
  const body = response.text().catch((error: unknown) => error)
  await server.close()
  expect(await body).toBeInstanceOf(Error)
})
