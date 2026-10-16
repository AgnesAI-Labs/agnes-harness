import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as processIdentity from '@agnes/host-infrastructure/adapters/process-identity-default'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import { afterEach, expect, it, vi } from 'vitest'
import { createTestHost } from '../../testkit/index.js'
import { packageDirs, scratch } from './plugin-extension-fixture.js'

afterEach(() => vi.restoreAllMocks())

it.each(['settled', 'unknown'] as const)('restarts resources after %s shutdown', async (shutdown) => {
  // The unknown row simulates the previous worker exiting; the clean row retains the disposal-order gate.
  let startId = 'worker-one'
  vi.spyOn(processIdentity, 'defaultProcessIdentity').mockImplementation(async () => ({
    state: 'alive',
    startId,
  }))
  const directory = scratch()
  const dataDir = scratch()
  const packageId = '@sample/managed'
  const snapshotId = `sha256-${'1'.repeat(64)}`
  const inject = ['profileRuntime', 'services']
  const descriptor = (id: string) => ({
    id,
    scope: 'profile',
    artifact: { kind: 'in-process' },
    apiVersion: '1.0.0',
    healthPath: '/health',
    listeners: [],
    requires: [],
    startupTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
  })
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: packageId,
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
      agnes: {
        plugins: [
          {
            id: 'ext:sample/managed',
            export: 'plugin',
            apiRange: '^4.0.0',
            inject,
            capabilities: { store: true, managedServices: ['hub', 'example'].map(descriptor) },
          },
        ],
      },
    }),
  )
  writeFileSync(
    join(directory, 'index.js'),
    `
    export const plugin = {
      inject: ['profileRuntime', 'services'],
      apply(ctx) {
        let disposed = false
        for (const id of ['hub', 'example']) ctx.profileRuntime.register({
          id, configSchema: { type: 'object', properties: {}, additionalProperties: false }, defaultConfig: {},
          async start(init) {
            init.onShutdown(async () => {
              await Promise.resolve()
              init.store.set('shutdown-before-dispose', !disposed)
              return { state: disposed ? 'unknown' : '${shutdown}' }
            })
            init.ready()
            return id
          },
        })
        return () => { disposed = true }
      },
    }
  `,
  )
  const source: RuntimePluginSnapshot = {
    snapshot: {
      snapshotId,
      profile: 'local-dev',
      packageId,
      version: '1.0.0',
      integrity: `sha256-${'2'.repeat(64)}`,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'capability',
      directory,
      contributions: [],
    },
    generation: 1,
    trusted: true,
  }
  const row = createPluginRow({
    id: 'ext:sample/managed',
    plugin: `${packageId}@${snapshotId}/plugin`,
    snapshotDigest: source.snapshot.integrity,
    exportName: 'plugin',
    entryRevision: snapshotId,
    extrasRevision: 'none',
    mountRevision: 'host-ordinary-row:v1',
    inject,
  })
  const target = buildRuntimeTarget({
    rows: [row],
    resources: { mcp: [], skills: {} },
    resourceRevision: '0'.repeat(64),
    compositeRevision: '0'.repeat(64),
  })
  const open = () =>
    createTestHost({
      dataDir,
      packageDirs,
      runtimePluginCatalogue: [source],
      extensionLoader: { import: async (file) => import(pathToFileURL(file).href) },
    })
  for (let restart = 0; restart < 2; restart++) {
    const { host } = await open()
    try {
      await host.applyRuntimeTarget(target)
      const managed = host.profileServices?.managed
      await expect
        .poll(() => managed?.statuses(packageId))
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 'hub', state: 'ready' }),
            expect.objectContaining({ id: 'example', state: 'ready' }),
          ]),
        )
    } finally {
      await host.close()
      if (shutdown === 'unknown') startId = 'worker-two'
    }
  }
})
