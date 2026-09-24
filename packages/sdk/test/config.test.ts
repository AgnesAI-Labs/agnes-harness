import { expect, it, vi } from 'vitest'
import { createClient } from '../src/client.js'
import { ProtocolViolation } from '../src/errors.js'
import { memoryJournal } from '../src/journal.js'
import { fakeEndpoint } from './helpers/fake-endpoint.js'

it('configuration passes through the protocol without putting credentials into the replay journal', async () => {
  const journal = memoryJournal()
  const record = vi.spyOn(journal, 'markPending')
  const snapshot = {
    profile: 'local-dev',
    revision: 1,
    configured: true,
    provider: { id: 'p', baseUrl: 'http://localhost/v1', model: 'm', credentialConfigured: true },
    effect: 'new-sessions',
  }
  let leak = false
  const server = fakeEndpoint({
    initialize: fakeEndpoint({}).initialize,
    '_agnes/v1/config.test': () => ({ verified: true, models: [{ id: 'm', name: 'Model' }] }),
    '_agnes/v1/config.save': () => snapshot,
    '_agnes/v1/config.account': () => snapshot,
    '_agnes/v1/config.get': () => (leak ? { ...snapshot, apiKey: 'fixture-secret' } : snapshot),
  })
  const client = createClient({ transport: { kind: 'inproc', endpoint: server.endpoint }, journal })
  try {
    await expect(client.config.test({ providerId: 'p', apiKey: 'fixture-secret' })).resolves.toMatchObject({
      verified: true,
    })
    await expect(
      client.config.save({ providerId: 'p', apiKey: 'fixture-secret', model: 'm', expectedRevision: 0 }),
    ).resolves.toEqual(snapshot)
    await expect(
      client.config.account({ accountId: 'work', action: 'disable', expectedRevision: 1 }),
    ).resolves.toEqual(snapshot)
    expect(record).not.toHaveBeenCalled()
    await expect(client.config.get()).resolves.toEqual(snapshot)
    leak = true
    await expect(client.config.get()).rejects.toBeInstanceOf(ProtocolViolation)
  } finally {
    await client.close()
  }
})
