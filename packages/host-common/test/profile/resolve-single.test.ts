import { describe, expect, it } from 'vitest'
import { isHostError } from '../../src/errors.js'
import { allowedPermissions } from '../../src/presets/admission.js'
import { mergePackages, mergeRoutes, resolveProfile } from '../../src/profile/resolve.js'
import type { LockState, ProfileInputs, ResolveEnv, RuntimeProfileManifest } from '../../src/profile/types.js'

const env: ResolveEnv = {
  platform: { os: 'darwin', arch: 'arm64', capabilities: { 'sandbox.l1': 'full' } },
  agnesVersion: '0.1.0',
  now: '2026-09-07T00:00:00Z',
}
const lock: LockState = {
  packages: {
    '@agnes/base': {
      version: '0.1.0',
      integrity: 'builtin:0.1.0',
      source: { type: 'builtin', ref: 'builtin' },
      trust: 'builtin',
      enabled: true,
      provides: [
        'approval',
        'checkpoint',
        'billing',
        'sandbox',
        'verifier',
        'repair',
        'artifacts',
        'principals',
      ],
    },
    '@agnes/code': {
      version: '0.1.0',
      integrity: 'builtin:0.1.0',
      source: { type: 'builtin', ref: 'builtin' },
      trust: 'builtin',
      enabled: true,
    },
    '@agnes/ai': {
      version: '0.1.0',
      integrity: 'builtin:0.1.0',
      source: { type: 'builtin', ref: 'builtin' },
      trust: 'builtin',
      enabled: true,
    },
  },
}

/** The code a rejection actually carried, so a refusal cannot be credited to the wrong check. */
async function refusal(p: Promise<unknown>): Promise<{ code: string; detail: unknown; message: string }> {
  try {
    await p
    expect.unreachable('should have refused')
  } catch (e) {
    if (!isHostError(e)) throw e
    return { code: e.code, detail: e.detail, message: e.message }
  }
  throw new Error('unreachable')
}

