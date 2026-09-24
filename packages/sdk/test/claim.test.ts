import { afterEach, describe, expect, it } from 'vitest'
import { localAuth } from '../src/auth.js'
import { type Client, createClient } from '../src/client.js'
import { ClaimDenied } from '../src/errors.js'
import { memoryJournal } from '../src/journal.js'
import { fakeEndpoint, type Handler } from './helpers/fake-endpoint.js'

const open: Client[] = []
const providers = { local: () => localAuth() }

function clientFor(claim: Handler, strict = false) {
  const stock = fakeEndpoint({})
  const fake = fakeEndpoint({ initialize: stock.initialize, '_agnes/v1/auth.claim': claim })
  const client = createClient({
    transport: { kind: 'inproc', endpoint: fake.endpoint },
    journal: memoryJournal(),
    authProviders: providers,
    timeouts: { claim: 30 },
    claimStrict: strict,
  })
  open.push(client)
  return { client, fake }
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()))
})

describe('claim', () => {
  it('returns true only for an explicitly granted result', async () => {
    expect(await clientFor(() => ({ granted: true, slot: 2 })).client.claim.once('link', 'abc')).toBe(true)
    expect(await clientFor(() => ({ granted: false })).client.claim.once('link', 'abc')).toBe(false)
    expect(
      await clientFor(() => ({ granted: true })).client.claim.withinRateLimit('msg', 'u1', 5, 60_000),
    ).toBe(true)
  })

  it('sends the two protocol request shapes and uses the claim timeout', async () => {
    const { client, fake } = clientFor(() => ({ granted: true }))
    await client.claim.once('link', 'abc', 123)
    await client.claim.withinRateLimit('msg', 'u1', 5, 60_000)
    expect(
      fake.calls.filter((call) => call.method === '_agnes/v1/auth.claim').map((call) => call.params),
    ).toEqual([
      { kind: 'link', value: 'abc', expiresAtMs: 123 },
      { kind: 'msg', value: 'u1', limit: 5, windowMs: 60_000 },
    ])
  })

  it('fails closed on refusal, invalid results, errors, and timeout', async () => {
    const denied = Object.assign(new Error('CLAIM_DENIED'), { code: -32010 })
    expect(await clientFor(() => Promise.reject(denied)).client.claim.once('k', 'v')).toBe(false)
    expect(await clientFor(() => ({ granted: 'yes' })).client.claim.once('k', 'v')).toBe(false)
    expect(await clientFor(() => new Promise(() => undefined)).client.claim.once('k', 'v')).toBe(false)
  })

  it('turns every non-grant into ClaimDenied in strict mode', async () => {
    await expect(
      clientFor(() => ({ granted: false }), true).client.claim.once('k', 'v'),
    ).rejects.toBeInstanceOf(ClaimDenied)
    await expect(
      clientFor(() => new Promise(() => undefined), true).client.claim.once('k', 'v'),
    ).rejects.toBeInstanceOf(ClaimDenied)
  })
})
