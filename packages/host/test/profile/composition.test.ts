import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mcpStablePrefix } from '@agnes/extension-api/mcp-naming'
import { agentSelection } from '@agnes/host-common/profile/agent'
import {
  assertCompositionCompatible,
  type CompositionCatalog,
  checkCompositionPatch,
  checkResolvedCompositionSelection,
  compositionDump,
  expandBundles,
  parsePackageBundles,
  presetCompositionPatch,
  resolveComposition,
  validateComposition,
} from '@agnes/host-common/profile/composition'
import { resolveProfile } from '@agnes/host-common/profile/resolve'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import { createPluginRow } from '@agnes/plugin-runtime/host'
import {
  SessionCapabilitySet,
  validateAgainst,
  validatePreset,
  validateProfileManifest,
  validateResolvedProfile,
} from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { createCompositionAdmin, readBundleSelection } from '../../src/runtime/profile/bundle-selection.js'
import {
  compositionAllowsTool,
  profileForComposition,
  projectCompositionRows,
} from '../../src/runtime/profile/composition-selection.js'
import { sessionBundleCatalog } from '../../src/runtime/profile/session-bundle-presets.js'
import {
  capabilityEnabled,
  resolveSessionCapabilities,
} from '../../src/runtime/profile/session-capabilities.js'
import { pluginHost, pluginRow, pluginSource, targetOf } from '../assemble/plugin-extension-fixture.js'

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
    profile: {
      providers: {
        loop: { provider: 'example.dag', version: '1.0.0' },
        compaction: { provider: 'sliding-window' },
      },
    },
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
          { name: 'computer_use', readOnly: true, requiresImageInput: true },
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
  expect(sessionBundleCatalog(profile, {})).toEqual(catalog)
  expect(sessionBundleCatalog(profile, {}, new Set(['acme/research']))).toEqual({})
  const installed = {
    ...profile,
    packages: [
      ...profile.packages,
      { ...profile.packages[0]!, id: 'acme/research', trust: 'trusted' as const },
    ],
  }
  expect(sessionBundleCatalog(installed, {})).toEqual({})
  expect(sessionBundleCatalog(installed, catalog)).toEqual(catalog)
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
        session: { providers: { loop: { provider: 'example.dag', version: '1.0.0' } } },
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
          demo: {
            profile: { providers: { loop: { provider: defaultLoop.id, version: defaultLoop.version } } },
          },
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
  const pinned = {
    loop: { id: 'echo', version: '1.0.0' },
    compaction: { engine: 'default' },
    modelAdapters: ['chat'],
  }
  expect(checkResolvedCompositionSelection(pinned)).toEqual(pinned)
  expect(checkResolvedCompositionSelection({ compaction: null })).toEqual({ compaction: null })
  expect(() => checkResolvedCompositionSelection({ modelAdapters: 'chat' })).toThrow()
  expect(() => checkResolvedCompositionSelection({ loop: { provider: 'echo', version: '1.0.0' } })).toThrow()
  expect(() => checkCompositionPatch({ toolPolicy: { readOnly: 'yes' } })).toThrow('toolPolicy')
  expect(() => checkCompositionPatch({ tools: ['lookup', 'lookup'] })).toThrow('tools')
  for (const old of [
    { loop: { id: 'echo', version: '1.0.0' } },
    { compaction: { engine: 'default' } },
    { modelAdapters: ['echo'] },
    { providers: { 'model-adapter': { provider: ['echo', 'echo'] } } },
    { providers: { 'tool-policy': { provider: 'read-only' } } },
    // The provider kinds are selected in providers.<kind>, never as patch keys of their own.
    { loop: { provider: 'echo', version: '1.0.0' } },
    { 'model-adapter': { provider: ['chat'] } },
    { persistence: { provider: 'sqlite' } },
  ])
    expect(() => checkCompositionPatch(old)).toThrow()
  expect(() => checkCompositionPatch({ loop: { provider: 'echo', version: '1.0.0' } })).toThrow(
    'providers.loop',
  )
  expect(
    checkCompositionPatch({ providers: { 'model-adapter': { provider: ['chat', 'messages'] } } }),
  ).toEqual({ providers: { 'model-adapter': { provider: ['chat', 'messages'] } } })
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
  const privateRow = (id: string, revision: string) =>
    createPluginRow({
      id,
      plugin: 'builtin:host/private',
      snapshotDigest: 'host-private',
      exportName: id,
      entryRevision: revision,
      extrasRevision: 'none',
      mountRevision: revision,
      config: { revision },
      inject: [],
      provides: [],
    })
  const previousSeam = privateRow('seam:approval', 'previous')
  const localSeam = privateRow('seam:approval', 'local')
  const forgedSeam = privateRow('seam:approval', 'forged')
  expect(projectCompositionRows([previousSeam], baseline, undefined, [localSeam], [previousSeam])).toEqual([])
  expect(
    projectCompositionRows([forgedSeam], baseline, undefined, [localSeam], [previousSeam]),
  ).toMatchObject([forgedSeam])
  const previousExtension = privateRow('ext:host/private', 'previous')
  const localExtension = privateRow('ext:host/private', 'local')
  expect(
    projectCompositionRows(
      [{ ...previousExtension, disabled: true }],
      baseline,
      undefined,
      [localExtension],
      [previousExtension],
    ),
  ).toMatchObject([{ ...localExtension, disabled: true }])
  const next = resolveComposition(profile, {
    preset: { name: 'research', providers: { compaction: { provider: 'sliding-window' } } },
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
      composition: compiled.composition,
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
    session: { providers: { loop: { provider: 'default', version: '1.0.0' } } },
  })
  const canonical = resolveComposition(profile, {
    ...options,
    session: { providers: { loop: { provider: 'agnes.default', version: '1.0.0' } } },
  })
  expect(alias.selection.loop).toEqual({ id: 'agnes.default', version: '1.0.0' })
  expect(alias.hash).toBe(canonical.hash)
  expect(() =>
    resolveComposition(profile, {
      ...options,
      session: { providers: { loop: { provider: 'default', version: '2.0.0' } } },
    }),
  ).toThrow('unknown loop')
})

