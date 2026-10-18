import { cp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import { expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'
import { packageDirs, scratch } from './plugin-extension-fixture.js'

it('activates the actual browser backend with no viewer and without launching a browser', async () => {
  const directory = scratch()
  const sourceDirectory = fileURLToPath(
    new URL('../../../package-manager/bundled-plugins/browser-runtime', import.meta.url),
  )
  for (const name of ['package.json', 'index.mjs', 'src'])
    await cp(join(sourceDirectory, name), join(directory, name), { recursive: true })
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const entry = manifest.agnes.plugins[0]
  const snapshotId = `sha256-${'b'.repeat(64)}`
  const source: RuntimePluginSnapshot = {
    snapshot: {
      snapshotId,
      profile: 'local-dev',
      packageId: manifest.name,
      version: manifest.version,
      integrity: `sha256-${'c'.repeat(64)}`,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'browser-test',
      directory,
      contributions: [],
    },
    generation: 1,
    trusted: true,
  }
  const row = createPluginRow({
    id: entry.id,
    plugin: `${manifest.name}@${snapshotId}/${entry.export}`,
    snapshotDigest: source.snapshot.integrity,
    exportName: entry.export,
    entryRevision: snapshotId,
    extrasRevision: 'none',
    mountRevision: 'host-ordinary-row:v1',
    inject: entry.inject,
  })
  const { host } = await createTestHost({
    dataDir: scratch(),
    packageDirs,
    runtimePluginCatalogue: [source],
    extensionLoader: { import: async (file) => import(pathToFileURL(file).href) },
  })
  try {
    await host.applyRuntimeTarget(
      buildRuntimeTarget({
        rows: [row],
        resources: { mcp: [], skills: {} },
        resourceRevision: '0'.repeat(64),
        compositeRevision: '0'.repeat(64),
      }),
    )
    await expect
      .poll(() => host.profileServices?.managed?.statuses(manifest.name))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'browser', state: 'ready' })]))
  } finally {
    await host.close()
  }
})
