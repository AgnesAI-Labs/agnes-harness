import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ecosystem } from '@agnes/base'
import type { ExtensionContext, PluginContextFacets } from '@agnes/extension-api'
import type { PackageModule } from '@agnes/host-extensions/assemble/packages'
import {
  bundledPluginSource,
  hashDirectory,
  parseSource,
  type RuntimePluginSnapshot,
} from '@agnes/package-manager'
import { expect, it, vi } from 'vitest'
import { bundledManifests } from '../../../cli/tools/bundled-manifests.mjs'
import { createTestHost } from '../../testkit/index.js'

vi.mock('@agnes/package-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agnes/package-manager')>()
  return {
    ...actual,
    HOST_CAPABILITY_GRANTS: actual.HOST_CAPABILITY_GRANTS.map((declaration) =>
      declaration.packageId === '@agnes/base'
        ? {
            ...declaration,
            extensions: { ...declaration.extensions, 'agnes/tools-search': { sideCall: true } },
          }
        : declaration,
    ),
  }
})

it.each(['source', 'embedded'] as const)(
  'threads a release-granted %s builtin declaration into its actual self catalogue',
  async (representation) => {
    const root = mkdtempSync(join(tmpdir(), 'agh-builtin-catalogue-'))
    const source = join(root, 'source')
    const extension = join(source, 'search')
    const packaged = join(root, 'packaged')
    mkdirSync(extension, { recursive: true })
    mkdirSync(packaged)
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({ name: '@agnes/base', version: '0.1.0', agnes: { extensions: ['./search'] } }),
    )
    writeFileSync(
      join(extension, 'package.json'),
      JSON.stringify({
        name: '@agnes/tools-search',
        version: '0.1.0',
        exports: './index.js',
        agnes: {
          plugins: [
            {
              id: 'ext:agnes/tools-search',
              export: 'default',
              apiRange: '^5.0.0',
              inject: ['self', 'sideCall'],
              capabilities: {},
            },
          ],
        },
      }),
    )
    writeFileSync(join(extension, 'index.js'), 'export default {}')
    let initial: Promise<unknown> | undefined
    const notices: unknown[][] = []
    let latest: Promise<unknown> | undefined
    let self: ExtensionContext | undefined
    let h: Awaited<ReturnType<typeof createTestHost>> | undefined
    try {
      h = await createTestHost({
        dataDir: join(root, 'home'),
        packageDirs: { '@agnes/base': representation === 'source' ? source : packaged },
        packages: {
          '@agnes/base': {
            ecosystem: {
              ...ecosystem,
              'agnes/tools-search': () => (api) => {
                self = api.ctx
                self.sideModels?.subscribe?.((...args) => {
                  notices.push(args)
                  latest = self!.sideModels!.list()
                })
                initial = self.sideModels?.list()
              },
            },
            ...(representation === 'embedded'
              ? {
                  embeddedExtensions: bundledManifests(source) as NonNullable<
                    PackageModule['embeddedExtensions']
                  >,
                }
              : {}),
          },
        },
      })
      expect(h.host.extensions().find((entry) => entry.id === 'agnes/tools-search')).toMatchObject({
        loaded: true,
      })
      expect(self).toBeDefined()
      if (!self?.sideModels) throw new Error('granted builtin catalogue is missing')
      expect(await initial).toContainEqual({ route: 'gw', model: 'm1', api: 'openai-completions' })
      expect(notices).toEqual([])
      await h.host.applyModelProfile(structuredClone(h.host.profile))
      await Promise.resolve()
      expect(notices).toEqual([[]])
      expect(await latest).toContainEqual({ route: 'gw', model: 'm1', api: 'openai-completions' })
      const models = await self.sideModels.list()
      expect(models).toContainEqual({ route: 'gw', model: 'm1', api: 'openai-completions' })
      for (const model of models) expect(Object.keys(model).sort()).toEqual(['api', 'model', 'route'])
    } finally {
      await h?.host.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it('notifies an installed row that applied before provider readiness and closes its old self', async () => {
  const release = bundledPluginSource('file:./bundled-plugins/judgment')!
  const directory = join(release.root, release.path)
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const digest = hashDirectory(directory)
  const source: RuntimePluginSnapshot = {
    snapshot: {
      packageId: manifest.name,
      version: manifest.version,
      profile: 'local-dev',
      source: parseSource('file:./bundled-plugins/judgment'),
      snapshotId: digest,
      integrity: digest,
      treeIntegrity: digest,
      capabilityHash: 'fixture',
      directory,
      contributions: [],
    },
    generation: 1,
    trusted: true,
    enabled: true,
  }
  const root = mkdtempSync(join(tmpdir(), 'agh-installed-catalogue-'))
  let self: ExtensionContext | undefined
  let port: ExtensionContext['sideModels']
  let initial: Promise<unknown> | undefined
  const notices: unknown[][] = []
  let latest: Promise<unknown> | undefined
  const lockPackages = Object.fromEntries(
    ['@agnes/base', '@agnes/code', '@agnes/ai'].map((id) => [
      id,
      {
        version: '0.1.0',
        source: { type: 'builtin' as const, ref: 'builtin' },
        integrity: 'builtin:0.1.0',
        trust: 'builtin' as const,
        enabled: true,
      },
    ]),
  )
  let h: Awaited<ReturnType<typeof createTestHost>> | undefined
  try {
    h = await createTestHost({
      dataDir: root,
      packageDirs: {
        '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)),
        '@agnes/code': fileURLToPath(new URL('../../../code', import.meta.url)),
        [manifest.name]: directory,
      },
      lock: {
        packages: {
          ...lockPackages,
          [manifest.name]: {
            version: manifest.version,
            source: source.snapshot.source!,
            integrity: digest,
            trust: 'trusted',
            enabled: true,
          },
        },
      },
      profileInputs: {
        user: {
          name: 'local-dev',
          packages: [{ id: manifest.name, source: 'file:./bundled-plugins/judgment' }],
          composition: { plugins: { 'ext:agnes.judgment/main': { enabled: true } } },
        },
      },
      runtimePluginSnapshots: [source],
      runtimePluginCatalogue: [source],
      extensionLoader: {
        import: async () => ({
          judgmentPlugin: {
            inject: ['hooks', 'projections', 'eventLog', 'sideCall', 'self'],
            apply(plugin: PluginContextFacets) {
              self = plugin.self
              port = self.sideModels
              self.sideModels?.subscribe?.((...args) => {
                notices.push(args)
                latest = self!.sideModels!.list()
              })
              initial = self.sideModels?.list()
            },
          },
        }),
      },
    })
    expect(self?.sideModels).toBeDefined()
    expect(await initial).toEqual([])
    expect(notices).toEqual([[]])
    expect(await latest).toContainEqual({ route: 'gw', model: 'm1', api: 'openai-completions' })
    await h.host.close()
    await expect(port!.list()).rejects.toThrow(/closed|expired/)
    expect(notices).toEqual([[]])
  } finally {
    await h?.host.close()
    rmSync(root, { recursive: true, force: true })
  }
})
