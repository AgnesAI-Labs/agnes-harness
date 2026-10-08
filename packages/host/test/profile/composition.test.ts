import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertCompositionCompatible,
  type CompositionCatalog,
  checkCompositionPatch,
  compositionDump,
  expandBundles,
  parsePackageBundles,
  resolveComposition,
  validateComposition,
} from '@agnes/host-common/profile/composition'
import { resolveProfile } from '@agnes/host-common/profile/resolve'
import { createCompositionAdmin, readBundleSelection } from '@agnes/host-runtime/profile/bundle-selection'
import {
  compositionAllowsTool,
  profileForComposition,
} from '@agnes/host-runtime/profile/composition-selection'
import {
  capabilityEnabled,
  resolveSessionCapabilities,
} from '@agnes/host-runtime/profile/session-capabilities'
import {
  SessionCapabilitySet,
  validateAgainst,
  validatePreset,
  validateProfileManifest,
  validateResolvedProfile,
} from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'

const env = {
  platform: { os: 'linux' as const, arch: 'x64', capabilities: {} },
  agnesVersion: '1.4.0',
  now: '2026-10-07',
  homeDir: '/synthetic/home',
}
const catalog = parsePackageBundles('acme/research', {
  base: {
    profile: {
      toolPolicy: { readOnly: true, deny: ['remove'] },
      plugins: { 'tool:lookup': { config: { token: 'synthetic-secret' } } },
    },
  },
  research: {
    extends: ['acme/research#base'],
    profile: { loop: { id: 'example.dag', version: '1.0.0' }, compaction: { engine: 'sliding-window' } },
    presets: { research: { name: 'research', extends: 'standard', composition: { tools: ['lookup'] } } },
  },
})
const runtime: CompositionCatalog = {
  loops: [{ id: 'example.dag', version: '1.0.0', sourcePackage: 'acme/loop', capabilities: ['compaction'] }],
  persistenceProviders: [{ id: 'sqlite' }],
  sandboxProviders: [{ id: 'local' }],
  modelAdapters: [],
  compactionEngines: [{ id: 'sliding-window', version: '1.0.0', sourcePackage: 'acme/engine' }],
  tools: ['lookup', 'remove'],
}
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const capabilityCases: [
  string,
  { bundles?: string[] },
  NonNullable<Parameters<typeof resolveComposition>[1]>,
  string[],
  string,
][] = [
  ['default', {}, {}, ['read', 'write'], 'default'],
  ['bundle', { bundles: ['acme/cap#reader'] }, {}, ['read', 'owned'], 'profile'],
  ['preset', {}, { preset: { name: 'standard', composition: { tools: ['write'] } } }, ['write'], 'preset'],
  ['admin default', {}, { admin: { composition: { tools: ['write'] } } }, ['write'], 'admin'],
  [
    'explicit session',
    {},
    { admin: { composition: { tools: ['write'] } }, session: { tools: ['read'] } },
    ['read'],
    'session',
  ],
  [
    'legacy session',
    {},
    { session: { tools: ['read'], toolPolicy: { readOnly: true } } },
    ['read', 'write', 'owned'],
    'session',
  ],
  ['cold resume', { bundles: ['acme/cap#reader'] }, {}, ['read', 'owned'], 'profile'],
  ['hot reload', { bundles: ['acme/cap#reader'] }, {}, ['read', 'owned'], 'profile'],
]
it.each(capabilityCases)(
  'resolves %s capabilities with immutable, safe provenance',
  async (mode, user, layers, names, layer) => {
    const bundles = parsePackageBundles('acme/cap', {
      reader: {
        profile: {
          tools: ['read', 'owned'],
          mcp: ['mcp/one'],
          skills: ['reader'],
          uiModules: ['panel'],
          plugins: { 'tool:blocked': { enabled: false } },
          toolPolicy: { readOnly: true },
        },
      },
    })
    const profile = await resolveProfile(
      { builtin: 'local-dev', bundleCatalog: bundles, user: { name: 'local-dev', ...user } },
      env,
    )
    const tree = resolveComposition(profile, layers)
    const pinned = mode === 'cold resume' || mode === 'hot reload'
    const result = resolveSessionCapabilities({
      // A changed deployment must not replace a durable composition on resume/reload.
      profile: pinned ? { ...profile, composition: { tools: ['write'] } } : profile,
      composition: tree,
      routes: { primary: { route: 'fixture', model: 'synthetic-model' } },
      preset: { name: 'standard' },
      pin: {
        legacy: mode === 'legacy session',
        ...(pinned ? { generationId: 'original', loop: { id: 'agnes.default', version: '1.0.0' } } : {}),
      },
      installed: {
        plugins: [
          { id: 'tool:blocked', enabled: true },
          { id: 'tool:active', enabled: true },
        ],
        tools: [
          { name: 'computer_use', readOnly: true },
          { name: 'read', readOnly: true },
          { name: 'write', readOnly: false },
          { name: 'owned', readOnly: true, packageId: 'acme/cap' },
        ],
        childEngines: ['in-process', 'external'],
        modelAdapters: ['scripted'],
        uiModules: [{ id: 'panel', slots: ['sidebar'] }, { id: 'other' }],
      },
      computerUseAllowed: false,
      childAllowlist: { providers: ['in-process'], models: ['child-model'] },
      live: {
        mcp: [{ id: 'one' }, { id: 'two' }],
        skills:
          mode === 'hot reload' ? [{ id: 'new', name: 'writer' }] : [{ id: 'skill/read', name: 'reader' }],
      },
    })
    expect(result.tools.filter((item) => item.enabled).map((item) => item.id)).toEqual(names)
    expect(result.tools.find((item) => item.id === names[0])?.reasons).toContainEqual({
      rule: 'tool-selection',
      source: mode === 'legacy session' ? { layer: 'session', name: 'legacy-binding' } : tree.sources.tools,
    })
    expect(tree.sources.tools?.layer).toBe(layer)
    expect(result.tools.find((item) => item.id === 'owned')?.enabled).toBe(names.includes('owned'))
    expect(result.tools.find((item) => item.id === 'computer_use')).toMatchObject({
      enabled: false,
      reasons: expect.arrayContaining([
        { rule: 'model-input', source: { layer: 'session', name: 'primary-model' } },
      ]),
    })
    expect(capabilityEnabled(result.plugins, 'tool:blocked')).toBe(!user.bundles)
    expect(capabilityEnabled(result.plugins, 'tool:active')).toBe(true)
    if (user.bundles)
      expect(result.plugins.find((item) => item.id === 'tool:blocked')?.reasons).toEqual([
        { rule: 'plugin-enabled', source: { layer: 'profile', name: 'acme/cap#reader' } },
      ])
    expect(capabilityEnabled(result.childEngines, 'external')).toBe(false)
    expect(result.childEngines.find((item) => item.id === 'external')?.reasons[0]?.rule).toBe(
      'child-provider-allowlist',
    )
    expect(result.sandbox).toMatchObject({ provider: 'local', onUnavailable: 'deny' })
    expect(result.permissions).toMatchObject({
      preset: 'standard',
      policy: 'default',
      toolRuntime: 'default',
    })
    expect(result.modelRoutes.value?.primary.route).toBeDefined()
    expect(result.loop.value).toEqual({ id: 'agnes.default', version: '1.0.0' })
    if (pinned) {
      expect(result.codePin.generationId).toBe('original')
      expect(result.loop.source).toEqual({ layer: 'session', name: 'code-pin' })
    }
    if (user.bundles) {
      expect(result.mcp.filter((item) => item.enabled).map((item) => item.id)).toEqual(['one'])
      expect(result.mcp.map((item) => item.id)).toEqual(['one', 'two'])
      expect(result.uiModules.filter((item) => item.enabled).map((item) => item.id)).toEqual(['panel'])
    }
    if (mode === 'hot reload')
      expect(result.skills.find((item) => item.id === 'reader')).toMatchObject({
        enabled: false,
        reasons: [{ rule: 'resource-unavailable', source: { layer: 'session', name: 'live-resources' } }],
      })
    expect(validateAgainst(SessionCapabilitySet, result).ok).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.tools[0]?.reasons[0]?.source)).toBe(true)
    expect(Reflect.set(result.tools[0]!, 'enabled', false)).toBe(false)
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  },
)

