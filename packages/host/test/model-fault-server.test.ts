import { expect, it } from 'vitest'
import { startModelFaultServer } from '@agnes/host/author-testkit'

it('returns scripted HTTP failures and fails closed on exhaustion without retaining request bodies', async () => {
  const server = await startModelFaultServer([
    { kind: 'http', status: 429, body: { error: { message: 'retry' } } },
  ])
  try {
    const reply = await fetch(server.baseUrl, { method: 'POST', body: 'synthetic-private-value' })
    expect(reply.status).toBe(429)
    expect(await reply.json()).toEqual({ error: { message: 'retry' } })
    server.assertConsumed()
    expect(server.requests).toEqual([{ attempt: 1, kind: 'http' }])
    const extra = await fetch(server.baseUrl)
    expect(await extra.json()).toEqual({ error: { code: 'FIXTURE_EXHAUSTED' } })
    expect(() => server.assertConsumed()).toThrow('not fully consumed')
  } finally {
    await server.close()
  }
})
