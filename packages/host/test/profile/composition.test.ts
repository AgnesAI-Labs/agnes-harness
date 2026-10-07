import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  assertCompositionCompatible,
  checkCompositionPatch,
  compositionAllowsTool,
  compositionDump,
  expandBundles,
  parsePackageBundles,
  profileForComposition,
  resolveComposition,
  validateComposition,
  type CompositionCatalog,
} from '../../src/profile/composition.js'
import { createCompositionAdmin, readBundleSelection } from '../../src/profile/bundle-selection.js'
import { resolveProfile } from '../../src/profile/resolve.js'
import { validateProfileManifest, validateResolvedProfile, validatePreset } from '@agnes/protocol'

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

it('resolves inherited bundles, preset/admin/session precedence and safe dumps', async () => {
  const profile = await resolveProfile(
    {
      builtin: 'local-dev',
      bundleCatalog: catalog,
      user: { name: 'local-dev', bundles: ['acme/research#research'] },
    },
    env,
  )
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
    { builtin: 'local-dev', user: { name: 'local-dev', presets: { allowed: ['standard', 'research'] } } },
    env,
  )
  const baseline = resolveComposition(profile)
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