it('reads a preset selection from its one providers table', () => {
  expect(
    presetCompositionPatch({ name: 'p', providers: { 'tool-policy': { provider: 'read-only' } } }),
  ).toEqual({})
  expect(
    presetCompositionPatch({
      name: 'p',
      composition: { tools: ['lookup'] },
      providers: { 'tool-runtime': { provider: 'serial' }, compaction: { provider: 'sliding-window' } },
    }),
  ).toEqual({ tools: ['lookup'], providers: { compaction: { provider: 'sliding-window' } } })
  // A preset has one table; a second provider block in its composition is not another way to write it.
  expect(() =>
    presetCompositionPatch({
      name: 'p',
      composition: { providers: { loop: { provider: 'x', version: '1.0.0' } } },
    }),
  ).toThrow('providers table')
  expect(validatePreset({ name: 'p', providers: { 'tool-policy': { provider: 'read-only' } } }).ok).toBe(true)
  expect(validatePreset({ name: 'p', 'tool-policy': { provider: 'read-only' } }).ok).toBe(false)
})

it('resolves explicit agent presets at the session layer, with source dependency validation and no inherited launch', async () => {
  const bundles = {
    ...parsePackageBundles('acme/parent', {
      parent: { profile: { toolPolicy: { readOnly: false } } },
    }),
    ...parsePackageBundles('acme/kit', {
      writer: {
        extends: ['acme/parent#parent'],
        profile: { tools: ['write'], providers: { loop: { provider: 'shared', version: '1.0.0' } } },
        presets: {
          safe: { name: 'safe', composition: { toolPolicy: { readOnly: true } } },
          other: { name: 'other' },
        },
        launch: { title: { en: 'Writer' }, description: { en: 'Writer' }, preset: 'safe' },
      },
      reader: {
        profile: { tools: ['read'], providers: { loop: { provider: 'shared', version: '1.0.0' } } },
        presets: { other: { name: 'other' } },
        launch: { title: { en: 'Reader' }, description: { en: 'Reader' }, preset: 'other' },
      },
      child: { extends: ['acme/kit#writer'] },
    }),
  }
  const sources = [
    {
      id: 'acme/kit',
      version: '1.0.0',
      integrity: 'kit',
      source: 'file',
      enabled: true,
      dependencies: { 'acme/parent': '^1.0.0' },
    },
    {
      id: 'acme/parent',
      version: '1.0.0',
      integrity: 'parent',
      source: 'file',
      enabled: true,
      dependencies: {},
    },
  ]
  const selection = agentSelection('acme/kit#writer', bundles, sources)
  expect(selection.preset).toBe('safe')
  expect(selection.bundles).toEqual(['acme/kit#writer'])
  expect(selection.sources.map((source) => source.id).sort()).toEqual(['acme/kit', 'acme/parent'])
  const profile = await resolveProfile(
    { builtin: 'local-dev', user: { name: 'local-dev' }, bundleCatalog: bundles },
    env,
  )
  const admitted = {
    ...profile,
    presets: { ...profile.presets, allowed: [...profile.presets.allowed, 'safe', 'other'] },
    bundleCatalog: bundles,
  }
  const writer = resolveComposition(admitted, {
    preset: bundles['acme/kit#writer']!.document.presets!.safe!,
    sessionBundles: selection.bundles,
  })
  expect(writer.selection.toolPolicy?.readOnly).toBe(false)
  expect(writer.sources['toolPolicy.readOnly']).toEqual({ layer: 'session', name: 'acme/parent#parent' })
  const reader = resolveComposition(admitted, {
    preset: { name: 'other' },
    sessionBundles: agentSelection('acme/kit#reader', bundles, sources).bundles,
  })
  expect(reader.selection.loop).toEqual(writer.selection.loop)
  expect(reader.selection.tools).toEqual(['read'])
  expect(writer.selection.tools).toEqual(['write'])
  expect(() => agentSelection('acme/kit#child', bundles, sources)).toThrow('unknown agent')
  expect(() => agentSelection('acme/kit#missing', bundles, sources)).toThrow()
  expect(() => agentSelection('acme/kit#writer', bundles, [sources[0]!])).toThrow()
  expect(() =>
    agentSelection('acme/kit#writer', bundles, [{ ...sources[0]!, dependencies: {} }, sources[1]!]),
  ).toThrow()
  expect(() =>
    agentSelection('acme/kit#writer', bundles, [sources[0]!, { ...sources[1]!, version: '2.0.0' }]),
  ).toThrow()
  const cyclic = structuredClone(bundles)
  cyclic['acme/parent#parent']!.document.extends = ['acme/kit#writer']
  expect(() => agentSelection('acme/kit#writer', cyclic, sources)).toThrow('cycle')
})

