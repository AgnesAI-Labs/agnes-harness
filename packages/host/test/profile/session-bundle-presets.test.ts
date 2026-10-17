import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { defaultToolPolicy, toolPolicyKind } from '@agnes/extension-api'
import { parsePackageBundles } from '@agnes/host-common/profile/composition'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { createLoader } from '@agnes/host-extensions/ext-host/loader'
import { CompositionSessionStore } from '@agnes/host-providers/profile/composition-state'
import { hashDirectory, preflightPackageBundles } from '@agnes/package-manager'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { expect, it, vi } from 'vitest'
import { admitSessionBundlePresets } from '../../src/runtime/profile/session-bundle-presets.js'
import { createTestHost } from '../../testkit/index.js'
import {
  packageDirs,
  pluginHost,
  pluginRow,
  pluginSource,
  scratch,
  targetOf,
  VENDOR,
} from '../assemble/plugin-extension-fixture.js'

vi.mock('@agnes/host-infrastructure/adapters/process-identity-default', () => ({
  defaultProcessIdentity: async () => ({ state: 'alive', startId: 'session-bundle-presets-test-worker' }),
}))

it('defers a deployment launch preset to admission, which requires its explicit allowed definition', () => {
  const bundles = {
    work: {
      profile: { tools: ['read'] },
      launch: { title: { en: 'Work' }, description: { en: 'Work' }, preset: 'standard' },
    },
  }
  expect(preflightPackageBundles({ packageId: 'acme/kit', bundles })).toMatchObject({
    level: 'deployment-dependent',
    reasons: ['launch-preset-definition-required:standard'],
  })
  const profile = {
    provider: { routes: [] },
    presets: { default: 'other', allowed: ['standard', 'other'] },
    bundleCatalog: parsePackageBundles('acme/kit', bundles),
    limits: {},
  } as unknown as ResolvedProfile
  const selection = { preset: bundles.work.launch.preset, bundles: ['acme/kit#work'] }
  const host = { presets: { standard: { name: 'standard' }, other: { name: 'other' } } }
  expect(admitSessionBundlePresets(profile, host, selection).preset.name).toBe('standard')
  expect(() =>
    admitSessionBundlePresets(profile, { presets: { other: host.presets.other } }, selection),
  ).toThrow('preset standard not provided')
  expect(() =>
    admitSessionBundlePresets(
      { ...profile, presets: { default: 'other', allowed: ['other'] } },
      host,
      selection,
    ),
  ).toThrow('preset standard is not in presets.allowed')
})

