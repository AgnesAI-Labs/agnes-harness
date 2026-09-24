import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getApiKeyProvider } from '@agnes/ai'
import { createConfigurationService } from '@agnes/host'
import { createClient } from '@agnes/sdk'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { expect, it } from 'vitest'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { registerConfiguration } from '../src/local/methods/config.js'

it('persists multiple accounts through the real SDK, config RPC and Host with a local model endpoint', async () => {
  const entry = getApiKeyProvider('openai')
  if (!entry) throw new Error('provider missing')
  const model = (await entry.createAdapter()).models(entry.route)[0]?.id
  if (!model) throw new Error('model missing')
  const seen: Array<string | undefined> = []
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ id: model }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agnes-multi-rpc-'))
  const home = join(fixtureRoot, 'home')
  createPrivateDirectorySync(home)
  const service = createConfigurationService({ home, profile: 'local-dev' })
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'local-test' })
  // Transport authentication is separately covered; establish a local connection for this RPC slice.
  ep.register('initialize', async () => {
    ep.conn.initialized = true
    ep.conn.authKind = 'local'
    ep.conn.credentialKind = 'local'
    return { protocolVersion: 1, agentCapabilities: {}, _meta: { agnes: { agnesVersion: '0.0.0' } } }
  })
  const applied: number[] = []
  registerConfiguration(ep, service, async (snapshot) => {
    applied.push(snapshot.revision)
    return snapshot
  })
  const client = createClient({ transport: { kind: 'inproc', endpoint: ep } })
  try {
    const baseUrl = `http://127.0.0.1:${address.port}/v1`
    await client.config.save({
      accountId: 'work',
      providerId: 'openai',
      baseUrl,
      apiKey: 'work-key',
      model,
      expectedRevision: 0,
    })
    const saved = await client.config.save({
      accountId: 'personal',
      providerId: 'openai',
      baseUrl,
      apiKey: 'personal-key',
      model,
      expectedRevision: 1,
    })
    expect(saved.accounts?.map((row) => row.accountId)).toEqual(['work', 'personal'])
    expect(seen).toEqual(['Bearer work-key', 'Bearer personal-key'])
    expect(JSON.stringify(await client.config.get())).not.toMatch(/work-key|personal-key|secret:\/\//)
    const result = await client.config.account({
      accountId: 'personal',
      action: 'default',
      expectedRevision: 2,
    })
    expect(result.provider?.route).toBe('account-personal')
    expect(applied).toEqual([1, 2, 3])
    const reload = createConfigurationService({ home, profile: 'local-dev' })
    expect(await reload.get()).toEqual(result)
    expect((await reload.profileInput()).provider?.routes?.map((route) => route.route)).toEqual([
      'account-personal',
      'account-work',
    ])
  } finally {
    await client.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