it('resolves inherited bundles, preset/admin/session precedence and safe dumps', async () => {
  const profile = await resolveProfile(
    {
      builtin: 'local-dev',
      bundleCatalog: catalog,
      user: { name: 'local-dev', bundles: ['acme/research#research'] },
    },
    env,
  )
  expect(
    resolveComposition({
      ...profile,
      bundles: [],
      composition: {},
      loop: { id: 'agnes.default', version: '1.0.0' },
    }).toolScope?.activePackages,
  ).toEqual([])
  expect(
    resolveComposition(
      { ...profile, bundles: [], composition: {}, loop: { id: 'agnes.default', version: '1.0.0' } },
      {
        session: { loop: { id: 'example.dag', version: '1.0.0' } },
      },
    ).toolScope?.activePackages,
  ).toEqual(['acme/research'])
  const defaultLoop = { id: 'agnes.default', version: '1.0.0' }
  expect(
    resolveComposition({
      ...profile,
      bundles: [],
      composition: {},
      loop: defaultLoop,
      bundleCatalog: {
        ...catalog,
        ...parsePackageBundles('acme/shared-default', {
          demo: { profile: { loop: defaultLoop } },
        }),
      },
    }).toolScope?.activePackages,
  ).toEqual([])
  expect(profile.bundlePresets?.research?.name).toBe('research')
  expect(profile.presets.allowed).toContain('research')
  const tree = resolveComposition(profile, {
    preset: profile.bundlePresets!.research!,
    catalog: runtime,
    admin: { composition: { toolPolicy: { deny: [] } } },
    session: { toolPolicy: { allow: ['lookup'] } },
    rows: [{ id: 'tool:lookup', packageId: 'acme/tools', enabled: true }],
  })
  expect(tree.selection.toolPolicy).toEqual({ readOnly: true, allow: ['lookup'], deny: [] })
  expect(tree.sources['loop']).toEqual({ layer: 'profile', name: 'acme/research#research' })
  expect(tree.sources['tools']!.layer).toBe('preset')
  expect(tree.sources['toolPolicy.deny']!.layer).toBe('admin')
  expect(tree.sources['toolPolicy.allow']!.layer).toBe('session')
  expect(tree.sources['plugins.tool:lookup.config']!.name).toBe('acme/research#base')
  expect(JSON.stringify(compositionDump(tree))).not.toContain('synthetic-secret')
  expect(tree.hash).toBe(
    resolveComposition(profile, {
      preset: profile.bundlePresets!.research!,
      catalog: runtime,
      admin: { composition: { toolPolicy: { deny: [] } } },
      session: { toolPolicy: { allow: ['lookup'] } },
      rows: [{ id: 'tool:lookup', packageId: 'acme/tools', enabled: true }],
    }).hash,
  )
})

