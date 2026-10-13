import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultToolPolicy, toolPolicyKind } from '@agnes/extension-api'
import { parsePackageBundles } from '@agnes/host-common/profile/composition'
import { CompositionSessionStore } from '@agnes/host-providers/profile/composition-state'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { expect, it, vi } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

vi.mock('@agnes/host-infrastructure/adapters/process-identity-default', () => ({
  defaultProcessIdentity: async () => ({ state: 'alive', startId: 'session-bundle-presets-test-worker' }),
}))

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
