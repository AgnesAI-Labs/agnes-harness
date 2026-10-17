import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pluginRowSource } from '@agnes/host-extensions/ext-host/row-extension-host'
import * as processIdentity from '@agnes/host-infrastructure/adapters/process-identity-default'
import {
  capabilityHash,
  createPackageManager,
  emptyLock,
  hashDirectory,
  parseSource,
  type RuntimePluginSnapshot,
  readLock,
  writeLock,
} from '@agnes/package-manager'
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

it('upgrades the pre-stream-normalization snapshot, reviews current code, reconciles its legacy marker and resolves services', async () => {
  const directory = scratch(),
    dataDir = scratch(),
    profileDir = join(dataDir, 'profiles/local-dev')
  mkdirSync(profileDir, { recursive: true })
  const packageId = '@sample/upgrade',
    rowId = 'ext:sample/upgrade',
    owner = pluginRowSource(rowId)
  const descriptor = {
    id: 'server',
    scope: 'profile',
    artifact: { kind: 'in-process' },
    apiVersion: '1.0.0',
    healthPath: '/health',
    listeners: [],
    requires: [],
    startupTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
  }
  const writePackage = (version: string, legacy: boolean) => {
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: packageId,
        version,
        license: 'MIT',
        type: 'module',
        exports: './index.js',
        agnes: {
          plugins: [
            {
              id: rowId,
              export: 'plugin',
              runtime: 'in-process',
              apiRange: '^4.0.0',
              inject: ['profileRuntime', 'services'],
              capabilities: {
                store: true,
                ui: true,
                streams: [
                  {
                    name: 'server.events',
                    scope: 'profile',
                    lane: 'events',
                    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                    directions: ['outbound'],
                    maxFrameBytes: 1024,
                    maxBufferedBytes: 2048,
                    maxBytesPerSecond: 4096,
                  },
                ],
                managedServices: [descriptor],
              },
            },
          ],
          clientDescriptors: [{ rowId, path: './agnes.client.json' }],
        },
      }),
    )
    writeFileSync(
      join(directory, 'agnes.client.json'),
      JSON.stringify({ client: { entry: './client.js', lifetime: 'profile', streams: ['server.events'] } }),
    )
    writeFileSync(join(directory, 'client.js'), 'export {}')
    writeFileSync(
      join(directory, 'index.js'),
      `export const plugin = { inject: ['profileRuntime', 'services'], apply(ctx) {
      ctx.profileRuntime.register({ id: 'server', configSchema: { type: 'object', properties: {}, additionalProperties: false }, defaultConfig: {}, async start(init) {
        init.onShutdown(async () => { ${legacy ? "init.store.delete('managed-process:server');" : ''} return { state: '${legacy ? 'unknown' : 'settled'}' } })
        init.ready(); return '${version}'
      } })
    } }`,
    )
  }
  writePackage('1.0.0', true)
  const lock = emptyLock('local-dev', '0.1.0')
  lock.resolvedProfileHash = `sha256-${'0'.repeat(64)}`
  lock.seams = Object.fromEntries(
    ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
      name,
      { provider: 'local' },
    ]),
  )
  lock.policySnapshot.capabilityCeiling = ['store', 'ui', 'streams', 'managedServices']
  writeLock(profileDir, lock)
  const manager = createPackageManager({
    dataDir,
    cwd: dataDir,
    agnesVersion: '0.1.0',
    references: async () => [],
  })
  const source = parseSource(`file:${directory.split(sep).join('/')}`)
  const oldPreview = await manager.inspect(profileDir, source)
  expect(oldPreview.blockers).toEqual([])
  await manager.install(profileDir, source, { expectedIntegrity: oldPreview.integrity })
  // Exact old normalizer output: the source declares streams, the sealed client grant omits them.
  const previous = readLock(profileDir, { profile: 'local-dev', agnesVersion: '0.1.0' })
  const entry = previous.packages[packageId]
  assert(entry?.contributions)
  entry.contributions = entry.contributions.map((row) => {
    if (!('client' in row) || !row.client) return row
    const { streams: _streams, ...client } = row.client
    return { ...row, client }
  })
  writeLock(profileDir, previous)
  const oldHash = capabilityHash(entry)
  await manager.trust(profileDir, packageId, { integrity: entry.integrity, capabilityHash: oldHash })
  await manager.enable(profileDir, packageId, true)
  const sources = async (): Promise<readonly RuntimePluginSnapshot[]> => {
    const installed = (await manager.inventory(profileDir)).packages.find((row) => row.id === packageId)
    assert(installed?.entry.treeIntegrity)
    const pin = await manager.pinRuntimeSnapshot(profileDir, {
      pinId: `upgrade-${installed.entry.integrity}`,
      operationId: `activate-${installed.entry.integrity}`,
      packageId,
      purpose: 'active',
      selector: {
        kind: 'installed',
        expectedIntegrity: installed.entry.integrity,
        expectedTreeIntegrity: installed.entry.treeIntegrity,
      },
    })
    return [{ snapshot: pin.snapshot, generation: 1, trusted: installed.trusted }]
  }
  const target = async () => {
    const selected = (await sources())[0]
    assert(selected)
    return buildRuntimeTarget({
      rows: [
        createPluginRow({
          id: rowId,
          plugin: `${packageId}@${selected.snapshot.snapshotId}/plugin`,
          snapshotDigest: selected.snapshot.integrity,
          exportName: 'plugin',
          entryRevision: selected.snapshot.snapshotId,
          extrasRevision: 'none',
          mountRevision: 'host-ordinary-row:v1',
          inject: ['profileRuntime', 'services'],
        }),
      ],
      resources: { mcp: [], skills: {} },
      resourceRevision: '0'.repeat(64),
      compositeRevision: '0'.repeat(64),
    })
  }
  const open = () =>
    createTestHost({
      dataDir,
      packageDirs,
      runtimePluginSources: sources,
      extensionLoader: { import: async (file) => import(pathToFileURL(file).href) },
      serviceAuthority: {
        resolve: async () => ({
          source: 'client-web',
          subjectCredential: { kind: 'local' },
          grants: ['server.status', 'server.reconcile'].map((name) => ({
            extension: owner,
            name,
            range: '*',
          })),
        }),
      },
    })
  const status = { extension: owner, service: 'server.status', input: {} }
  const first = (await open()).host
  try {
    await first.applyRuntimeTarget(await target())
    await expect
      .poll(() => first.profileServices?.call(status, { kind: 'local' }))
      .toMatchObject({
        output: { state: 'ready' },
      })
  } finally {
    await first.close()
  }
  const host = (await open()).host
  try {
    await host.applyRuntimeTarget(await target())
    await expect
      .poll(() => host.profileServices?.call(status, { kind: 'local' }))
      .toMatchObject({
        output: { state: 'failed', code: 'shutdown-unconfirmed' },
      })
    const before = (await manager.inventory(profileDir)).packages[0]
    assert(before)
    expect(before.capabilityHash).toBe(oldHash)
    writePackage('1.1.0', false)
    const review = await manager.inspect(profileDir, source)
    assert(review.capabilityHash)
    expect(review.capabilityHash).not.toBe(oldHash)
    await manager.update(profileDir, packageId, source, {
      expectedIntegrity: review.integrity,
      expectedInstalledIntegrity: before.entry.integrity,
      activation: {
        expectedInstalledIntegrity: before.entry.integrity,
        trust: { integrity: review.integrity, capabilityHash: review.capabilityHash },
      },
    })
    await host.applyRuntimeTarget(await target())
    const runtime = host.profileServices
    assert(runtime)
    const call = {
      extension: owner,
      service: 'server.reconcile',
      input: {},
      operationId: 'reviewed-recovery',
    }
    expect(await runtime.call(call, { kind: 'local' })).toMatchObject({ state: 'approval-required' })
    const [decision] = await runtime.listDecisions({ kind: 'local' })
    assert(decision)
    expect(decision.request.spec.subject).toMatchObject({ presentation: { identityState: 'unknown' } })
    await runtime.answerDecision(
      {
        handle: decision.handle,
        revision: decision.revision,
        commandId: 'approve-recovery',
        response: { option: 'allowed-once', value: null },
      },
      { kind: 'local' },
    )
    expect(await runtime.call(call, { kind: 'local' })).toMatchObject({ state: 'completed' })
    await expect(runtime.call(status, { kind: 'local' })).resolves.toMatchObject({
      output: { state: 'ready' },
    })
    const installed = (await manager.inventory(profileDir)).packages[0]
    assert(installed?.directory)
    writeFileSync(join(installed.directory, 'client.js'), 'tampered')
    await expect(manager.inventory(profileDir, { fresh: true })).rejects.toThrow('tree differs')
  } finally {
    await host.close()
  }
})