describe('resolveProfile (single layer)', () => {
  it('resolves local-dev template alone', async () => {
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
    expect(p.name).toBe('local-dev')
    expect(p.chain).toEqual(['builtin:local-dev'])
    expect(p.packages.map((x) => x.id)).toEqual(['@agnes/ai', '@agnes/base', '@agnes/code'])
    expect(p.seams.approval).toEqual({ provider: 'local-prompt' })
    expect(p.seams).not.toHaveProperty('platform')
    expect(p.seams).not.toHaveProperty('sandbox')
    expect(p.presets).toEqual({ default: 'standard', allowed: ['standard', 'minimal', 'ptc'] })
    expect(p.permissions).toEqual({
      default: 'workspace-write',
      allowed: ['read-only', 'workspace-write', 'full-access'],
    })
    expect(p.hash).toMatch(/^sha256-[0-9a-f]{64}$/)
    expect(Object.isFrozen(p)).toBe(true)
  })
  it('keeps permission grants independent of recipe selection and refuses old profile aliases', async () => {
    const narrow = await resolveProfile(
      {
        builtin: 'local-dev',
        lock,
        user: { name: 'u', presets: { default: 'standard', allowed: ['standard'] } },
      },
      env,
    )
    expect(allowedPermissions(narrow)).toEqual(['read-only', 'workspace-write', 'full-access'])
    await expect(
      resolveProfile(
        {
          builtin: 'local-dev',
          lock,
          user: { name: 'u', presets: { default: 'read-only', allowed: ['read-only', 'standard'] } },
        },
        env,
      ),
    ).rejects.toThrow(/Retired.*clean home/)
  })
  it('lets a user layer that sets both keys choose its own permissions', async () => {
    const p = await resolveProfile(
      {
        builtin: 'local-dev',
        lock,
        user: {
          name: 'u',
          presets: { default: 'standard', allowed: ['standard'] },
          permissions: { default: 'read-only' },
        },
      },
      env,
    )
    expect(p.permissions).toEqual({
      default: 'read-only',
      allowed: ['read-only', 'workspace-write', 'full-access'],
    })
  })
  it('carries lockfile version and integrity onto each resolved package', async () => {
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
    expect(p.packages.find((x) => x.id === '@agnes/base')).toMatchObject({
      version: '0.1.0',
      integrity: 'builtin:0.1.0',
      trust: 'builtin',
      enabled: true,
      source: 'builtin',
    })
    expect(p.packages.find((x) => x.id === '@agnes/base')?.provides).toContain('approval')
  })
  it('user layer overrides scalars, merges maps, replaces arrays', async () => {
    const inputs: ProfileInputs = {
      builtin: 'local-dev',
      lock,
      // A preset name that no package provides resolves fine here on purpose: resolveProfile is a
      // pure merge, and whether a name has a recipe behind it is checked at assembly and at session
      // open, where the packages are actually loaded.
      user: {
        name: 'mine',
        dataDir: '/tmp/agnes',
        providers: { approval: { provider: 'other' } },
        transports: [{ kind: 'unix' }],
        presets: { default: 'code', allowed: ['code'] },
      },
    }
    const p = await resolveProfile(inputs, env)
    expect(p.name).toBe('mine')
    expect(p.chain).toEqual(['builtin:local-dev', 'user:mine'])
    expect(p.dataDir).toBe('/tmp/agnes')
    expect(p.seams.approval).toEqual({ provider: 'other' })
    expect(p.seams.billing).toEqual({ provider: 'budget' })
    expect(p.transports).toEqual([{ kind: 'unix' }])
    expect(p.presets).toEqual({ default: 'code', allowed: ['code'] })
  })
  it('merges limits by key while replacing the transports array wholesale', async () => {
    const p = await resolveProfile(
      { builtin: 'local-dev', lock, user: { name: 'x', limits: { 'jobs.tick_ms': 50 } } },
      env,
    )
    expect(p.limits).toEqual({ 'jobs.tick_ms': 50, 'shutdown.grace_ms': 10000 })
    expect(p.transports).toEqual([{ kind: 'stdio' }, { kind: 'unix' }])
  })
  it('hash is stable across two resolutions and ignores env.now / platform', async () => {
    const a = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const b = await resolveProfile(
      { builtin: 'local-dev', lock },
      { ...env, now: '2030-01-01T00:00:00Z', platform: { os: 'linux', arch: 'x64', capabilities: {} } },
    )
    expect(a.hash).toBe(b.hash)
  })
  // The hash attests to the resolution, so every field of the resolution moves it. What does not
  // move it is anything that is not part of the result: env.now and env.platform, covered above.
  it('hash moves when any resolved field moves, identity and directories included', async () => {
    const base = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const moves: Array<[string, RuntimeProfileManifest]> = [
      ['providers', { name: 'local-dev', providers: { approval: { provider: 'other' } } }],
      ['name', { name: 'beta' }],
      ['dataDir', { name: 'local-dev', dataDir: '/var/lib/elsewhere' }],
      ['cacheDir', { name: 'local-dev', cacheDir: '/elsewhere' }],
      ['limits', { name: 'local-dev', limits: { 'jobs.tick_ms': 7 } }],
      ['transports', { name: 'local-dev', transports: [{ kind: 'unix', path: '/tmp/s' }] }],
    ]
    const seen = new Set([base.hash])
    for (const [what, user] of moves) {
      const p = await resolveProfile({ builtin: 'local-dev', lock, user }, env)
      expect([what, p.hash === base.hash], what).toEqual([what, false])
      seen.add(p.hash)
    }
    expect(seen.size).toBe(moves.length + 1)
  })
  // Two profiles that differ only in the name, or only in the directory the ledger lives in, are
  // two profiles. A single hash across both is an attestation that identifies neither.
  it('gives alpha and beta different hashes, and so for two dataDirs', async () => {
    const of = async (user: RuntimeProfileManifest) =>
      (await resolveProfile({ builtin: 'local-dev', lock, user }, env)).hash
    expect(await of({ name: 'alpha' })).not.toBe(await of({ name: 'beta' }))
    expect(await of({ name: 'a', dataDir: '/one' })).not.toBe(await of({ name: 'a', dataDir: '/two' }))
    expect(await of({ name: 'a', dataDir: '/one' })).toBe(await of({ name: 'a', dataDir: '/one' }))
  })
  it('rejects a non-builtin package not in the lock with E_DEP_MISSING', async () => {
    const r = await refusal(
      resolveProfile(
        {
          builtin: 'local-dev',
          lock: { packages: {} },
          user: { name: 'x', packages: [{ id: '@acme/x', source: 'npm' }] },
        },
        env,
      ),
    )
    expect(r.code).toBe('E_DEP_MISSING')
    expect(r.detail).toEqual({ id: '@acme/x' })
  })
  it('resolves builtin packages without lock entries, stamped from the build itself', async () => {
    const p = await resolveProfile({ builtin: 'local-dev', lock: { packages: {} } }, env)
    expect(p.packages).toEqual([
      {
        id: '@agnes/ai',
        version: '0.1.0',
        source: 'builtin',
        integrity: 'builtin:0.1.0',
        trust: 'builtin',
        enabled: true,
      },
      {
        id: '@agnes/base',
        version: '0.1.0',
        source: 'builtin',
        integrity: 'builtin:0.1.0',
        trust: 'builtin',
        enabled: true,
      },
      {
        id: '@agnes/code',
        version: '0.1.0',
        source: 'builtin',
        integrity: 'builtin:0.1.0',
        trust: 'builtin',
        enabled: true,
      },
    ])
    // The sentinel must not be mistakable for a digest nothing verified.
    for (const x of p.packages) expect(x.integrity).not.toMatch(/^sha(256|512)-/)
    // And a missing lock entirely is the same case, not a different one.
    const q = await resolveProfile({ builtin: 'local-dev' }, env)
    expect(q.packages).toEqual(p.packages)
  })
  it('only the closed builtin set is exempt: an empty override set refuses again', async () => {
    const r = await refusal(
      resolveProfile({ builtin: 'local-dev', lock: { packages: {} }, builtinPackages: [] }, env),
    )
    expect(r.code).toBe('E_DEP_MISSING')
    expect(r.detail).toEqual({ id: '@agnes/ai' })
  })
  it.each([
    ['the package-id string form', { approval: '@agnes/base' }, /providers\.approval must be \{ provider/],
    ['the renamed ledger key', { ledger: { provider: 'budget' } }, /use providers\.billing/],
    ['the removed harness key', { harness: { provider: 'x' } }, /harness is no longer a provider kind/],
    ['an unknown key', { invented: { provider: 'x' } }, /not a provider kind/],
    ['an extra field', { approval: { provider: 'x', extra: 1 } }, /only accepts provider and version/],
    ['an extra field on a named kind', { loop: { provider: 'x', id: 'y' } }, /providers\.loop requires/],
  ])('rejects %s in providers with a message that names the fix', async (_name, providers, message) => {
    const r = await refusal(
      resolveProfile({ builtin: 'local-dev', lock, user: { name: 'x', providers: providers as never } }, env),
    )
    expect(r.code).toBe('E_PROFILE_FRAGMENT_KEY')
    expect((r.detail as { problems: string[] }).problems.join('; ')).toMatch(message)
  })
  it('selects every provider kind in the one table, kind by kind over the template', async () => {
    const p = await resolveProfile(
      {
        builtin: 'local-dev',
        lock,
        user: {
          name: 'x',
          providers: {
            approval: { provider: 'other' },
            loop: { provider: 'echo', version: '2.0.0' },
            compaction: { provider: 'short' },
            'model-adapter': { provider: ['wire-a', 'wire-b'] },
            'tool-policy': { provider: 'read-only' },
            memory: { provider: 'notes', version: '1.0.0' },
            sandbox: { provider: 'acme-remote' },
            persistence: { provider: 'jsonl' },
          },
          sandbox: { options: { region: 'eu' } },
        },
      },
      env,
    )
    // The user layer replaces one seam kind and leaves the template's others.
    expect(p.seams).toMatchObject({ approval: { provider: 'other' }, billing: { provider: 'budget' } })
    // Persistence and sandbox are startup choices, kept in their resolved fields below.
    expect(p.providers).toEqual({
      loop: { provider: 'echo', version: '2.0.0' },
      compaction: { provider: 'short' },
      'model-adapter': { provider: ['wire-a', 'wire-b'] },
      'tool-policy': { provider: 'read-only' },
      memory: { provider: 'notes', version: '1.0.0' },
    })
    expect(p.loop).toEqual({ id: 'echo', version: '2.0.0' })
    expect(p.compaction).toEqual({ engine: 'short' })
    expect(p.provider.adapters).toEqual(['wire-a', 'wire-b'])
    expect(p.sandbox).toEqual({ provider: 'acme-remote', options: { region: 'eu' } })
    expect(p.persistence).toEqual({ provider: 'jsonl' })
  })
  it.each([
    ['seams', { seams: { approval: { provider: 'x' } } }, /seams was replaced by providers/],
    ['top-level persistence', { persistence: { provider: 'jsonl' } }, /providers\.persistence/],
    ['top-level memory', { memory: { provider: 'notes' } }, /providers\.memory/],
    ['top-level child-agent', { 'child-agent': { provider: 'acp' } }, /providers\.child-agent/],
    ['top-level loop', { loop: { provider: 'echo' } }, /providers\.loop/],
    ['sandbox.provider', { sandbox: { provider: 'acme' } }, /providers\.sandbox/],
    [
      'provider.adapters',
      { provider: { package: '@agnes/ai', adapters: ['x'] } },
      /providers\.model-adapter/,
    ],
    [
      'a composition selection',
      { composition: { loop: { provider: 'echo', version: '1.0.0' } } },
      /composition\.loop is selected with providers\.loop/,
    ],
    [
      'a package config selection',
      { packages: [{ id: '@agnes/base', source: 'builtin', config: { loop: { provider: 'echo' } } }] },
      /package config\.loop no longer selects a provider; use providers\.loop/,
    ],
  ])('refuses a selection written as %s and says where it goes', async (_name, manifest, message) => {
    const r = await refusal(
      resolveProfile({ builtin: 'local-dev', lock, user: { name: 'x', ...manifest } as never }, env),
    )
    expect(r.code).toBe('E_PROFILE_FRAGMENT_KEY')
    expect(r.message).toMatch(message)
  })
  it('rejects an env without agnesVersion instead of quietly ignoring it', async () => {
    const r = await refusal(resolveProfile({ builtin: 'local-dev', lock }, { ...env, agnesVersion: '' }))
    expect(r.code).toBe('E_DEP_MISSING')
    expect(r.detail).toEqual({ field: 'env.agnesVersion' })
  })
  it('rejects a declared route named default', async () => {
    const inputs: ProfileInputs = {
      builtin: 'local-dev',
      lock,
      user: {
        name: 'x',
        provider: {
          package: '@agnes/ai',
          routes: [{ route: 'default', api: 'openai', baseUrl: 'https://x/' }],
        },
      },
    }
    const r = await refusal(resolveProfile(inputs, env))
    expect(r.code).toBe('E_PRESET_UNRESOLVED')
  })
  it('keeps a declared route that is not reserved, and carries it onto the resolved provider', async () => {
    const p = await resolveProfile(
      {
        builtin: 'local-dev',
        lock,
        user: {
          name: 'x',
          provider: {
            package: '@agnes/ai',
            routes: [{ route: 'gateway', api: 'openai', baseUrl: 'https://x/' }],
          },
        },
      },
      env,
    )
    expect(p.provider.routes).toEqual([{ route: 'gateway', api: 'openai', baseUrl: 'https://x/' }])
    expect(p.provider.adapters).toEqual(['@agnes/ai'])
  })
  it('merges distinct provider routes but refuses a custom route that shadows one already declared', async () => {
    const p = await resolveProfile(
      {
        builtin: 'local-dev',
        lock,
        user: {
          name: 'x',
          provider: {
            package: '@agnes/ai',
            routes: [{ route: 'gateway', api: 'openai', baseUrl: 'https://x/' }],
          },
        },
      },
      env,
    )
    expect(p.provider.routes).toEqual([{ route: 'gateway', api: 'openai', baseUrl: 'https://x/' }])

    // `mergeRoutes` is the profile-layer merge used once builtin API-key routes are present.  A
    // custom route may extend that allow-list but cannot replace an existing route's destination.
    expect(() =>
      mergeRoutes(
        [{ route: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com' }],
        [{ route: 'deepseek', api: 'openai-completions', baseUrl: 'https://evil.invalid' }],
        'user',
      ),
    ).toThrow(/E_PRESET_UNRESOLVED/)
    expect(
      mergeRoutes(
        [{ route: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com' }],
        [{ route: 'custom', api: 'openai-completions', baseUrl: 'https://custom.example/v1' }],
        'user',
      ),
    ).toEqual([
      { route: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com' },
      { route: 'custom', api: 'openai-completions', baseUrl: 'https://custom.example/v1' },
    ])
  })
  it('refuses duplicate route names within a profile layer', async () => {
    const r = await refusal(
      resolveProfile(
        {
          builtin: 'local-dev',
          lock,
          user: {
            name: 'x',
            provider: {
              package: '@agnes/ai',
              routes: [
                { route: 'gateway', api: 'openai', baseUrl: 'https://one.example' },
                { route: 'gateway', api: 'openai', baseUrl: 'https://two.example' },
              ],
            },
          },
        },
        env,
      ),
    )
    expect(r).toMatchObject({ code: 'E_PRESET_UNRESOLVED', detail: { reason: 'route-duplicate' } })
  })
})

describe('mergePackages', () => {
  it('refuses a package listed twice within one layer and says which id', () => {
    try {
      mergePackages(
        [],
        [
          { id: '@a', source: 'npm' },
          { id: '@a', source: 'npm' },
        ],
        'user',
      )
      expect.unreachable('should have refused')
    } catch (e) {
      if (!isHostError(e)) throw e
      expect(e.code).toBe('E_PACKAGE_DUPLICATE')
      expect(e.detail).toEqual({ id: '@a' })
      expect(e.source?.layer).toBe('user')
    }
  })
  it('lets a later layer refine an earlier entry rather than replacing it wholesale', () => {
    const out = mergePackages(
      [{ id: '@a', source: 'npm', version: '1.0.0' }],
      [{ id: '@a', source: 'npm', enabled: false }],
      'user',
    )
    expect(out).toEqual([{ id: '@a', source: 'npm', version: '1.0.0', enabled: false, tombstone: false }])
  })
  it('a tombstone drops the earlier entry rather than merging with it', () => {
    const out = mergePackages(
      [{ id: '@a', source: 'npm', version: '1.0.0' }],
      [{ id: '@a', source: 'x', tombstone: true }],
      'user',
    )
    expect(out).toEqual([{ id: '@a', source: 'x', tombstone: true }])
  })
  it('appends packages a later layer introduces, keeping first-seen order', () => {
    const out = mergePackages([{ id: '@a', source: 'npm' }], [{ id: '@b', source: 'npm' }], 'user')
    expect(out.map((p) => p.id)).toEqual(['@a', '@b'])
  })
})

// The layers resolveProfile does not yet apply. Accepting and ignoring them is not a missing
// feature but a false attestation: the hash would say a managed ceiling had been applied when it
// had not.
describe('resolveProfile, layers that are not implemented yet', () => {
  const cases: Array<[string, Partial<ProfileInputs>]> = [
    ['managed', { managed: { version: 1, policy: { capabilityCeiling: ['tools'] } } }],
    ['flags', { flags: { name: 'from-flags' } }],
    ['local', { local: { name: 'from-local' } }],
  ]
  it.each(cases)('refuses %s rather than dropping it', async (name, extra) => {
    const r = await refusal(resolveProfile({ builtin: 'local-dev', lock, ...extra }, env))
    expect(r.code).toBe('E_DEP_MISSING')
    expect(r.detail).toEqual({ layer: name, reason: 'unimplemented' })
  })
  it('resolves as before when none of them is present', async () => {
    await expect(resolveProfile({ builtin: 'local-dev', lock }, env)).resolves.toMatchObject({
      name: 'local-dev',
    })
  })
})

describe('resolveProfile, verified workspace layer', () => {
  it('applies the narrow overlay only when the lock carries its verified workspace identity', async () => {
    const trusted: LockState = {
      ...lock,
      workspace: { path: 'deploy/xinwei', hash: 'sha256-workspace', manifestId: 'xinwei' },
    }
    const profile = await resolveProfile(
      {
        builtin: 'local-dev',
        lock: trusted,
        workspaceOverlay: { policy: { capabilityCeiling: ['tools'] } },
      },
      env,
    )
    expect(profile.chain).toContain('workspace:xinwei')
    expect(profile.policy.capabilityCeiling).toEqual(['tools'])

    await expect(
      resolveProfile(
        {
          builtin: 'local-dev',
          lock: trusted,
          workspaceOverlay: { policy: { capabilityCeiling: ['tools', 'exec.unrestricted'] } },
        },
        env,
      ),
    ).rejects.toMatchObject({ code: 'E_CEILING_EXCEEDED' })

    const rejected = await refusal(
      resolveProfile(
        {
          builtin: 'local-dev',
          lock,
          workspaceOverlay: { policy: { capabilityCeiling: ['tools'] } },
        },
        env,
      ),
    )
    expect(rejected.code).toBe('E_WORKSPACE_UNTRUSTED')
  })
})

describe('resolveProfile, the resolved profile is not editable in place', () => {
  it('freezes the nested security-bearing values, not just the top level', async () => {
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const ceiling = p.policy.capabilityCeiling as string[]
    expect(() => ceiling.push('exec.unrestricted')).toThrow(TypeError)
    expect(p.policy.capabilityCeiling).not.toContain('exec.unrestricted')
    expect(() => (p.packages as { id: string }[]).push({ id: '@evil/pkg' })).toThrow(TypeError)
    expect(() => {
      ;(p.packages[0] as { trust: string }).trust = 'builtin'
    }).toThrow(TypeError)
    expect(() => {
      ;(p.seams as unknown as Record<string, string>).approval = '@evil/pkg'
    }).toThrow(TypeError)
    expect(() => {
      ;(p.limits as Record<string, number>)['jobs.tick_ms'] = 1
    }).toThrow(TypeError)
    expect(() => (p.transports as unknown[]).push({ kind: 'ws-tls' })).toThrow(TypeError)
  })
})

// Three assignments in finalize that no fixture exercised, each of which decides something a
// reviewer would want decided: what a package is trusted as, whether it is enabled, and which
// adapters its provider offers.
describe('resolveProfile, the fields finalize decides', () => {
  const trusted: LockState = {
    packages: {
      '@agnes/ai': {
        version: '1',
        integrity: 'builtin:0.1.0',
        source: { type: 'builtin', ref: 'builtin' },
        trust: 'trusted',
        enabled: true,
      },
      '@agnes/base': {
        version: '1',
        integrity: 'builtin:0.1.0',
        source: { type: 'builtin', ref: 'builtin' },
        trust: 'trusted',
        enabled: false,
      },
      '@agnes/code': {
        version: '1',
        integrity: 'builtin:0.1.0',
        source: { type: 'builtin', ref: 'builtin' },
        trust: 'trusted',
        enabled: true,
      },
    },
  }
  it('never promotes a familiar package name above its verified source trust', async () => {
    const p = await resolveProfile({ builtin: 'local-dev', lock: trusted }, env)
    expect(p.packages.map((x) => [x.id, x.trust])).toEqual([
      ['@agnes/ai', 'trusted'],
      ['@agnes/base', 'trusted'],
      ['@agnes/code', 'trusted'],
    ])
    // The closed release-id set cannot change the trust attached to an external source.
    const q = await resolveProfile({ builtin: 'local-dev', lock: trusted, builtinPackages: [] }, env)
    expect(q.packages.map((x) => x.trust)).toEqual(['trusted', 'trusted', 'trusted'])
  })
  it('lets a profile ref decide enabled, and falls back to the lockfile when it does not', async () => {
    const p = await resolveProfile({ builtin: 'local-dev', lock: trusted }, env)
    expect(p.packages.map((x) => [x.id, x.enabled])).toEqual([
      ['@agnes/ai', true],
      ['@agnes/base', false],
      ['@agnes/code', true],
    ])
    const q = await resolveProfile(
      {
        builtin: 'local-dev',
        lock: trusted,
        user: {
          name: 'x',
          packages: [
            { id: '@agnes/base', source: 'builtin', enabled: true },
            { id: '@agnes/code', source: 'builtin', enabled: false },
          ],
        },
      },
      env,
    )
    expect(q.packages.map((x) => [x.id, x.enabled])).toEqual([
      ['@agnes/ai', true],
      ['@agnes/base', true],
      ['@agnes/code', false],
    ])
  })
  // The synthesized-entry path shares the same decision: a ref that says enabled: false is
  // honoured even when no lock entry exists to fall back to.
  it('honours an explicit enabled: false on a builtin ref without a lock entry', async () => {
    const p = await resolveProfile(
      {
        builtin: 'local-dev',
        lock: { packages: {} },
        user: { name: 'x', packages: [{ id: '@agnes/code', source: 'builtin', enabled: false }] },
      },
      env,
    )
    expect(p.packages.map((x) => [x.id, x.enabled])).toEqual([
      ['@agnes/ai', true],
      ['@agnes/base', true],
      ['@agnes/code', false],
    ])
  })
  it('defaults adapter inclusion to the provider package and refuses the removed input field', async () => {
    const user = { name: 'x', provider: { package: '@agnes/code' } }
    const p = await resolveProfile({ builtin: 'local-dev', lock, user }, env)
    expect(p.provider).toMatchObject({ package: '@agnes/code', adapters: ['@agnes/code'] })
    const selected = await resolveProfile(
      {
        builtin: 'local-dev',
        lock,
        user: {
          name: 'x',
          providers: {
            'model-adapter': { provider: ['chat', 'messages'] },
            loop: { provider: 'custom', version: '2.0.0' },
            compaction: { provider: 'short' },
          },
        },
      },
      env,
    )
    expect(selected.provider.adapters).toEqual(['chat', 'messages'])
    expect(selected.loop).toEqual({ id: 'custom', version: '2.0.0' })
    expect(selected.compaction).toEqual({ engine: 'short' })
    for (const removed of [{ loop: { id: 'custom', version: '2.0.0' } }, { compaction: { engine: 'short' } }])
      await expect(
        resolveProfile(
          {
            builtin: 'local-dev',
            lock,
            user: { name: 'x', ...removed } as unknown as RuntimeProfileManifest,
          },
          env,
        ),
      ).rejects.toThrow('is selected with providers.')
    await expect(
      resolveProfile(
        {
          builtin: 'local-dev',
          lock,
          user: {
            name: 'x',
            provider: { package: '@agnes/code', adapters: [] },
          } as unknown as RuntimeProfileManifest,
        },
        env,
      ),
    ).rejects.toThrow('provider.adapters was removed')
  })
})

it('does not promote a familiar package name from file/git/npm to release authority', async () => {
  for (const type of ['file', 'git', 'npm']) {
    const st = {
      version: '0.1.0',
      integrity: 'sha512-external',
      trust: 'trusted' as const,
      enabled: true,
      source: { type, ref: `${type}:external` },
    }
    const p = await resolveProfile({ builtin: 'local-dev', lock: { packages: { '@agnes/base': st } } }, env)
    expect(p.packages.find((pkg) => pkg.id === '@agnes/base')?.trust).toBe('trusted')
    await expect(
      resolveProfile(
        { builtin: 'local-dev', lock: { packages: { '@agnes/base': { ...st, trust: 'builtin' } } } },
        env,
      ),
    ).rejects.toMatchObject({ code: 'E_LOCK_MISMATCH' })
    await expect(
      resolveProfile(
        {
          builtin: 'local-dev',
          user: { name: 'x', packages: [{ id: '@agnes/base', source: `${type}:external` }] },
        },
        env,
      ),
    ).rejects.toMatchObject({ code: 'E_DEP_MISSING' })
  }
  for (const identity of [
    { source: { type: 'builtin', ref: 'file:external' }, integrity: 'builtin:0.1.0', version: '0.1.0' },
    { source: { type: 'builtin', ref: 'builtin' }, integrity: 'builtin:other', version: '0.1.0' },
    { source: { type: 'builtin', ref: 'builtin' }, integrity: 'builtin:0.1.0', version: 'other' },
  ])
    await expect(
      resolveProfile(
        {
          builtin: 'local-dev',
          lock: {
            packages: {
              '@agnes/base': { ...identity, trust: 'builtin', enabled: true },
            },
          },
        },
        env,
      ),
    ).rejects.toMatchObject({ code: 'E_LOCK_MISMATCH' })
})
