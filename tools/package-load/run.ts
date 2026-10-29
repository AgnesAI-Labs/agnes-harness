import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClientModuleRegistry } from '../../packages/daemon-admin/src/packages/client-modules.js'
import { assemble } from '../../packages/host/src/runtime/assemble/assemble.js'
import { resolveProfile } from '../../packages/host-common/src/profile/resolve.js'
import {
  loadRuntimePackage,
  MemoryPackageLoader,
} from '../../packages/host-extensions/src/assemble/packages.js'
import { createLoader } from '../../packages/host-extensions/src/ext-host/loader.js'
import { createMemoryAudit } from '../../packages/host-infrastructure/src/audit.js'
import { packageDir } from '../../packages/package-manager/src/index.js'
import {
  buildRuntimeTarget,
  createPluginRow,
  encodeRuntimeTargetArtifact,
} from '../../packages/plugin-runtime/src/host/index.js'
import type { createFixture } from './fixture.js'
import { measure, type Sample, type Stage } from './metrics.js'

export type Results = Partial<Record<Stage, Sample>>

/** Cold means new manager/loader + empty jiti disk cache, not a flushed OS filesystem cache. */
export async function runPackageLoad(f: Awaited<ReturnType<typeof createFixture>>, run: number) {
  const results: Results = {}
  const inventoryReader = f.reader()
  const cold = await measure(() => inventoryReader.inventory(f.profileDir))
  results.inventoryCold = cold.sample
  const warm = await measure(() => inventoryReader.inventory(f.profileDir))
  results.inventoryWarm = warm.sample
  assert.deepEqual(warm.value, cold.value)
  assert(Object.isFrozen(warm.value.packages))
  const snapshotReader = f.reader()
  const snapshots = await measure(() => snapshotReader.runtimePluginSnapshots(f.profileDir))
  results.snapshotsCold = snapshots.sample
  const again = await measure(() => snapshotReader.runtimePluginSnapshots(f.profileDir))
  results.snapshotsWarm = again.sample
  assert.deepEqual(again.value, snapshots.value)
  assert.equal(snapshots.value.length, cold.value.packages.length)
  assert(snapshots.value.length > 0)
  for (const source of snapshots.value) {
    assert(source.trusted)
    assert.notEqual(source.snapshot.directory, packageDir(f.home, 'local-dev', source.snapshot.packageId))
  }

  const cacheDir = join(f.home, `loader-cache-${run}`)
  const profile = await resolveProfile(
    { builtin: 'local-dev' },
    {
      platform: { os: 'linux', arch: 'x64', capabilities: {} },
      agnesVersion: '0.1.0',
      now: '2026-01-01T00:00:00Z',
    },
  )
  for (const stage of ['prepareCold', 'prepareWarm'] as const) {
    // New importer each pass: warm disk cache may not bypass immutable-tree verification.
    const loader = createLoader({ cacheDir, hostRoot: process.cwd(), agnesVersion: '0.1.0' })
    const loaded = await measure(async () => {
      // Production package selection/preflight/import path; stop before provider/native startup.
      await assert.rejects(
        () =>
          assemble(profile, {
            dataDir: f.home,
            profileDir: f.profileDir,
            workspaceRoot: f.home,
            hostRoot: process.cwd(),
            loader: new MemoryPackageLoader(
              Object.fromEntries(profile.packages.map(({ id }) => [id, { id }])),
            ),
            audit: createMemoryAudit(),
            log: { debug() {}, info() {}, warn() {}, error() {} },
            agnesVersion: '0.1.0',
            crashAt: 'packages',
            runtimePluginSnapshots: snapshots.value,
            extensionLoader: loader,
          }),
        /crash:packages/,
      )
    })
    results[stage] = loaded.sample
  }

  const artifact = encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: snapshots.value.flatMap(({ snapshot }) => [
        createPluginRow({
          id: `ext:${snapshot.packageId}/main`,
          plugin: `${snapshot.packageId}@${snapshot.integrity}/main`,
          snapshotDigest: snapshot.integrity,
          exportName: 'main',
          entryRevision: snapshot.integrity,
          extrasRevision: 'none',
          mountRevision: 'host-ordinary-row:v1',
          runtime: 'in-process',
        }),
        createPluginRow({
          id: `web:${snapshot.packageId}`,
          plugin: `${snapshot.packageId}@${snapshot.integrity}/client`,
          snapshotDigest: snapshot.integrity,
          exportName: 'client',
          entryRevision: snapshot.integrity,
          extrasRevision: 'none',
          mountRevision: 'host-web-row:v1',
          runtime: 'in-process',
        }),
      ]),
      resources: { mcp: [], skills: {} },
      resourceRevision: '0'.repeat(64),
      compositeRevision: '0'.repeat(64),
    }),
  )
  const registry = createClientModuleRegistry({
    snapshotDirectory: () => join(f.home, `client-cache-${run}`),
    runtimeArtifacts: () => ({ desired: artifact, lastGood: artifact }),
  })
  const input = async () => ({
    profile: 'local-dev',
    profileDirectory: f.profileDir,
    inventory: await inventoryReader.inventory(f.profileDir),
    actual: async (id: string) => ({
      actual: 'running' as const,
      actualIntegrity: cold.value.packages.find((pkg) => pkg.id === id)?.entry.integrity ?? '',
    }),
    refreshInventory: () => inventoryReader.inventory(f.profileDir, { fresh: true }),
  })
  try {
    for (const stage of ['readonlyCold', 'readonlyWarm'] as const) {
      const page = await measure(async () => {
        const roster = await registry.list(await input())
        assert.equal(roster.modules.length, snapshots.value.length)
        const paths = roster.modules.flatMap((module) => [module.entryUrl, ...module.styleUrls])
        assert.equal(paths.length, 2 * snapshots.value.length)
        // A page requests assets together, exercising the production in-flight inventory sharing.
        await Promise.all(
          paths.map(async (path) => {
            const asset = await registry.read({ ...(await input()), path })
            assert(asset.found)
          }),
        )
      })
      results[stage] = page.sample
    }
  } finally {
    registry.close()
  }
  return { results, snapshots: snapshots.value }
}

/** Warm readers and import caches must still refuse changed install/snapshot bytes. */
export async function assertTamperRefused(f: Awaited<ReturnType<typeof createFixture>>) {
  const manager = f.reader()
  const inventory = await manager.inventory(f.profileDir)
  const [source] = await manager.runtimePluginSnapshots(f.profileDir)
  const installed = inventory.packages[0]
  assert(source && installed?.directory)
  const loader = createLoader({
    cacheDir: join(f.home, 'tamper-cache'),
    hostRoot: process.cwd(),
    agnesVersion: '0.1.0',
  })
  assert(await loadRuntimePackage(source, loader))
  writeFileSync(join(source.snapshot.directory, 'index.mjs'), 'export const main = () => { throw 1 }\n')
  await assert.rejects(() => loadRuntimePackage(source, loader), { code: 'E_PACKAGE_INTEGRITY' })
  writeFileSync(join(installed.directory, 'index.mjs'), 'changed bytes')
  await assert.rejects(() => manager.inventory(f.profileDir), { code: 'E_PACKAGE_INTEGRITY' })
  await assert.rejects(() => manager.inventory(f.profileDir, { fresh: true }), {
    code: 'E_PACKAGE_INTEGRITY',
  })
}