it.each(['mcp', 'skills'] as const)(
  'role %s resource bounds use canonical IDs and empty means refusal',
  (kind) => {
    const live = {
      mcp: [{ id: 'mcp/common', name: 'Common MCP' }, { id: 'mcp/private' }],
      skills: [{ id: 'skill/common', name: 'Common Skill' }, { id: 'skill/private' }],
    }
    const id = kind === 'mcp' ? 'mcp/common' : 'skill/common'
    const input = {
      selection: { mcp: [], skills: [] },
      live,
      installed: {
        tools: [
          { name: mcpStablePrefix('common') + 'read', readOnly: true },
          { name: mcpStablePrefix('private') + 'read', readOnly: true },
        ],
      },
      resourceRequest: { kind, id: kind === 'mcp' ? 'common' : 'Common Skill' },
    }
    const bound = resolveSessionCapabilities({
      ...input,
      resourceScope: { mcp: ['mcp/common'], skills: ['skill/common'] },
    })
    expect(bound[kind].filter((resource) => resource.enabled).map((resource) => resource.id)).toEqual([id])
    expect(bound.resourceRequest?.enabled).toBe(true)
    expect(bound.tools.filter((tool) => tool.enabled).map((tool) => tool.id)).toEqual([
      mcpStablePrefix('common') + 'read',
    ])
    const empty = resolveSessionCapabilities({ ...input, resourceScope: { mcp: [], skills: [] } })
    expect(empty[kind].every((resource) => !resource.enabled)).toBe(true)
    expect(empty.resourceRequest?.enabled).toBe(false)
    expect(empty.tools.every((tool) => !tool.enabled)).toBe(true)
  },
)

