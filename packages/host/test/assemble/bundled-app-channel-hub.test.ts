import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHANNEL_CONFIG_SCHEMA, managedServiceCapabilities } from '@agnes/extension-api'
import { createLoader } from '@agnes/host-extensions/ext-host/loader'
import type { ChannelRuntimeFactory } from '@agnes/host-extensions/profile/channel-runtime'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import { expect, it, vi } from 'vitest'
import { createTestHost } from '../../testkit/index.js'
import { scratch } from './plugin-extension-fixture.js'

/** A channel package row whose channel runtime records the context the assembly hands it. */
async function channelHost(withBundledApp: boolean) {
  const directory = scratch(),
    dataDir = scratch(),
    packageId = '@sample/channel',
    snapshotId = `sha256-${'d'.repeat(64)}`,
    rowId = 'ext:sample/channel'
  const manifest = JSON.parse(
    readFileSync(
      new URL('../../../channels/testkit/fixtures/example-im.channel.json', import.meta.url),
      'utf8',
    ),
  )
  const inject = ['profileRuntime', 'services', 'providers']
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
            id: rowId,
            export: 'main',
            apiRange: '^5.5.0',
            inject,
            capabilities: {
              store: true,
              network: ['*'],
              services: managedServiceCapabilities('channel', CHANNEL_CONFIG_SCHEMA),
              managedServices: [
                {
                  id: 'channel',
                  scope: 'profile',
                  artifact: { kind: 'in-process' },
                  listeners: [],
                  requires: [],
                  healthPath: '/health',
                  apiVersion: '1.0.0',
                  startupTimeoutMs: 1000,
                  shutdownTimeoutMs: 1000,
                },
              ],
            },
          },
        ],
      },
    }),
  )
  writeFileSync(
    join(directory, 'index.js'),
    `export const main = { inject: ${JSON.stringify(inject)},
    apply(ctx) { ctx.profileRuntime.registerChannel({ id: ${JSON.stringify(manifest.id)},
      version: '1.0.0', manifest: ${JSON.stringify(manifest)}, create() { throw Error('unused') } }) }
  }`,
  )
  const source: RuntimePluginSnapshot = {
    snapshot: {
      snapshotId,
      profile: 'local-dev',
      packageId,
      version: '1.0.0',
      integrity: snapshotId,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'fixture',
      directory,
      contributions: [],
    },
    generation: 1,
    trusted: true,
  }
  const row = createPluginRow({
    id: rowId,
    plugin: `${packageId}@${snapshotId}/main`,
    snapshotDigest: snapshotId,
    exportName: 'main',
    entryRevision: snapshotId,
    extrasRevision: 'none',
    mountRevision: 'host-ordinary-row:v1',
    inject,
    runtime: 'in-process',
  })
  const contexts: Parameters<ChannelRuntimeFactory>[2][] = []
  const channelRuntime: ChannelRuntimeFactory = async (provider, init, context) => {
    contexts.push(context)
    init.onShutdown(async () => ({ state: 'settled' }))
    init.ready()
    return { status: () => ({ provider: provider.id, instances: [] }) }
  }
  const { host } = await createTestHost({
    dataDir,
    runtimePluginCatalogue: [source],
    extensionLoader: createLoader({
      cacheDir: join(dataDir, 'cache'),
      hostRoot: directory,
      agnesVersion: '0.0.0',
    }),
    channelRuntime,
    ...(withBundledApp ? { bundledAppClient: () => ({ client: {}, close: async () => undefined }) } : {}),
  })
  await host.applyRuntimeTarget(
    buildRuntimeTarget({
      rows: [{ ...row, disabled: false, config: {} as never }],
      resources: { mcp: [], skills: {} },
      resourceRevision: '0'.repeat(64),
      compositeRevision: '0'.repeat(64),
    }),
  )
  await vi.waitFor(() => expect(contexts).toHaveLength(1))
  return { host, context: contexts[0]! }
}

it('hands channel rows the bundled-app hub only where the backend supplies a bundled-app client', async () => {
  const granted = await channelHost(true)
  try {
    const bridge = granted.context.subscriptions
    expect(bridge, 'the assembly created one hub for its channel rows and bundled-app grants').toBeDefined()
    expect(bridge?.claimed('one', 'group-a')).toBe(false)
  } finally {
    await granted.host.close()
  }
  const plain = await channelHost(false)
  try {
    expect(plain.context.subscriptions).toBeUndefined()
  } finally {
    await plain.host.close()
  }
})