it('fails closed for cycles, unknown bundles, registrations and missing capabilities', () => {
  expect(() => expandBundles(['missing#base'], catalog)).toThrow('unknown bundle')
  const cyclic = parsePackageBundles('acme/cycle', {
    one: { extends: ['acme/cycle#two'] },
    two: { extends: ['acme/cycle#one'] },
  })
  expect(() => expandBundles(['acme/cycle#one'], cyclic)).toThrow('cycle')
  expect(() =>
    validateComposition({ loop: { id: 'example.dag', version: '1.0.0' }, compaction: null }, runtime),
  ).toThrow('requires compaction')
  expect(() => validateComposition({ loop: { id: 'missing', version: '1' } }, runtime)).toThrow(
    'unknown loop',
  )
  expect(() => validateComposition({ modelAdapters: ['missing'] }, runtime)).toThrow('unknown model adapter')
  expect(() => validateComposition({ sandbox: { provider: 'missing' } }, runtime)).toThrow('unknown sandbox')
  expect(() => validateComposition({ tools: ['missing'] }, runtime)).toThrow('unknown tool')
})

it('rejects executable, malformed and dangerous patches before reading their fields', () => {
  expect(() => checkCompositionPatch({ toolPolicy: { readOnly: 'yes' } })).toThrow('toolPolicy')
  expect(() => checkCompositionPatch({ tools: ['lookup', 'lookup'] })).toThrow('tools')
  expect(() => checkCompositionPatch({ plugins: JSON.parse('{"__proto__":{"enabled":true}}') })).toThrow()
  expect(() =>
    checkCompositionPatch({
      get loop() {
        throw new Error('getter ran')
      },
    }),
  ).toThrow('JSON data')
  expect(() => checkCompositionPatch({ plugins: { id: { config: () => undefined } } })).toThrow('JSON data')
})

it('enforces readonly, allow/deny and explicit tool sets for every invocation', () => {
  const selection = { tools: ['lookup', 'write'], toolPolicy: { readOnly: true, deny: ['write'] } }
  expect(compositionAllowsTool(selection, 'lookup', true)).toBe(true)
  expect(compositionAllowsTool(selection, 'lookup', false)).toBe(false)
  expect(compositionAllowsTool(selection, 'write', true)).toBe(false)
  expect(compositionAllowsTool(selection, 'other', true)).toBe(false)
})

