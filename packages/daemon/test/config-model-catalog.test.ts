import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { registerConfiguration } from '@agnes/daemon-rpc/local/methods/config'
import { createConfigurationService, readConfigurationProfileInputs } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import type { ConfigSnapshot } from '@agnes/protocol'
import { createClient } from '@agnes/sdk'
import { accountDefaultModel, resolveNewSessionSelection } from '@agnes/sdk/composer-selection'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { expect, it } from 'vitest'
import { createLocalEndpoint } from '../src/local/index.js'
import { configurationApplication } from '../src/supervisor/configuration.js'

it('refreshes the composer RPC catalog after account changes following a bundle install', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agnes-config-catalog-'))
  const home = join(fixtureRoot, 'home')
  createPrivateDirectorySync(home)
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture did not bind')
  const inputs = await readConfigurationProfileInputs({
    home,
    workspaceRoot: home,
    profile: 'local-dev',
    agnesVersion: '0.0.0',
    demoFallback: true,
  })
  const { host } = await createTestHost({
    dataDir: join(home, 'data'),
    profileInputs: { user: { ...inputs.user, name: 'local-dev' } },
  })
  const initial = host.profile
  const service = createConfigurationService({ home, profile: 'local-dev' })
  const application = await configurationApplication({
    profile: initial,
    service,
    reloadProfile: async () => {
      const input = await service.profileInput()
      return {
        ...initial,
        hash: 'desired',
        provider: { ...initial.provider, ...input.provider },
        adapters: { ...initial.adapters, ...input.adapters },
        // These are the fields the real boot reader adds after an installed bundle enters inventory.
        composition: {},
        compositionSources: {},
        bundleCatalog: {},
        bundlePresets: {},
        adminBundles: [],
      }
    },
    activate: async (profile) => {
      await host.applyModelProfile(profile)
    },
  })
  const endpoint = new LocalEndpoint({ clock: Date.now, principalId: 'local-test' })
  endpoint.register('initialize', async () => {
    endpoint.conn.initialized = true
    endpoint.conn.authKind = 'local'
    endpoint.conn.credentialKind = 'local'
    return { protocolVersion: 1, agentCapabilities: {}, _meta: { agnes: { agnesVersion: '0.0.0' } } }
  })
  registerConfiguration(endpoint, service, application.apply, application.present)
  const config = createClient({ transport: { kind: 'inproc', endpoint } })
  const projection = createClient({ transport: { kind: 'inproc', endpoint: createLocalEndpoint(host) } })
  const catalog = async () => (await projection.apis()).profile.models ?? []
  const assertSelection = async (saved: ConfigSnapshot, route: string, id: string) => {
    expect(saved.effect).toBe('new-sessions')
    const models = await catalog()
    const accountDefault = accountDefaultModel(models, saved.provider)
    expect(
      resolveNewSessionSelection({
        remembered: { model: { route: 'demo', id: 'demo-model' } },
        models,
        ...(accountDefault ? { accountDefault } : {}),
      }).model,
    ).toMatchObject({ route, id })
    const session = await host.createSession({
      cwd: join(home, 'data'),
      key: `new-default-${saved.revision}`,
    })
    try {
      expect(session.preset.model.route.primary).toBe(route)
      expect(session.preset.model.id.primary).toBe(id)
    } finally {
      await session.close()
    }
  }
  try {
    expect((await catalog()).map((model) => model.id)).toEqual(['demo-model'])
    const work = await config.config.save({
      accountId: 'work',
      providerId: 'deepseek',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'test-key',
      model: 'deepseek-flash',
      expectedRevision: 0,
      makeDefault: true,
    })
    await assertSelection(work, 'account-work', 'deepseek-flash')
    expect((await catalog()).map((model) => model.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    const personal = await config.config.save({
      accountId: 'personal',
      providerId: 'deepseek',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'test-key',
      model: 'deepseek-v4-pro',
      expectedRevision: 1,
      makeDefault: true,
    })
    await assertSelection(personal, 'account-personal', 'deepseek-v4-pro')
    expect(new Set((await catalog()).map((model) => model.route))).toEqual(
      new Set(['account-personal', 'account-work']),
    )
    const disabled = await config.config.account({
      accountId: 'work',
      action: 'disable',
      expectedRevision: 2,
    })
    expect(disabled.effect).toBe('new-sessions')
    expect(new Set((await catalog()).map((model) => model.route))).toEqual(new Set(['account-personal']))
    const enabled = await config.config.account({ accountId: 'work', action: 'enable', expectedRevision: 3 })
    expect(enabled.effect).toBe('new-sessions')
    expect(new Set((await catalog()).map((model) => model.route))).toEqual(
      new Set(['account-personal', 'account-work']),
    )
    const changed = await config.config.save({
      accountId: 'work',
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
      expectedRevision: 4,
      makeDefault: true,
      label: 'Work renamed',
    })
    await assertSelection(changed, 'account-work', 'deepseek-v4-pro')
    expect((await config.config.get()).accounts?.find((account) => account.accountId === 'work')?.label).toBe(
      'Work renamed',
    )
    const removed = await config.config.account({
      accountId: 'personal',
      action: 'remove',
      expectedRevision: 5,
    })
    expect(removed.effect).toBe('new-sessions')
    expect(new Set((await catalog()).map((model) => model.route))).toEqual(new Set(['account-work']))
    await config.config.account({ accountId: 'work', action: 'remove', expectedRevision: 6 })
    expect(await catalog()).toEqual([])
  } finally {
    await Promise.all([config.close(), projection.close()])
    await host.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
