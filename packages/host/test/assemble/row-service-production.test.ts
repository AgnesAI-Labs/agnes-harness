import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import { expect, it } from 'vitest'
import { pluginRowSource } from '../../src/ext-host/row-extension-host.js'
import { createTestHost } from '../../testkit/index.js'

it('loads a third-party row query service and removes it when the row is disabled', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agnes-row-service-'))
  const packageDirectory = resolve(dataDir, 'panel')
  await cp(
    fileURLToPath(new URL('../../../../examples/packages/client-service-panel/v1/', import.meta.url)),
    packageDirectory,
    { recursive: true },
  )
  const packageId = '@agnes-examples/client-service-panel'
  const rowId = 'ext:examples/client-service-panel/runtime'
  const snapshotId = `sha256-${'8'.repeat(64)}`
  const source: RuntimePluginSnapshot = {
    snapshot: {
      snapshotId,
      profile: 'local-dev',
      packageId,
      version: '1.0.0',
      integrity: snapshotId,
      treeIntegrity: hashDirectory(packageDirectory, { exclude: [] }),
      capabilityHash: 'fixture',
      directory: packageDirectory,
      contributions: [],
    },
    generation: 1,
    trusted: true,
  }
  const owner = pluginRowSource(rowId)
  const row = createPluginRow({
    id: rowId,
    plugin: `${packageId}@${snapshotId}/runtime`,
    snapshotDigest: snapshotId,
    exportName: 'runtime',
    entryRevision: snapshotId,
    extrasRevision: 'none',
    mountRevision: 'host-ordinary-row:v1',
    runtime: 'in-process',
  })
  const target = (disabled: boolean) =>
    buildRuntimeTarget({
      rows: [{ ...row, disabled }],
      resources: { mcp: [], skills: {} },
      resourceRevision: '0'.repeat(64),
      compositeRevision: '0'.repeat(64),
    })
  try {
    const { host } = await createTestHost({
      dataDir,
      runtimePluginCatalogue: [source],
      extensionLoader: {
        import: async (file) => (await import(pathToFileURL(file).href)) as Record<string, unknown>,
      },
      serviceAuthority: {
        async resolve() {
          return {
            source: 'client-web',
            subjectCredential: { kind: 'local' },
            grants: [{ extension: owner, name: 'panel.version', range: '*' }],
          }
        },
      },
    })
    try {
      await host.applyRuntimeTarget(target(false))
      const session = await host.createSession({ cwd: dataDir, key: 'row-service' })
      await expect(
        host.callService(
          { sessionId: session.key, extension: owner, service: 'panel.version', input: {} },
          { kind: 'local' },
        ),
      ).resolves.toEqual({ output: { version: '1.0.0' } })
      await host.applyRuntimeTarget(target(true))
      await expect(
        host.callService(
          { sessionId: session.key, extension: owner, service: 'panel.version', input: {} },
          { kind: 'local' },
        ),
      ).rejects.toThrow()
      await host.applyRuntimeTarget(target(false))
      await expect(
        host.callService(
          { sessionId: session.key, extension: owner, service: 'panel.version', input: {} },
          { kind: 'local' },
        ),
      ).resolves.toEqual({ output: { version: '1.0.0' } })
      await session.close()
    } finally {
      await host.close()
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
