import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginRowSource } from '../../src/ext-host/row-extension-host.js'
import { createTestHost } from '../../testkit/index.js'

const packageDirectory = fileURLToPath(
  new URL('../../../../examples/packages/client-service-panel/v1', import.meta.url),
)
const descriptor = JSON.parse(
  readFileSync(join(packageDirectory, 'extensions/main/agnes.client.json'), 'utf8'),
) as {
  client: Record<string, unknown>
}
const packageId = '@agnes-examples/client-service-panel'
const backendRowId = 'ext:examples/client-service-panel/runtime'
const owner = pluginRowSource(backendRowId)
const snapshotId = `sha256-${'9'.repeat(64)}`
const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function source(): Readonly<RuntimePluginSnapshot> {
  return Object.freeze({
    snapshot: Object.freeze({
      snapshotId,
      profile: 'local-dev',
      packageId,
      version: '1.0.0',
      integrity: snapshotId,
      treeIntegrity: hashDirectory(packageDirectory, { exclude: [] }),
      capabilityHash: 'fixture',
      directory: packageDirectory,
      contributions: Object.freeze([
        Object.freeze({
          kind: 'client' as const,
          id: owner,
          rowId: backendRowId,
          path: './extensions/main/agnes.client.json',
          client: descriptor.client,
        }),
      ]) as unknown as RuntimePluginSnapshot['snapshot']['contributions'],
    }),
    generation: 1,
    trusted: true,
  })
}

describe('client descriptor and backend row lifecycle', () => {
  it('loads the row service without the legacy extension host and revokes it with its backend row', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agnes-dynamic-client-extension-'))
    cleanup.push(dataDir)
    const host = await createTestHost({
      dataDir,
      profileInputs: {
        user: {
          name: 'local-dev',
          policy: {
            capabilityCeiling: [
              'tools',
              'hooks',
              'slots',
              'events',
              'resources',
              'ui',
              'services',
              'network',
              'network.publicRead',
              'tools.invoke',
              'artifacts',
              'subagent',
            ],
          },
        },
      },
      runtimePluginCatalogue: [source()],
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
    const runtimeRow = createPluginRow({
      id: backendRowId,
      plugin: `${packageId}@${snapshotId}/runtime`,
      snapshotDigest: snapshotId,
      exportName: 'runtime',
      entryRevision: snapshotId,
      extrasRevision: 'none',
      mountRevision: 'host-ordinary-row:v1',
      runtime: 'in-process',
    })
    const webRow = createPluginRow({
      id: `web:${packageId}`,
      plugin: `${packageId}@${snapshotId}/client`,
      snapshotDigest: snapshotId,
      exportName: 'client',
      entryRevision: snapshotId,
      extrasRevision: 'none',
      mountRevision: 'host-web-row:v1',
      runtime: 'in-process',
    })
    const target = (rows: readonly (typeof runtimeRow)[]) =>
      buildRuntimeTarget({
        rows,
        resources: { mcp: [], skills: {} },
        resourceRevision: '0'.repeat(64),
        compositeRevision: '0'.repeat(64),
      })
    try {
      await host.host.applyRuntimeTarget(target([runtimeRow, webRow]))
      expect(host.host.extensions().some((entry) => entry.id === 'examples/client-service-panel')).toBe(false)
      const session = await host.host.createSession({ cwd: dataDir, key: 'dynamic-client-service' })
      await expect(
        host.host.callService(
          {
            sessionId: session.key,
            extension: owner,
            service: 'panel.version',
            input: {},
          },
          { kind: 'local' },
        ),
      ).resolves.toEqual({ output: { version: '1.0.0' } })
      await host.host.applyRuntimeTarget(
        target([
          { ...runtimeRow, disabled: true },
          { ...webRow, disabled: true },
        ]),
      )
      await expect(
        host.host.callService(
          { sessionId: session.key, extension: owner, service: 'panel.version', input: {} },
          { kind: 'local' },
        ),
      ).rejects.toThrow()
      await session.close()
    } finally {
      await host.host.close()
    }
  })
})