it('reports a session tool filter as the last word on a tool, and only a filtered session shows its rules', () => {
  const input = {
    selection: { toolPolicy: { deny: ['write'] } },
    installed: {
      tools: ['read', 'write', 'search'].map((name) => ({ name, readOnly: false })),
    },
  }
  const plain = resolveSessionCapabilities(input)
  expect(plain.tools.flatMap((tool) => tool.reasons).some((r) => r.rule.startsWith('session-'))).toBe(false)
  const filtered = resolveSessionCapabilities({
    ...input,
    toolFilter: { allow: ['read', 'write'], deny: ['read'] },
  })
  const by = (id: string) => filtered.tools.find((tool) => tool.id === id)
  const source = { layer: 'session', name: 'tool-filter' }
  expect(by('read')).toMatchObject({ enabled: false, reasons: [{ rule: 'session-deny', source }] })
  expect(by('search')).toMatchObject({ enabled: false, reasons: [{ rule: 'session-allow', source }] })
  // The profile already turned `write` off; the session allow list cannot bring it back.
  expect(by('write')).toMatchObject({ enabled: false, reasons: [{ rule: 'policy-deny' }] })
  expect(filtered.tools.filter((tool) => tool.enabled)).toEqual([])
})

it('applies disabled-plugin, config and resource changes after skipping an equivalent composition', async () => {
  const source = pluginSource("ctx.tools.register(tool('review_composition'))")
  const f = await pluginHost(source, { profileInputs: { user: { name: 'local-dev', composition: {} } } })
  try {
    const row = pluginRow()
    expect(await f.host.applyRuntimeTarget(targetOf([row]))).toMatchObject({ ok: true })
    const before = f.host.pluginGenerationStatus!().currentGenerationId
    expect(before).toEqual(expect.any(String))
    expect(await f.host.applyRuntimeTarget(targetOf([row]))).toMatchObject({ ok: true })
    expect(f.host.pluginGenerationStatus!().currentGenerationId).toEqual(before)
    const resourceTarget = buildCompleteRuntimeTarget({
      rows: [row],
      resources: { mcp: [], skills: { review: 'new resource' } },
    }).target
    expect(await f.host.applyRuntimeTarget(resourceTarget)).toMatchObject({ ok: true })
    expect(f.host.runtimeTargetSnapshot!().resource.resources).toEqual(resourceTarget.resource.resources)
    expect(
      await f.host.applyRuntimeTarget(targetOf([{ ...row, config: { revision: 'changed' } }])),
    ).toMatchObject({ ok: true })
    expect(f.host.runtimeTargetSnapshot!().tree.rows.find((entry) => entry.id === row.id)?.config).toEqual({
      revision: 'changed',
    })
    expect(await f.host.applyRuntimeTarget(targetOf([{ ...row, disabled: true }]))).toMatchObject({
      ok: true,
    })
    expect(f.host.kernel.tools.list().map((tool) => tool.name)).not.toContain('review_composition')
  } finally {
    await f.host.close()
  }
})

// Enabled-row equality must still check the exact running code's current grant.
it.each(['trust', 'capability binding', 'source removal'] as const)(
  'refuses revoked %s when only a disabled row outside the composition changes',
  async (revoked) => {
    const source = pluginSource("ctx.tools.register(tool('review_trust'))")
    let current = [source]
    const f = await pluginHost(source, {
      profileInputs: { user: { name: 'local-dev', composition: {} } },
      runtimePluginSources: async () => current,
    })
    try {
      const row = pluginRow()
      const excluded = pluginRow('ext:acme/excluded', 'unused', true)
      expect(await f.host.applyRuntimeTarget(targetOf([row, excluded]))).toMatchObject({ ok: true })
      current =
        revoked === 'source removal'
          ? []
          : [
              {
                ...source,
                trusted: revoked !== 'trust',
                snapshot: {
                  ...source.snapshot,
                  capabilityHash:
                    revoked === 'capability binding' ? 'revoked' : source.snapshot.capabilityHash,
                },
              },
            ]
      const before = f.host.pluginGenerationStatus!().currentGenerationId
      // Effective enabled rows are identical, but their authority has changed since publication.
      const result = await f.host.applyRuntimeTarget(targetOf([row]))
      expect(result.ok).toBe(false)
      expect(result.publication?.containers).toContainEqual(
        expect.objectContaining({
          status: 'failed',
          error: expect.stringContaining('E_GENERATION_UNTRUSTED'),
        }),
      )
      current = [source]
      expect(await f.host.applyRuntimeTarget(targetOf([row]))).toMatchObject({ ok: true })
      expect(f.host.pluginGenerationStatus!().currentGenerationId).toBe(before)
    } finally {
      await f.host.close()
    }
  },
)
