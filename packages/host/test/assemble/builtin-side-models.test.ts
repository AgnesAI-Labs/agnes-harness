import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ecosystem } from '@agnes/base'
import type { ExtensionContext } from '@agnes/extension-api'
import type { PackageModule } from '@agnes/host-extensions/assemble/packages'
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
    let self: ExtensionContext | undefined
    let h: Awaited<ReturnType<typeof createTestHost>> | undefined
    try {
      h = await createTestHost({
        dataDir: join(root, 'home'),
        packageDirs: { '@agnes/base': representation === 'source' ? source : packaged },
        packages: {
          '@agnes/base': {
            sandboxWorkspaceProbe: undefined,
            ecosystem: {
              ...ecosystem,
              'agnes/tools-search': () => (api) => {
                self = api.ctx
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
      const models = await self.sideModels.list()
      expect(models).toContainEqual({ route: 'gw', model: 'm1', api: 'openai-completions' })
      for (const model of models) expect(Object.keys(model).sort()).toEqual(['api', 'model', 'route'])
    } finally {
      await h?.host.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
)
