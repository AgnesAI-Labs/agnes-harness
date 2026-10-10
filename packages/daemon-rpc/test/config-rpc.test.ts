import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { ConfigurationService } from '@agnes/host'
import { expect, it, vi } from 'vitest'
import { registerConfiguration } from '../src/local/methods/config.js'

const snapshot = {
  profile: 'local-dev',
  revision: 1,
  configured: true,
  provider: { id: 'p', baseUrl: 'http://localhost', model: 'm', credentialConfigured: true },
  effect: 'new-sessions' as const,
}
function service() {
  return {
    get: vi.fn(async () => snapshot),
    providers: vi.fn(async () => ({ providers: [] })),
    test: vi.fn(async () => ({ models: [], verified: true })),
    save: vi.fn(async () => snapshot),
    account: vi.fn(async () => snapshot),
    profileInput: vi.fn(async () => ({})),
  } satisfies ConfigurationService
}
function endpoint(local: boolean, configuration?: ConfigurationService) {
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'test' })
  ep.conn.initialized = true
  ep.conn.authKind = local ? 'local' : 'jwt'
  ep.conn.credentialKind = local ? 'local' : 'jwt'
  registerConfiguration(ep, configuration)
  return ep
}
const request = (ep: LocalEndpoint, method: string, params: unknown = {}) =>
  ep.handle({ jsonrpc: '2.0', id: 1, method, params })

it('gates OAuth locally, supplies connection ownership/lifetime and applies a committed snapshot', async () => {
  const oauth = vi.fn<NonNullable<ConfigurationService['oauth']>>(async () => ({
    operationId: 'op',
    state: 'saved' as const,
    snapshot,
  }))
  const local = endpoint(true, { ...service(), oauth }),
    remote = endpoint(false, { ...service(), oauth })
  try {
    expect(
      await request(remote, '_agnes/v1/config.oauth', { action: 'poll', operationId: 'op' }),
    ).toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
    expect(oauth).not.toHaveBeenCalled()
    expect(
      await request(local, '_agnes/v1/config.oauth', { action: 'commit', operationId: 'op', model: 'm' }),
    ).toMatchObject({ result: { snapshot: { effect: 'restart-required' } } })
    expect(oauth.mock.calls[0]?.[1]).toBe(local.conn)
  } finally {
    await local.close()
    await remote.close()
  }
})

it('permits shared local configuration but denies nonlocal identities and absent services', async () => {
  const s = service()
  const local = endpoint(true, s),
    remote = endpoint(false, s),
    missing = endpoint(true)
  try {
    expect(await request(local, '_agnes/v1/config.get')).toMatchObject({ result: snapshot })
    expect(await request(remote, '_agnes/v1/config.save', { providerId: 'p', model: 'm' })).toMatchObject({
      error: { message: 'CAPABILITY_DENIED' },
    })
    expect(s.save).not.toHaveBeenCalled()
    expect(await request(missing, '_agnes/v1/config.get')).toMatchObject({
      error: { message: 'CAPABILITY_DENIED' },
    })
  } finally {
    await Promise.all([local.close(), remote.close(), missing.close()])
  }
})
it('redacts provider errors and reports persisted-but-not-applied configuration honestly', async () => {
  const s = service(),
    ep = endpoint(true, s)
  s.test.mockRejectedValue(new Error('https://secret-key@example.invalid upstream secret-key'))
  try {
    const result = await request(ep, '_agnes/v1/config.test', { providerId: 'p', apiKey: 'secret-key' })
    expect(JSON.stringify(result)).not.toContain('secret-key')
    expect(result).toMatchObject({ error: { data: { reason: 'CONFIG_FAILED' } } })
  } finally {
    await ep.close()
  }
  const apply = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
  apply.conn.initialized = true
  apply.conn.authKind = 'local'
  apply.conn.credentialKind = 'local'
  registerConfiguration(apply, s, async () => {
    throw new Error('reload failure')
  })
  try {
    expect(await request(apply, '_agnes/v1/config.save', { providerId: 'p', model: 'm' })).toMatchObject({
      result: { effect: 'restart-required', revision: 1 },
    })
  } finally {
    await apply.close()
  }
})

it('fails closed when child engine methods are absent', async () => {
  const ep = endpoint(true, service())
  try {
    expect(await request(ep, '_agnes/v1/config.childEngines.get')).toMatchObject({
      error: { data: { reason: 'CONFIG_FAILED' } },
    })
  } finally {
    await ep.close()
  }
})

it('applies account changes through the same authenticated configuration callback', async () => {
  const s = service(),
    ep = endpoint(true, s),
    denied = endpoint(false, s)
  const params = { accountId: 'work', action: 'disable', expectedRevision: 1 }
  expect(await request(denied, '_agnes/v1/config.account', params)).toMatchObject({
    error: { message: 'CAPABILITY_DENIED' },
  })
  expect(s.account).not.toHaveBeenCalled()
  expect(await request(ep, '_agnes/v1/config.account', params)).toMatchObject({
    result: { effect: 'restart-required' },
  })
  expect(s.account).toHaveBeenCalledWith(params)
})

it('validates auxiliary routes against the live catalog and denies nonlocal writes', async () => {
  const slots = { revision: 2, slots: { fast: { route: 'local', model: 'reviewer' } } }
  const configuration = {
    ...service(),
    modelSlots: vi.fn(async () => slots),
    saveModelSlots: vi.fn(async (input: import('@agnes/protocol').ModelSlotsSnapshot) => ({
      ...input,
      revision: 3,
    })),
  }
  const local = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
  local.conn.initialized = true
  local.conn.authKind = 'local'
  local.conn.credentialKind = 'local'
  registerConfiguration(local, configuration, undefined, undefined, undefined, async () => [
    { route: 'local', id: 'reviewer' },
  ])
  const remote = endpoint(false, configuration)
  try {
    expect(await request(local, '_agnes/v1/config.modelSlots.get')).toMatchObject({ result: slots })
    expect(
      await request(local, '_agnes/v1/config.modelSlots.save', {
        revision: 2,
        slots: { verifier: { route: 'other', model: 'reviewer' } },
      }),
    ).toMatchObject({ error: { data: { reason: 'CONFIG_MODEL_UNAVAILABLE' } } })
    expect(await request(remote, '_agnes/v1/config.modelSlots.save', slots)).toMatchObject({
      error: { message: 'CAPABILITY_DENIED' },
    })
    expect(
      await request(local, '_agnes/v1/config.modelSlots.save', {
        revision: 2,
        slots: { primary: { route: 'local', model: 'reviewer' } },
      }),
    ).toHaveProperty('error')
    expect(configuration.saveModelSlots).not.toHaveBeenCalled()
    expect(await request(local, '_agnes/v1/config.modelSlots.save', slots)).toMatchObject({
      result: { revision: 3, slots: slots.slots },
    })
  } finally {
    await Promise.all([local.close(), remote.close()])
  }
})
