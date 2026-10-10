import type { ConfigurationService } from '@agnes/host'
import { expect, it, vi } from 'vitest'
import { LocalEndpoint } from '../src/local/endpoint.js'
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

it('Jev configuration uses local authority, sanitized errors and independent restart-only saves', async () => {
  const jevSnapshot = {
    profile: 'local-dev',
    revision: 1,
    settings: null,
    configured: false,
    credentialConfigured: false,
    effect: 'restart-required' as const,
    source: 'none' as const,
  }
  const jev = {
    get: vi.fn(async () => jevSnapshot),
    test: vi.fn(async () => ({ verified: true })),
    save: vi.fn(async () => jevSnapshot),
    capture: vi.fn(async () => ({ version: 1 as const, revision: 0, settings: null, credentialRef: null })),
  }
  const s = { ...service(), jev }
  const local = endpoint(true, s),
    remote = endpoint(false, s),
    missing = endpoint(true, service())
  const input = {
    settings: {
      transport: 'native',
      endpoint: 'https://jev.example.invalid/decision',
      model: 'jev',
      enabled: true,
      authentication: 'bearer',
    },
    apiKey: 'synthetic-key',
    expectedRevision: 0,
  }
  try {
    for (const method of ['jevGet', 'jevTest', 'jevSave']) {
      expect(
        await request(
          remote,
          `_agnes/v1/config.${method}`,
          method === 'jevGet'
            ? {}
            : method === 'jevTest'
              ? { settings: input.settings, apiKey: input.apiKey }
              : input,
        ),
      ).toMatchObject({ error: { message: 'CAPABILITY_DENIED' } })
    }
    expect(jev.save).not.toHaveBeenCalled()
    expect(await request(local, '_agnes/v1/config.jevSave', input)).toMatchObject({ result: jevSnapshot })
    expect(s.save).not.toHaveBeenCalled()
    expect(await request(missing, '_agnes/v1/config.jevGet')).toMatchObject({
      error: { data: { reason: 'CONFIG_UNAVAILABLE' } },
    })
    jev.test.mockRejectedValueOnce(new Error('synthetic-key upstream body'))
    const failed = await request(local, '_agnes/v1/config.jevTest', {
      settings: input.settings,
      apiKey: input.apiKey,
    })
    expect(JSON.stringify(failed)).not.toContain(input.apiKey)
    expect(failed).toMatchObject({ error: { data: { reason: 'CONFIG_FAILED' } } })
  } finally {
    await Promise.all([local.close(), remote.close(), missing.close()])
  }
})

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

it.each(['disable', 'refresh-prices'])(
  'applies %s through the same authenticated configuration callback',
  async (action) => {
    const s = service(),
      ep = endpoint(true, s),
      denied = endpoint(false, s)
    const params = { accountId: 'work', action, expectedRevision: 1 }
    expect(await request(denied, '_agnes/v1/config.account', params)).toMatchObject({
      error: { message: 'CAPABILITY_DENIED' },
    })
    expect(s.account).not.toHaveBeenCalled()
    expect(await request(ep, '_agnes/v1/config.account', params)).toMatchObject({
      result: { effect: 'restart-required' },
    })
    expect(s.account).toHaveBeenCalledWith(params)
  },
)
