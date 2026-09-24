import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { createTestHost } from '@agnes/host/testkit'
import { describe, expect, it } from 'vitest'
import { signSourceAuth, sourceAuthCanonical } from '../src/local/auth.js'
import { createLocalEndpoint } from '../src/local/index.js'
import { apisFamilies } from '../src/local/methods/agnes.js'
import { MemoryClaims } from '../src/local/ports.js'
import { openTestHost, say } from './host.js'

const caps = {
  fs: { readTextFile: false, writeTextFile: false },
  _meta: { 'ai.agnes.harness': { capabilities: { permission: false } } },
}
const initWith = (clientId: string, id = 1) => ({
  jsonrpc: '2.0' as const,
  id,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: caps,
    _meta: { 'ai.agnes.harness': { clientId } },
  },
})
const init = initWith('cli-test')
const directory = { upsert: async () => ({ upserted: 0, deleted: 0 }) }
const SHARED_SOURCE_KEY = ['shared', 'source', 'key'].join('-')
const ctx = (o: Record<string, unknown>) =>
  ({ authKind: 'local', credentialKind: 'local', jobs: undefined, directory: undefined, ...o }) as never
const methodsOf = (fams: Array<{ name: string; methods: string[] }>): string[] =>
  fams.flatMap((f) => f.methods)

describe('apisFamilies visibility', () => {
  it.each([
    ['local with a jobs service', { authKind: 'local', jobs: {} }, true],
    ['local without one', { authKind: 'local' }, true],
    // The || in the original made this row true, advertising the protected enqueue to every remote
    // connection on any daemon that happens to run jobs.
    ['remote with a jobs service', { authKind: 'jwt', jobs: {} }, false],
    ['remote without one', { authKind: 'jwt' }, false],
  ] as const)('jobs.enqueue is listed for %s: %s', (_n, over, listed) => {
    expect(methodsOf(apisFamilies(ctx(over))).includes('_agnes/v1/jobs.enqueue')).toBe(listed)
  })

  it.each([
    ['sso credential with enterprise installed', { directory, credentialKind: 'sso' }, true],
    ['channel credential with enterprise installed', { directory, credentialKind: 'channel' }, true],
    // The original predicate was `!!x.directory` alone, so this row was listed too.
    ['local credential with enterprise installed', { directory, credentialKind: 'local' }, false],
    ['sso credential, enterprise not installed', { credentialKind: 'sso' }, false],
  ] as const)('directory.upsert is listed for %s: %s', (_n, over, listed) => {
    expect(methodsOf(apisFamilies(ctx(over))).includes('_agnes/v1/directory.upsert')).toBe(listed)
  })

  it.each([
    ['surface credential', { authKind: 'surface', credentialKind: 'sso' }, true],
    ['jwt credential', { authKind: 'jwt', credentialKind: 'jwt' }, false],
    ['local credential', { authKind: 'local', credentialKind: 'local' }, false],
  ] as const)('extension methods are listed for %s: %s', (_n, over, listed) => {
    const methods = methodsOf(apisFamilies(ctx(over)))
    expect(methods.includes('_agnes/v1/extension.call')).toBe(listed)
    expect(methods.includes('_agnes/v1/extension.ack')).toBe(listed)
  })

  it.each([
    ['local owner', { authKind: 'local', credentialKind: 'local' }, true],
    ['remote jwt', { authKind: 'jwt', credentialKind: 'jwt' }, false],
    ['remote channel', { authKind: 'source-auth', credentialKind: 'channel' }, false],
    ['mismatched local label', { authKind: 'local', credentialKind: 'sso' }, false],
  ] as const)('computer-use control methods are listed for %s: %s', (_n, over, listed) => {
    const methods = methodsOf(apisFamilies(ctx(over)))
    expect(methods.includes('_agnes/v1/computerUse.permissions.status')).toBe(listed)
    expect(methods.includes('_agnes/v1/computerUse.permissions.grant')).toBe(listed)
    expect(methods.includes('_agnes/v1/computerUse.doctor')).toBe(listed)
    expect(methods.includes('_agnes/v1/computerUse.operation.start')).toBe(listed)
    expect(methods.includes('_agnes/v1/computerUse.operation.status')).toBe(listed)
    expect(methods.includes('_agnes/v1/computerUse.operation.cancel')).toBe(listed)
    expect(methods).toContain('_agnes/v1/computerUse.status')
  })

  it('lists artifact.read only when the authenticated read composition is fitted', () => {
    expect(methodsOf(apisFamilies(ctx({ artifactRead: true })))).toContain('_agnes/v1/artifact.read')
    expect(methodsOf(apisFamilies(ctx({ artifactRead: false })))).not.toContain('_agnes/v1/artifact.read')
  })

  it('never lists a name twice, and merges families that are declared in two rows', () => {
    const fams = apisFamilies(ctx({ authKind: 'local', jobs: {}, directory, credentialKind: 'sso' }))
    const all = methodsOf(fams)
    expect(new Set(all).size).toBe(all.length)
    expect(fams.map((f) => f.name)).toEqual([...new Set(fams.map((f) => f.name))])
    const jobs = fams.find((f) => f.name === 'jobs')
    expect(jobs?.methods).toContain('_agnes/v1/jobs.poll')
    expect(jobs?.methods).toContain('_agnes/v1/jobs.enqueue')
  })

  it('the family table is not mutated by listing it', () => {
    const wide = apisFamilies(ctx({ authKind: 'local', jobs: {} }))
    const narrow = apisFamilies(ctx({ authKind: 'jwt' }))
    const again = apisFamilies(ctx({ authKind: 'local', jobs: {} }))
    // Pushing into the shared row objects would make each call longer than the last.
    expect(methodsOf(again)).toEqual(methodsOf(wide))
    expect(methodsOf(narrow).length).toBeLessThan(methodsOf(wide).length)
  })
})

