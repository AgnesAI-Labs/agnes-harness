import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pluginRowSource } from '@agnes/host-extensions/ext-host/row-extension-host'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import { expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

it('keeps a pinned row query service and denies it to new sessions when disabled', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agnes-row-service-'))
  const packageDirectory = resolve(dataDir, 'panel')
  await cp(
    fileURLToPath(new URL('../../../../examples/packages/client-service-panel/v1/', import.meta.url)),
    packageDirectory,
    { recursive: true },
  )
  const entry = join(packageDirectory, 'extensions/main/index.mjs')
  await writeFile(
    entry,
    (await readFile(entry, 'utf8')).replace(
      '    ctx.services.register({',
      "    ctx.services.register({ name: 'panel.report', scope: 'profile', kind: 'query', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object' }, timeoutMs: 1000, maxResultBytes: 1024, async handler() { return { sessionless: true } } })\n    ctx.services.register({",
    ),
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
            grants: ['panel.version', 'panel.report'].map((name) => ({ extension: owner, name, range: '*' })),
          }
        },
      },
    })
    try {
      await host.applyRuntimeTarget(target(false))
      const report = { extension: owner, service: 'panel.report', input: {} }
      await expect(host.profileServices?.call(report, { kind: 'local' })).resolves.toMatchObject({
        output: { sessionless: true },
      })
      const session = await host.createSession({ cwd: dataDir, key: 'row-service' })
      await expect(host.resolveService(session.key, ['panel.version'])).resolves.toMatchObject({
        extension: owner,
        packageId,
        workspaceRoot: session.workspaceRoot,
      })
      await expect(host.resolveService(session.key, ['absent.service'])).resolves.toBeUndefined()
      await expect(
        host.callService(
          { sessionId: session.key, extension: owner, service: 'panel.version', input: {} },
          { kind: 'local' },
        ),
      ).resolves.toEqual({ output: { version: '1.0.0' } })
      await host.applyRuntimeTarget(target(true))
      await expect(host.profileServices?.call(report, { kind: 'local' })).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
      await expect(
        host.callService(
          { sessionId: session.key, extension: owner, service: 'panel.version', input: {} },
          { kind: 'local' },
        ),
      ).resolves.toEqual({ output: { version: '1.0.0' } })
      await expect(host.resolveService(session.key, ['panel.version'])).resolves.toMatchObject({
        extension: owner,
      })
      const disabled = await host.createSession({ cwd: dataDir, key: 'row-service-disabled' })
      await expect(host.resolveService(disabled.key, ['panel.version'])).resolves.toBeUndefined()
      await expect(
        host.callService(
          { sessionId: disabled.key, extension: owner, service: 'panel.version', input: {} },
          { kind: 'local' },
        ),
      ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      await disabled.close()
      await host.applyRuntimeTarget(target(false))
      await expect(host.profileServices?.call(report, { kind: 'local' })).resolves.toMatchObject({
        output: { sessionless: true },
      })
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