/** A deployment that knows two bundles but selects neither: only a session can choose them. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-session-bundles-'))
  const strict = {
    name: 'strict',
    extends: 'standard',
    providers: { 'tool-policy': { provider: 'fixture.strict' } },
  }
  const options = {
    dataDir: root,
    script: [],
    disableSessionTitle: true,
    profileInputs: {
      bundleCatalog: {
        ...parsePackageBundles('@fixture/review', {
          review: { profile: { tools: ['read'] }, presets: { strict } },
        }),
        ...parsePackageBundles('@fixture/elsewhere', {
          demo: {
            presets: {
              elsewhere: {
                ...strict,
                name: 'elsewhere',
                model: { route: { primary: { route: 'not-served-here', model: 'default' } } },
              },
            },
          },
        }),
        ...parsePackageBundles('@fixture/pair', {
          pair: {
            presets: {
              strict,
              relaxed: { name: 'relaxed', extends: 'standard' },
            },
          },
        }),
      },
      user: { name: 'local-dev', composition: {} },
    },
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)) },
    packages: {
      '@agnes/code': {
        plugins: [
          {
            declaration: {
              id: 'tool-policy:fixture-strict',
              export: 'fixtureStrict',
              default: true,
              inject: ['providers'],
              provide: [],
              runtime: 'in-process' as const,
            },
            entry: normalizePluginExport({
              inject: ['providers'],
              apply(ctx) {
                ctx.providers.registerHost(toolPolicyKind, '@agnes/host', {
                  ...defaultToolPolicy,
                  id: 'fixture.strict',
                })
              },
            }),
          },
        ],
      },
    },
  }
  return { root, options }
}

it('pins a session bundle preset and its tool policy to that session only', async () => {
  const { root, options } = fixture()
  let host: Awaited<ReturnType<typeof createTestHost>>['host'] | undefined
  try {
    host = (await createTestHost(options)).host
    // Selecting the bundle is enough: its one preset is the bundle's own choice.
    const review = await host.createSession({
      key: 'review-session',
      cwd: root,
      bundles: ['@fixture/review#review'],
    })
    expect(review.preset.name).toBe('strict')
    expect(review.preset.approval.policy).toBe('fixture.strict')
    expect(review.currentTools().resolve('read')).toBeDefined()
    expect(review.currentTools().resolve('write')).toBeUndefined()

    // The deployment itself is unchanged: an ordinary session keeps the default preset and policy,
    // and the bundle's preset stays unavailable to a session that did not select the bundle.
    const plain = await host.createSession({ key: 'plain-session', cwd: root })
    expect(plain.preset.name).toBe('standard')
    expect(plain.preset.approval.policy ?? 'default').toBe('default')
    expect(host.profile.presets.allowed).toEqual(['standard'])
    await expect(host.createSession({ key: 'borrowed', cwd: root, preset: 'strict' })).rejects.toThrow(
      'presets.allowed',
    )

    // A bundle written against a model route this deployment does not serve still brings its
    // policy; the session runs on the deployment's own routing instead of being refused.
    const elsewhere = await host.createSession({
      key: 'elsewhere-session',
      cwd: root,
      bundles: ['@fixture/elsewhere#demo'],
    })
    expect(elsewhere.preset.name).toBe('elsewhere')
    expect(elsewhere.preset.approval.policy).toBe('fixture.strict')
    expect(elsewhere.preset.model.route.primary).toBe(plain.preset.model.route.primary)
    await elsewhere.close()

    // The pin is durable, so a cold open restores the same preset without the request repeating it.
    const pinned = new CompositionSessionStore(join(root, 'profiles', 'local-dev')).read(review.key)
    expect(pinned?.tree.preset).toBe('strict')
    expect(pinned?.tree.sessionBundles).toEqual(['@fixture/review#review'])
    expect(pinned?.profile.presets.allowed).toEqual(['standard', 'strict'])
    expect(pinned?.profile.bundlePresets?.strict).toMatchObject({
      providers: { 'tool-policy': { provider: 'fixture.strict' } },
    })
    await review.close()
    await plain.close()
  } finally {
    await host?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('asks for a preset name when the bundle offers several, and refuses unknown selections', async () => {
  const { root, options } = fixture()
  let host: Awaited<ReturnType<typeof createTestHost>>['host'] | undefined
  try {
    host = (await createTestHost(options)).host
    const unnamed = await host.createSession({ key: 'unnamed', cwd: root, bundles: ['@fixture/pair#pair'] })
    expect(unnamed.preset.name).toBe('standard')
    const named = await host.createSession({
      key: 'named',
      cwd: root,
      preset: 'strict',
      bundles: ['@fixture/pair#pair'],
    })
    expect(named.preset.approval.policy).toBe('fixture.strict')

    await expect(
      host.createSession({ key: 'other', cwd: root, preset: 'absent', bundles: ['@fixture/pair#pair'] }),
    ).rejects.toMatchObject({ code: 'E_PRESET_UNSUPPORTED', detail: { reason: 'preset-not-allowed' } })
    // Not installed, disabled and untrusted bundles are all simply absent from the catalog.
    await expect(
      host.createSession({ key: 'missing', cwd: root, bundles: ['@fixture/absent#bundle'] }),
    ).rejects.toMatchObject({ code: 'E_PRESET_UNSUPPORTED', detail: { reason: 'bundle-unavailable' } })
    await unnamed.close()
    await named.close()
  } finally {
    await host?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('refuses a boot-time bundle after its package is disabled without changing retained sessions', async () => {
  const original = pluginSource("ctx.tools.register(tool('fixture_review'))")
  const bundles = { review: { presets: { review: { name: 'review', extends: 'standard' } } } }
  const file = join(original.snapshot.directory, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.agnes.bundles = bundles
  writeFileSync(file, JSON.stringify(manifest))
  const source = {
    ...original,
    snapshot: {
      ...original.snapshot,
      treeIntegrity: hashDirectory(original.snapshot.directory, { exclude: [] }),
    },
  }
  const { host, dataDir } = await pluginHost(source, {
    script: [],
    disableSessionTitle: true,
    extensionLoader: createLoader({ cacheDir: scratch(), hostRoot: process.cwd(), agnesVersion: '0.0.0' }),
    profileInputs: {
      bundleCatalog: {
        ...parsePackageBundles(VENDOR, bundles),
        ...parsePackageBundles('@agnes/ai', { builtin: {} }),
      },
    },
    runtimePluginSources: async () => [source],
  })
  try {
    expect((await host.applyRuntimeTarget(targetOf([pluginRow()]))).ok).toBe(true)
    const selected = await host.createSession({
      key: 'retained',
      cwd: dataDir,
      bundles: [`${VENDOR}#review`],
    })
    expect(selected.preset.name).toBe('review')
    expect((await host.applyRuntimeTarget(targetOf([pluginRow(undefined, undefined, true)]))).ok).toBe(true)
    const result = await host
      .createSession({ key: 'new-disabled', cwd: dataDir, bundles: [`${VENDOR}#review`] })
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(result).toMatchObject({ code: 'E_PRESET_UNSUPPORTED', detail: { reason: 'bundle-unavailable' } })
    expect(selected.preset.name).toBe('review')
    const builtin = await host.createSession({ key: 'builtin', cwd: dataDir, bundles: ['@agnes/ai#builtin'] })
    expect(builtin.preset.name).toBe('standard')
    await builtin.close()
    await selected.close()
  } finally {
    await host.close()
  }
})

it.each(['route', 'model'])(
  'cold-opens a business session after its model account %s is replaced without changing its code or policy pin',
  async (replacement) => {
    const { root, options } = fixture()
    options.profileInputs.bundleCatalog['@fixture/review#review']!.document.presets!.strict!.model = {
      route: { primary: { route: 'gw', model: 'm1' } },
    }
    const modelOptions = {
      ...options,
      provider: (profile: ResolvedProfile) =>
        new ScriptedProvider({
          scripts: [],
          models: (profile.provider.routes ?? []).flatMap((route) => route.models ?? []),
        }),
    }
    let host: Awaited<ReturnType<typeof createTestHost>>['host'] | undefined
    try {
      host = (await createTestHost(modelOptions)).host
      const session = await host.createSession({
        key: 'changed-account',
        cwd: root,
        bundles: ['@fixture/review#review'],
      })
      expect((await session.scan({ type: 'session/start', limit: 1 }))[0]?.data).toMatchObject({
        modelSettings: expect.arrayContaining([expect.objectContaining({ route: 'gw', model: 'm1' })]),
      })
      const generation = session.pluginGenerationId
      const route = host.profile.provider.routes![0]!
      const bindings = new CompositionSessionStore(join(root, 'profiles', 'local-dev'))
      const binding = bindings.read(session.key)
      await session.close()
      await host.close()
      const changedRoute = replacement === 'route' ? 'replacement' : route.route
      const changed = {
        ...route,
        route: changedRoute,
        models: route.models!.map((model) => ({
          ...model,
          id: `${model.id}-replacement`,
          route: changedRoute,
        })),
      }
      host = (
        await createTestHost({
          ...modelOptions,
          profileInputs: {
            ...options.profileInputs,
            user: { ...options.profileInputs.user, provider: { package: '@agnes/ai', routes: [changed] } },
          },
        })
      ).host
      const reopened = await host.createSession({ key: session.key, cwd: root })
      expect(reopened.pluginGenerationId).toBe(generation)
      expect(reopened.preset.model.route.primary).toBe('gw')
      expect(reopened.preset.model.id.primary).toBe('m1')
      expect(reopened.preset.approval.policy).toBe('fixture.strict')
      expect(reopened.currentTools().resolve('write')).toBeUndefined()
      expect(bindings.read(session.key)).toEqual(binding)
      // Cold recovery must not relax admission for a new session with an unavailable pinned model.
      if (replacement === 'model')
        await expect(
          host.createSession({ key: 'new-invalid-model', cwd: root, bundles: ['@fixture/review#review'] }),
        ).rejects.toMatchObject({ code: 'E_PRESET_UNRESOLVED' })
      await expect(
        reopened.setModel({ slot: 'primary', route: 'gw', model: route.models![0]!.id }),
      ).rejects.toThrow()
      await reopened.setModel({ slot: 'primary', route: changed.route, model: changed.models[0]!.id })
      expect(reopened.preset.model.route.primary).toBe(changedRoute)
      await reopened.close()
    } finally {
      await host?.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it('reviews the compiler final tree, strictly pins an agent and admits saved schedule selections against current bundle definitions', async () => {
  const original = pluginSource("ctx.tools.register(tool('fixture_review'))")
  const bundles = {
    parent: { profile: { toolPolicy: { readOnly: false } } },
    review: {
      extends: [`${VENDOR}#parent`],
      profile: { tools: ['read'] },
      presets: {
        unselected: {
          name: 'unselected',
          extends: 'standard',
          model: { route: { primary: { route: 'not-served', model: 'default' } } },
        },
        review: { name: 'review', extends: 'standard', composition: { toolPolicy: { readOnly: true } } },
      },
      launch: {
        title: { en: 'Review' },
        description: { en: 'Review' },
        preset: 'review',
        prompt: { mode: 'draft', text: { en: 'Editable' } },
      },
    },
  }
  const file = join(original.snapshot.directory, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.agnes.bundles = {
    ...bundles,
    writer: {
      extends: [`${VENDOR}#parent`],
      profile: { tools: ['write'] },
      presets: { relaxed: { name: 'relaxed', extends: 'standard' } },
      launch: { title: { en: 'Writer' }, description: { en: 'Writer' }, preset: 'relaxed' },
    },
  }
  writeFileSync(file, JSON.stringify(manifest))
  let source = {
    ...original,
    enabled: true,
    snapshot: {
      ...original.snapshot,
      treeIntegrity: hashDirectory(original.snapshot.directory, { exclude: [] }),
    },
  }
  const metadataDirectory = scratch()
  const metadataId = '@acme/launch-only'
  const metadataBundles = { work: { extends: [`${VENDOR}#review`], launch: bundles.review.launch } }
  writeFileSync(
    join(metadataDirectory, 'package.json'),
    JSON.stringify({
      name: metadataId,
      version: '1.0.0',
      dependencies: { [VENDOR]: '^2.3.4' },
      agnes: { bundles: metadataBundles },
    }),
  )
  const metadataSource = {
    ...source,
    snapshot: {
      ...source.snapshot,
      directory: metadataDirectory,
      packageId: metadataId,
      version: '1.0.0',
      snapshotId: 'metadata',
      integrity: 'metadata-integrity',
      treeIntegrity: hashDirectory(metadataDirectory, { exclude: [] }),
    },
  }
  const { host, dataDir } = await pluginHost([source, metadataSource], {
    provider: (profile) =>
      new ScriptedProvider({
        scripts: [],
        models: (profile.provider.routes ?? []).flatMap((route) => route.models ?? []),
      }),
    packageDirs: {
      ...packageDirs,
      '@agnes/ai': fileURLToPath(new URL('../../../ai', import.meta.url)),
    },
    script: [],
    disableSessionTitle: true,
    extensionLoader: createLoader({ cacheDir: scratch(), hostRoot: process.cwd(), agnesVersion: '0.0.0' }),
    profileInputs: { bundleCatalog: parsePackageBundles(VENDOR, bundles) },
    runtimePluginSources: async () => [source, metadataSource],
  })
  try {
    await host.applyRuntimeTarget(targetOf([pluginRow()]))
    const ref = `${VENDOR}#review`
    const plan = await host.resolveAgent!(ref)
    expect(plan.permission.readOnly).toBe(false)
    expect(plan.bundles).toEqual([ref])
    const writer = await host.resolveAgent!(`${VENDOR}#writer`)
    expect(writer.loop).toEqual(plan.loop)
    expect(writer.preset).toBe('relaxed')
    expect(writer.permission.tools).toEqual(['write'])
    expect(plan.permission.tools).toEqual(['read'])
    const metadataPlan = await host.resolveAgent!(`${metadataId}#work`)
    expect(metadataPlan.bundles).toEqual([`${metadataId}#work`])
    expect(metadataPlan.sources.map((item) => item.id)).toContain(metadataId)
    const metadataSession = await host.createSession({
      key: 'metadata-only',
      cwd: dataDir,
      agent: metadataPlan.ref,
      agentDigest: metadataPlan.digest,
    })
    expect(metadataSession.preset.name).toBe('review')
    await metadataSession.close()
    const session = await host.createSession({
      key: 'reviewed-agent',
      cwd: dataDir,
      agent: ref,
      agentDigest: plan.digest,
    })
    expect(session.preset.name).toBe('review')
    expect(session.preset.model.route.primary).toBe(plan.model.route)
    expect(session.preset.model.id.primary).toBe(plan.model.model)
    expect((await session.scan({ type: 'user/message', limit: 1 })).length).toBe(0)
    const saved = { bundles: plan.bundles, preset: plan.preset, loop: plan.loop }
    // Same selection, new trusted Bundle definition. Its launch is no longer read by schedules.
    manifest.agnes.bundles.review.profile = { tools: ['write'], toolPolicy: { readOnly: true } }
    writeFileSync(file, JSON.stringify(manifest))
    source = {
      ...source,
      snapshot: {
        ...source.snapshot,
        treeIntegrity: hashDirectory(original.snapshot.directory, { exclude: [] }),
        capabilityHash: 'changed',
      },
    }
    await expect(
      host.createSession({ key: 'drifted-agent', cwd: dataDir, agent: ref, agentDigest: plan.digest }),
    ).rejects.toThrow('review drift')
    delete manifest.agnes.bundles.review.launch
    writeFileSync(file, JSON.stringify(manifest))
    source = {
      ...source,
      snapshot: {
        ...source.snapshot,
        treeIntegrity: hashDirectory(original.snapshot.directory, { exclude: [] }),
      },
    }
    const scheduled = await host.createSession({ key: 'schedule-next-run', cwd: dataDir, ...saved })
    const bindings = new CompositionSessionStore(join(dataDir, 'profiles', 'local-dev'))
    expect(bindings.read(scheduled.key)?.tree.selection.tools).toEqual(['write'])
    expect(bindings.read(session.key)?.tree.selection.tools).toEqual(['read'])
    await scheduled.close()
    await session.close()
    // A strict caller cannot use ordinary admission's unserved-route fallback.
    manifest.agnes.bundles.review.launch = plan.launch
    manifest.agnes.bundles.review.presets.review.model = {
      route: { primary: { route: 'not-served', model: 'default' } },
    }
    writeFileSync(file, JSON.stringify(manifest))
    source = {
      ...source,
      snapshot: {
        ...source.snapshot,
        treeIntegrity: hashDirectory(original.snapshot.directory, { exclude: [] }),
      },
    }
    await expect(host.resolveAgent!(ref)).rejects.toMatchObject({ code: 'E_PRESET_UNRESOLVED' })
  } finally {
    await host.close()
  }
})
