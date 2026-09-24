import { describe, expect, it } from 'vitest'
import { isHostError } from '../../src/errors.js'
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
      integrity: 'sha512-b',
      trust: 'builtin',
      enabled: true,
      provides: [
        'approval',
        'checkpoint',
        'ledger',
        'sandbox',
        'verifier',
        'repair',
        'artifacts',
        'principals',
        'harness',
      ],
    },
    '@agnes/code': { version: '0.1.0', integrity: 'sha512-c', trust: 'builtin', enabled: true },
    '@agnes/ai': { version: '0.1.0', integrity: 'sha512-a', trust: 'builtin', enabled: true },
  },
}

/** The code a rejection actually carried, so a refusal cannot be credited to the wrong check. */
async function refusal(p: Promise<unknown>): Promise<{ code: string; detail: unknown }> {
  try {
    await p
    expect.unreachable('should have refused')
  } catch (e) {
    if (!isHostError(e)) throw e
    return { code: e.code, detail: e.detail }
  }
  throw new Error('unreachable')
}

describe('resolveProfile (single layer)', () => {
  it('resolves local-dev template alone', async () => {
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
    expect(p.name).toBe('local-dev')
    expect(p.chain).toEqual(['builtin:local-dev'])
    expect(p.packages.map((x) => x.id)).toEqual(['@agnes/ai', '@agnes/base', '@agnes/code'])
    expect(p.seams.approval).toBe('@agnes/base')
    expect(p.seams.platform).toBe('@agnes/host')
    expect(p.presets).toEqual({ default: 'standard', allowed: ['standard'] })
    expect(p.hash).toMatch(/^sha256-[0-9a-f]{64}$/)
    expect(Object.isFrozen(p)).toBe(true)
  })
  it('carries lockfile version and integrity onto each resolved package', async () => {
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env)
    expect(p.packages.find((x) => x.id === '@agnes/base')).toMatchObject({
      version: '0.1.0',
      integrity: 'sha512-b',
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
        seams: { approval: '@agnes/code' },
        transports: [{ kind: 'unix' }],
        presets: { default: 'code', allowed: ['code'] },
      },
    }
    const p = await resolveProfile(inputs, env)
    expect(p.name).toBe('mine')
    expect(p.chain).toEqual(['builtin:local-dev', 'user:mine'])
    expect(p.dataDir).toBe('/tmp/agnes')
    expect(p.seams.approval).toBe('@agnes/code')
    expect(p.seams.ledger).toBe('@agnes/base')
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
      ['seams', { name: 'local-dev', seams: { approval: '@agnes/code' } }],
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
  it('rejects a missing seam with E_SEAM_MISSING and names the seam', async () => {
    const r = await refusal(
      resolveProfile({ builtin: 'local-dev', lock, user: { name: 'x', seams: { approval: '' } } }, env),
    )
    expect(r.code).toBe('E_SEAM_MISSING')
    expect(r.detail).toEqual({ seam: 'approval' })
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
      ;(p.seams as Record<string, string>).approval = '@evil/pkg'
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
      '@agnes/ai': { version: '1', integrity: 'sha512-a', trust: 'trusted', enabled: true },
      '@agnes/base': { version: '1', integrity: 'sha512-b', trust: 'trusted', enabled: false },
      '@agnes/code': { version: '1', integrity: 'sha512-c', trust: 'trusted', enabled: true },
    },
  }
  it('stamps a builtin package as builtin whatever the lockfile claims', async () => {
    const p = await resolveProfile({ builtin: 'local-dev', lock: trusted }, env)
    expect(p.packages.map((x) => [x.id, x.trust])).toEqual([
      ['@agnes/ai', 'builtin'],
      ['@agnes/base', 'builtin'],
      ['@agnes/code', 'builtin'],
    ])
    // And a package that is not builtin keeps the lockfile's answer, so the stamp is a decision
    // about the builtin set rather than a blanket upgrade.
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
  // A YAML manifest cannot spell an explicit undefined, so the cast is how a test reaches the
  // fallback at all: a provider that names no adapters offers itself, not nothing.
  it('defaults provider.adapters to the provider package rather than to nothing', async () => {
    const user = {
      name: 'x',
      provider: { package: '@agnes/code', adapters: undefined },
    } as unknown as RuntimeProfileManifest
    const p = await resolveProfile({ builtin: 'local-dev', lock, user }, env)
    expect(p.provider).toMatchObject({ package: '@agnes/code', adapters: ['@agnes/code'] })
  })
})
