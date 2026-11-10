import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_ID, CODEX_PROVIDER } from '@agnes/ai'
import { fakeModel } from '@agnes/ai/testkit'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { codexCredentials } from '@agnes/host-infrastructure/adapters/codex-credentials'
import { afterEach, expect, it } from 'vitest'
import { buildProvider } from '../../src/assemble/provider.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

const log = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
const oauthRef = 'secret://openai-codex/account-test-r1'

it('names every route left without a usable credential, and none that works without a bound key', async () => {
  const home = join(await mkdtemp(join(tmpdir(), 'agnes-provider-credentials-')), 'home')
  roots.push(join(home, '..'))
  // An OAuth login that resolved: the route authenticates per request, not through a bound key.
  await codexCredentials(home, oauthRef).modify(CODEX_ID, async () => ({
    type: 'oauth',
    access: `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-a' } })).toString('base64url')}.signature`,
    refresh: 'synthetic-refresh',
    expires: Date.now() + 3_600_000,
    accountId: 'account-a',
  }))
  const codex = (await CODEX_PROVIDER.createAdapter()).models(CODEX_ID)[0]
  if (!codex) throw new Error('fixture codex model missing')
  const baseUrl = 'http://127.0.0.1:1/v1'
  const keyed = fakeModel({ id: 'keyed-1', route: 'account-keyed', api: 'openai-completions', baseUrl })
  const keyless = fakeModel({ id: 'local-1', route: 'local', api: 'openai-completions', baseUrl })
  const reused = fakeModel({ id: 'reused-1', route: 'my-gateway', api: 'openai-completions', baseUrl })
  const profile = {
    dataDir: join(home, 'data'),
    provider: {
      package: '@agnes/ai',
      adapters: ['@agnes/ai'],
      routes: [
        {
          route: keyed.route,
          api: keyed.api,
          baseUrl,
          credentialRef: 'secret://generic/00000000-0000-4000-8000-000000000000',
          models: [keyed],
        },
        { route: keyless.route, api: keyless.api, baseUrl, keyless: true, models: [keyless] },
        {
          // A profile route that reuses a built-in reference is optional too, and is left unbound.
          route: reused.route,
          api: reused.api,
          baseUrl,
          credentialRef: 'secret://anthropic/default',
          models: [reused],
        },
        {
          route: 'account-work',
          api: codex.api,
          baseUrl: codex.baseUrl,
          credentialRef: oauthRef,
          models: [{ ...codex, route: 'account-work' }],
        },
      ],
    },
    limits: {},
    adapters: { secrets: { kind: 'file', path: join(home, 'secrets') } },
  } as unknown as ResolvedProfile
  const secrets: Record<string, string> = {
    'secret://generic/00000000-0000-4000-8000-000000000000': 'synthetic-account-key',
    'secret://deepseek/default': 'synthetic-deepseek-key',
    // Present but unable to authenticate anything: the same outcome as absent.
    'secret://openai/default': '  ',
  }
  const built = await buildProvider(
    profile,
    { primary: { route: keyed.route, model: keyed.id } },
    {
      secrets: (ref) => {
        const value = secrets[ref]
        if (value === undefined) throw new Error('not configured')
        return value
      },
      clock: Date.now,
      log,
    },
  )
  try {
    const published = new Set(built.provider.models().map((model) => model.route))
    for (const route of ['anthropic', 'openai', 'deepseek', 'account-keyed', 'local', 'account-work'])
      expect(published).toContain(route)
    expect(built.uncredentialedRoutes).toContain('anthropic')
    expect(built.uncredentialedRoutes).toContain('openai')
    for (const route of ['deepseek', 'account-keyed', 'local', 'account-work'])
      expect(built.uncredentialedRoutes).not.toContain(route)
    expect(built.uncredentialedRoutes).toContain('my-gateway')
  } finally {
    await built.dispose()
  }
})