it('compiles a separate preset Host and refuses changes to a running provider tree', async () => {
  const profile = await resolveProfile(
    {
      builtin: 'local-dev',
      user: { name: 'local-dev', presets: { default: 'standard', allowed: ['standard', 'research'] } },
    },
    env,
  )
  const baseline = resolveComposition(profile)
  const packageCatalog = [{ id: 'acme/published', enabled: true }]
  expect(resolveComposition(profile, { packageCatalog })).toEqual(baseline)
  const published = resolveComposition(profile, {
    packageCatalog,
    session: { packages: [{ id: 'acme/published', source: 'runtime-snapshot', enabled: true }] },
  })
  expect(published.selection.packages).toContainEqual({
    id: 'acme/published',
    source: 'runtime-snapshot',
    enabled: true,
  })
  expect(
    resolveComposition(profile, {
      packageCatalog: [{ id: 'acme/published', enabled: false }],
      session: { packages: [{ id: 'acme/published', source: 'runtime-snapshot', enabled: true }] },
    }).selection.packages,
  ).toContainEqual({ id: 'acme/published', source: 'runtime-snapshot', enabled: false })
  expect(() =>
    resolveComposition(profile, {
      session: { packages: [{ id: 'acme/unknown', source: 'runtime-snapshot', enabled: true }] },
    }),
  ).toThrow('unknown package acme/unknown')
  const next = resolveComposition(profile, {
    preset: { name: 'research', composition: { compaction: { engine: 'sliding-window' } } },
  })
  expect(() => assertCompositionCompatible(baseline, next)).toThrow('separate Host generation')
  const compiled = profileForComposition(profile, next)
  expect(compiled.compaction?.engine).toBe('sliding-window')
  expect(compiled.presets.default).toBe('research')
  expect(compiled.hash).not.toBe(profile.hash)
  expect(validateResolvedProfile(compiled).ok).toBe(true)
  expect(
    validateProfileManifest({
      name: 'local-dev',
      bundles: ['acme/research#research'],
      composition: next.selection,
    }).ok,
  ).toBe(true)
  expect(validatePreset({ name: 'research', composition: { toolPolicy: { readOnly: true } } }).ok).toBe(true)
  expect(() => resolveComposition(profile, { preset: { name: 'unknown' } })).toThrow('not allowed')
})

it('saves admin bundles with optimistic concurrency and reloads desired origins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-composition-'))
  roots.push(root)
  const admin = createCompositionAdmin({
    profileDir: root,
    resolveProfile: (override) =>
      resolveProfile(
        {
          builtin: 'local-dev',
          bundleCatalog: catalog,
          adminBundles: override ?? readBundleSelection(root).bundles,
        },
        env,
      ),
  })
  expect((await admin.bundles()).revision).toBe(0)
  await expect(admin.saveBundles({ revision: 0, bundles: ['missing#base'] })).rejects.toThrow()
  expect((await admin.saveBundles({ revision: 0, bundles: ['acme/research#research'] })).effect).toBe(
    'restart-required',
  )
  expect((await admin.dump()).sources.loop!.layer).toBe('admin')
  await expect(admin.saveBundles({ revision: 0, bundles: [] })).rejects.toMatchObject({
    code: 'CONFIG_REVISION_CONFLICT',
  })
  expect((await admin.bundles()).bundles).toEqual(['acme/research#research'])
})

it('canonicalizes the documented default loop alias before catalog validation and hashing', async () => {
  const profile = await resolveProfile({ builtin: 'local-dev' }, env)
  const options = {
    catalog: {
      ...runtime,
      loops: [{ id: 'agnes.default', version: '1.0.0', sourcePackage: '@agnes/core', capabilities: [] }],
    },
  }
  const alias = resolveComposition(profile, {
    ...options,
    session: { loop: { id: 'default', version: '1.0.0' } },
  })
  const canonical = resolveComposition(profile, {
    ...options,
    session: { loop: { id: 'agnes.default', version: '1.0.0' } },
  })
  expect(alias.selection.loop).toEqual({ id: 'agnes.default', version: '1.0.0' })
  expect(alias.hash).toBe(canonical.hash)
  expect(() =>
    resolveComposition(profile, { ...options, session: { loop: { id: 'default', version: '2.0.0' } } }),
  ).toThrow('unknown loop')
})