describe('apis.list / auth.claim', () => {
  it('lists families with the profile summary', async () => {
    const h = await openTestHost()
    const ep = h.endpoint({ clock: () => Date.now() })
    await ep.handle(init)
    const r = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: '_agnes/v1/apis.list',
      params: {},
    })) as {
      result: { profile: Record<string, unknown>; families: Array<{ name: string; methods: string[] }> }
    }
    expect(r.result.profile).toMatchObject({ name: 'local-dev', presets: { default: 'standard' } })
    expect(r.result.profile.models).toEqual(expect.any(Array))
    // ResolvedProfile has no branding field, so the optional key must be absent rather than undefined:
    // ApisListResult sets additionalProperties:false and an explicit undefined does not serialise.
    expect(Object.hasOwn(r.result.profile, 'branding')).toBe(false)
    expect(r.result.families.find((f) => f.name === 'session')?.methods).toContain('_agnes/v1/session.attach')
    expect(methodsOf(r.result.families)).toContain('_agnes/v1/jobs.enqueue') // local ⇒ protected submit
    await ep.close()
    await h.close()
  })

  it('carries a declared model reasoning and thinkingLevelMap through to the wire', async () => {
    // apis.list projects `pr.provider.routes` (the profile's DECLARED route table, from
    // profileInputs.user.provider.routes), not the runtime Provider's published catalogue - so the
    // model that must carry reasoning/thinkingLevelMap is the one on this route table, not merely one
    // handed to ScriptedProvider. Both are set here, matching this package's established fixture
    // pattern (session-extras.test.ts's ScriptedProvider/fakeModel, and host/test/session-switch.
    // test.ts's twoRouteHostOptions for a custom profileInputs.user.provider.routes). daemon's local
    // openTestHost wrapper (./host.js) does not forward profileInputs, so this reaches straight for
    // @agnes/host/testkit's createTestHost, the same escape hatch other daemon tests already use.
    const model = fakeModel({ id: 'm1', route: 'gw', reasoning: true, thinkingLevelMap: { high: 'high' } })
    const dataDir = mkdtempSync(join(tmpdir(), 'agnesd-apis-list-'))
    try {
      const { host } = await createTestHost({
        dataDir,
        script: [say('hello')],
        provider: new ScriptedProvider({ scripts: [say('hello')], models: [model] }),
        profileInputs: {
          user: {
            name: 'local-dev',
            provider: {
              package: '@agnes/ai',
              adapters: ['@agnes/ai'],
              routes: [
                { route: 'gw', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', models: [model] },
              ],
            },
          },
        },
      })
      const ep = createLocalEndpoint(host, { clock: () => Date.now() })
      await ep.handle(init)
      const r = (await ep.handle({
        jsonrpc: '2.0',
        id: 2,
        method: '_agnes/v1/apis.list',
        params: {},
      })) as { result: { profile: { models: Array<Record<string, unknown>> } } }
      expect(r.result.profile.models).toContainEqual({
        route: 'gw',
        id: 'm1',
        reasoning: true,
        thinkingLevelMap: { high: 'high' },
      })
      await ep.close()
      await host.close()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('advertises from the credential initialize verified, not a stale construction-time label', async () => {
    // This helper's authGate is unix-only, so initialize verifies a local credential. The old
    // construction-time authKind predates authGate and must not hide capabilities from that actual
    // authenticated connection.
    const h = await openTestHost()
    const ep = h.endpoint({
      clock: () => Date.now(),
      identity: { principalId: 'someone-else', authKind: 'jwt', credentialKind: 'jwt' },
    })
    await ep.handle(init)
    const r = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: '_agnes/v1/apis.list',
      params: {},
    })) as { result: { families: Array<{ name: string; methods: string[] }> } }
    expect(ep.conn.principalId).toBe('someone-else')
    expect(ep.conn).toMatchObject({ authKind: 'local', credentialKind: 'local' })
    expect(methodsOf(r.result.families)).toContain('_agnes/v1/jobs.enqueue')
    expect(methodsOf(r.result.families)).toContain('_agnes/v1/jobs.poll')
    await ep.close()
    await h.close()
  })

  it('a single-use claim is free again at exactly the instant it expires', async () => {
    // expiresAtMs is when the claim stops holding, not the last moment it does. One tick either way
    // is invisible to a caller, so nothing but this says which the code means.
    const h = await openTestHost()
    let now = 1_000_000
    const ep = h.endpoint({ clock: () => now })
    await ep.handle(init)
    const claim = (id: number) =>
      ep.handle({
        jsonrpc: '2.0',
        id,
        method: '_agnes/v1/auth.claim',
        params: { kind: 'channel-event', value: 'm1', expiresAtMs: 1_000_500 },
      })
    expect(await claim(2)).toMatchObject({ result: { granted: true } })
    now = 1_000_499
    expect(await claim(3)).toMatchObject({ result: { granted: false } })
    now = 1_000_500
    expect(await claim(4)).toMatchObject({ result: { granted: true } })
    await ep.close()
    await h.close()
  })

  it('claim once is fail-closed on repeats and rate limit counts a window', async () => {
    const h = await openTestHost()
    let now = 1_000_000
    const ep = h.endpoint({ clock: () => now })
    await ep.handle(init)
    const claim = (params: unknown, id: number) =>
      ep.handle({ jsonrpc: '2.0', id, method: '_agnes/v1/auth.claim', params })
    expect(await claim({ kind: 'channel-event', value: 'm1' }, 2)).toMatchObject({
      result: { granted: true },
    })
    expect(await claim({ kind: 'channel-event', value: 'm1' }, 3)).toMatchObject({
      result: { granted: false },
    })
    now += 6 * 60_000
    expect(await claim({ kind: 'channel-event', value: 'm1' }, 4)).toMatchObject({
      result: { granted: true },
    })
    expect(await claim({ kind: 'send', value: 'u1', limit: 2, windowMs: 1000 }, 5)).toMatchObject({
      result: { granted: true, slot: 1 },
    })
    expect(await claim({ kind: 'send', value: 'u1', limit: 2, windowMs: 1000 }, 6)).toMatchObject({
      result: { granted: true, slot: 2 },
    })
    expect(await claim({ kind: 'send', value: 'u1', limit: 2, windowMs: 1000 }, 7)).toMatchObject({
      result: { granted: false },
    })
    // The window slides: hits older than windowMs stop counting, or the first two sends would hold
    // the limit shut for the life of the process.
    now += 1_001
    expect(await claim({ kind: 'send', value: 'u1', limit: 2, windowMs: 1000 }, 8)).toMatchObject({
      result: { granted: true, slot: 1 },
    })
    await ep.close()
    await h.close()
  })

  it('two different kinds do not share a single-use bucket', async () => {
    const h = await openTestHost()
    const ep = h.endpoint({ clock: () => 1_000_000 })
    await ep.handle(init)
    const claim = (params: unknown, id: number) =>
      ep.handle({ jsonrpc: '2.0', id, method: '_agnes/v1/auth.claim', params })
    expect(await claim({ kind: 'a', value: 'same' }, 2)).toMatchObject({ result: { granted: true } })
    expect(await claim({ kind: 'b', value: 'same' }, 3)).toMatchObject({ result: { granted: true } })
    expect(await claim({ kind: 'a', value: 'same' }, 4)).toMatchObject({ result: { granted: false } })
    await ep.close()
    await h.close()
  })

  it('a source-auth holder cannot get a fresh single-use bucket by renaming itself', async () => {
    // The whole point of auth.claim: one inbound message id is claimed exactly once. If the bucket
    // carried the client-supplied clientId, reconnecting under a new name would hand out a second
    // grant for the same value.
    const h = await openTestHost()
    const now = 1_700_000_000_000
    const claims = new MemoryClaims()
    const make = (clientId: string, nonce: string) => {
      const ep = h.endpoint({
        clock: () => now,
        claims,
        auth: {
          config: {
            transport: 'ws',
            sourceAuthKeys: () => [{ secret: SHARED_SOURCE_KEY, keyId: 'shared-source-key-id' }],
          },
          nonces: { consume: () => true },
          clock: () => now,
        },
      })
      const unsigned = initWith(clientId).params as Record<string, unknown>
      const pocket = (unsigned._meta as Record<string, Record<string, unknown>>)['ai.agnes.harness']
      if (!pocket) throw new Error('missing metadata')
      pocket.auth = {
        kind: 'source-auth',
        timestamp: now / 1000,
        nonce,
        signature: signSourceAuth(
          'shared-source-key',
          now / 1000,
          nonce,
          sourceAuthCanonical(clientId, unsigned),
        ),
      }
      return { ep, init: { ...initWith(clientId), params: unsigned } }
    }
    const first = make('adapter-a', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    await first.ep.handle(first.init)
    expect(
      await first.ep.handle({
        jsonrpc: '2.0',
        id: 2,
        method: '_agnes/v1/auth.claim',
        params: { kind: 'channel-event', value: 'm1' },
      }),
    ).toMatchObject({ result: { granted: true } })
    const renamed = make('adapter-b', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    await renamed.ep.handle(renamed.init)
    expect(renamed.ep.conn.clientId).toBe('adapter-b')
    expect(renamed.ep.conn.principalId).toBe(first.ep.conn.principalId)
    expect(
      await renamed.ep.handle({
        jsonrpc: '2.0',
        id: 4,
        method: '_agnes/v1/auth.claim',
        params: { kind: 'channel-event', value: 'm1' },
      }),
    ).toMatchObject({ result: { granted: false } })
    await first.ep.close()
    await renamed.ep.close()
    await h.close()
  })
})
