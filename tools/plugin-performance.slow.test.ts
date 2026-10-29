import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { cpus, tmpdir, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { createMemoryAudit } from '@agnes/host-infrastructure/audit'
import { expect, it, vi } from 'vitest'
import { fetchSurfaceMountLookup, fetchSurfaceMountProxy } from '../packages/cli/launch/surface-mounts.js'
import { createClientModuleRegistry } from '../packages/daemon-admin/src/packages/client-modules.js'
import { assemble } from '../packages/host/src/runtime/assemble/assemble.js'
import { resolveProfile } from '../packages/host-common/src/profile/resolve.js'
import { MemoryPackageLoader } from '../packages/host-extensions/src/assemble/packages.js'
import {
  capabilityHash,
  createPackageManager,
  emptyLock,
  packageDir,
  writeLock,
} from '../packages/package-manager/src/index.js'
import { inspectStaged } from '../packages/package-manager/src/inspect.js'
import * as inventoryModule from '../packages/package-manager/src/inventory.js'
import type { RuntimePluginSnapshot } from '../packages/package-manager/src/package-plugin-loader.js'
import * as sources from '../packages/package-manager/src/sources.js'
import {
  buildRuntimeTarget,
  createPluginRow,
  encodeRuntimeTargetArtifact,
} from '../packages/plugin-runtime/src/host/index.js'
import { createWebServer } from '../packages/web-server/src/server.js'
import { createFixture } from './package-load/fixture.js'
import {
  assertBudget,
  budgets,
  dataset,
  measure,
  resourceBudget,
  type Stage,
} from './package-load/metrics.js'
import { assertTamperRefused, runPackageLoad } from './package-load/run.js'

const surfaceState = vi.hoisted(() => ({
  handlers: new Map<string, (value?: unknown) => void>(),
  port: 1111,
}))

// Exploratory case is opt-in; the package-load budget gate below always runs in the heavy tier.
// Both are serial synthetic benchmarks; no daemon, native build, private home or external provider.
// nice -n 10 pnpm exec vitest run tools/plugin-performance.slow.test.ts --maxWorkers=1
// Set AGH_PERFORMANCE_OUTPUT to a report file outside the repository to enable it.
vi.mock('../packages/sdk/src/index.node.js', async (actual) => ({
  ...(await actual<typeof import('../packages/sdk/src/index.node.js')>()),
  createClient: () => ({
    initialize: async () => {
      await delay(20)
    },
    on: (event: string, callback: (value?: unknown) => void) => {
      surfaceState.handlers.set(event, callback)
      return () => surfaceState.handlers.delete(event)
    },
    surfaces: {
      mounts: async () => ({
        mounts: [
          {
            package: '@synthetic/surface',
            surfaceId: 'load',
            mount: '/synthetic',
            host: '127.0.0.1',
            port: surfaceState.port,
          },
        ],
      }),
    },
    close: async () => {
      surfaceState.handlers.clear()
    },
  }),
}))

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

it.skipIf(!process.env.AGH_PERFORMANCE_OUTPUT)(
  'measures bounded synthetic plugin preparation and reads',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'agh-plugin-performance-'))
    const priorHome = process.env.AGH_HOME
    process.env.AGH_HOME = home
    const scan = vi.spyOn(inventoryModule, 'readInventory')
    const hash = vi.spyOn(sources, 'hashDirectory')
    const rows: Record<string, unknown>[] = []
    try {
      for (const count of [1, 10, 30]) {
        const dataDir = join(home, String(count))
        const profileDir = join(dataDir, 'profiles', 'local-dev')
        mkdirSync(profileDir, { recursive: true })
        const lock = emptyLock('local-dev', '0.1.0')
        lock.policySnapshot.capabilityCeiling = ['ui']
        lock.resolvedProfileHash = `sha256-${'0'.repeat(64)}`
        lock.seams = Object.fromEntries(
          ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map(
            (name) => [name, { provider: 'local' }],
          ),
        )
        const runtimeSources: RuntimePluginSnapshot[] = []
        for (let index = 0; index < count; index++) {
          const id = `@synthetic/plugin-${String(index).padStart(2, '0')}`
          const directory = packageDir(dataDir, 'local-dev', id)
          mkdirSync(directory, { recursive: true })
          writeFileSync(
            join(directory, 'package.json'),
            JSON.stringify({
              name: id,
              version: '1.0.0',
              license: 'MIT',
              exports: './index.mjs',
              agnes: {
                plugins: [{ export: 'main', apiRange: '^5.0.0', capabilities: { ui: true } }],
                clientDescriptors: [{ rowId: `ext:${id}/main`, path: './client/agnes.client.json' }],
              },
            }),
          )
          writeFileSync(join(directory, 'index.mjs'), 'export const main = () => {}\n')
          mkdirSync(join(directory, 'client'))
          writeFileSync(
            join(directory, 'client', 'index.js'),
            'export const main = () => {}\n'.padEnd(32 * 1024),
          )
          writeFileSync(
            join(directory, 'client', 'index.css'),
            '.synthetic { color: blue }\n'.padEnd(32 * 1024),
          )
          writeFileSync(
            join(directory, 'client', 'agnes.client.json'),
            JSON.stringify({
              client: {
                entry: './index.js',
                styles: ['./index.css'],
                services: [],
                projections: [],
              },
            }),
          )
          for (let file = 2; file < 8; file++)
            writeFileSync(join(directory, `asset-${file}.txt`), Buffer.alloc(32 * 1024, 97))
          const source = { type: 'file' as const, ref: `file:./plugin-${index}` }
          const tree = sources.hashDirectory(directory, { exclude: [] })
          const { preview } = await inspectStaged({
            dir: directory,
            source,
            ceiling: ['ui'],
            fetched: { dir: directory, version: '1.0.0', integrity: tree, license: 'MIT', dependencies: {} },
          })
          lock.packages[id] = {
            version: '1.0.0',
            source,
            integrity: tree,
            treeIntegrity: tree,
            license: 'MIT',
            trust: 'trusted',
            state: { installed: '2026-01-01T00:00:00Z', trusted: '2026-01-01T00:00:00Z', enabled: true },
            dependencies: {},
            previous: null,
            contributions: preview.contributions,
            ...(preview.declaredCapabilities ? { declaredCapabilities: preview.declaredCapabilities } : {}),
          }
          const installed = lock.packages[id]
          if (!installed) throw new Error('missing synthetic lock entry')
          installed.trustDecision = {
            integrity: tree,
            capabilityHash: capabilityHash(installed),
            decidedAt: '2026-01-01T00:00:00Z',
          }
          runtimeSources.push({
            trusted: true,
            generation: 1,
            snapshot: {
              packageId: id,
              profile: 'local-dev',
              snapshotId: tree,
              integrity: tree,
              treeIntegrity: tree,
              capabilityHash: preview.capabilityHash ?? '',
              version: '1.0.0',
              directory,
              contributions: preview.contributions,
            },
          })
        }
        writeLock(profileDir, lock)
        const manager = createPackageManager({ dataDir, agnesVersion: '0.1.0' })
        const scanMs: number[] = [],
          pageMs: number[] = [],
          scans: number[] = [],
          hashes: number[] = []
        for (let repeat = 0; repeat < 5; repeat++) {
          let start = performance.now()
          await manager.inventory(profileDir)
          scanMs.push(performance.now() - start)
          scan.mockClear()
          hash.mockClear()
          start = performance.now()
          await Promise.all(Array.from({ length: 2 * count + 1 }, () => manager.inventory(profileDir)))
          pageMs.push(performance.now() - start)
          scans.push(scan.mock.calls.length)
          hashes.push(hash.mock.calls.length)
        }
        const artifact = encodeRuntimeTargetArtifact(
          buildRuntimeTarget({
            rows: runtimeSources.flatMap(({ snapshot }) => [
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
          snapshotDirectory: () => join(dataDir, 'client-snapshots'),
          runtimeArtifacts: () => ({ desired: artifact, lastGood: artifact }),
        })
        const clientInput = async () => ({
          profile: 'local-dev',
          profileDirectory: profileDir,
          inventory: await manager.inventory(profileDir),
          actual: async (id: string) => ({
            actual: 'running' as const,
            actualIntegrity: lock.packages[id]?.integrity ?? '',
          }),
          refreshInventory: () => manager.inventory(profileDir, { fresh: true }),
        })
        const clientTimes: number[] = [],
          clientScans: number[] = [],
          clientHashes: number[] = []
        let coldClientMs = 0
        try {
          const coldStart = performance.now()
          const roster = await registry.list(await clientInput())
          coldClientMs = performance.now() - coldStart
          expect(roster.modules, JSON.stringify(roster)).toHaveLength(count)
          const paths = roster.modules.flatMap((module) => [module.entryUrl, ...module.styleUrls])
          expect(paths).toHaveLength(2 * count)
          for (let repeat = 0; repeat < 3; repeat++) {
            scan.mockClear()
            hash.mockClear()
            const start = performance.now()
            const responses = await Promise.all([
              clientInput().then((input) => registry.list(input)),
              ...paths.map(async (path) => registry.read({ ...(await clientInput()), path })),
            ])
            expect(responses.slice(1).every((response) => 'found' in response && response.found)).toBe(true)
            clientTimes.push(performance.now() - start)
            clientScans.push(scan.mock.calls.length)
            clientHashes.push(hash.mock.calls.length)
          }
        } finally {
          registry.close()
        }
        const profile = await resolveProfile(
          { builtin: 'local-dev' },
          {
            platform: { os: 'linux', arch: 'x64', capabilities: {} },
            agnesVersion: '0.1.0',
            now: '2026-01-01T00:00:00Z',
          },
        )
        const prepare: Record<string, unknown> = {}
        const prepareResources: Record<string, unknown> = {}
        for (const concurrency of [1, 2, 4]) {
          const times: number[] = [],
            cpuMs: number[] = [],
            rssMiB: number[] = [],
            lagMs: number[] = []
          let peakActive = 0
          for (let repeat = 0; repeat < 5; repeat++) {
            const lag = monitorEventLoopDelay({ resolution: 1 })
            lag.enable()
            // Arm the observer before the synchronous full-selection preflight starts.
            await delay(0)
            const cpuStart = process.cpuUsage()
            let active = 0
            let peakRss = process.memoryUsage().rss
            const start = performance.now()
            await expect(
              assemble(profile, {
                dataDir,
                profileDir,
                workspaceRoot: dataDir,
                hostRoot: process.cwd(),
                loader: new MemoryPackageLoader(
                  Object.fromEntries(profile.packages.map(({ id }) => [id, { id }])),
                ),
                audit: createMemoryAudit(),
                log: { debug() {}, info() {}, warn() {}, error() {} },
                agnesVersion: '0.1.0',
                crashAt: 'packages',
                runtimePluginSnapshots: runtimeSources,
                // These controlled modules only wait and export a function; they share no mutable state.
                runtimePrepareIndependent: runtimeSources.map(({ snapshot }) => snapshot),
                extensionLoader: {
                  import: async () => {
                    peakActive = Math.max(peakActive, ++active)
                    peakRss = Math.max(peakRss, process.memoryUsage().rss)
                    await delay(5)
                    active--
                    return { main: () => {} }
                  },
                },
                // The pre-change assembly ignores this candidate setting. After the change it selects
                // the exact same stage, integrity checks and synthetic sources at this bound.
                ...{ runtimePrepareConcurrency: concurrency },
              }),
            ).rejects.toThrow('crash:packages')
            times.push(performance.now() - start)
            lag.disable()
            const cpu = process.cpuUsage(cpuStart)
            cpuMs.push((cpu.user + cpu.system) / 1000)
            rssMiB.push(Math.max(peakRss, process.memoryUsage().rss) / 1024 / 1024)
            lagMs.push(lag.max / 1e6)
          }
          prepare[String(concurrency)] = median(times)
          prepareResources[String(concurrency)] = {
            cpuMs: median(cpuMs),
            rssMiB: median(rssMiB),
            eventLoopMaxMs: median(lagMs),
            peakActive,
            p95Ms: [...times].sort((a, b) => a - b)[4],
          }
        }
        const webMs: number[] = [],
          surfaceMs: number[] = []
        writeFileSync(
          join(dataDir, 'index.html'),
          '<html><meta content="__AGNES_CSP_NONCE__"><script>"__AGNES_WS_URL__"</script></html>',
        )
        for (let repeat = 0; repeat < 5; repeat++) {
          const reservation = createServer()
          await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
          const address = reservation.address()
          if (!address || typeof address === 'string') throw new Error('no synthetic port')
          const port = address.port
          await new Promise<void>((resolve) => reservation.close(() => resolve()))
          const start = performance.now()
          const feed = await fetchSurfaceMountProxy({
            socketPath: '/tmp/synthetic.sock',
            scope: { scopeID: 'synthetic' },
          } as never)
          const server = await createWebServer({
            root: dataDir,
            wsUrl: 'ws://127.0.0.1:1',
            port,
            mountProxy: feed.proxy,
            surfaceMountsReady: feed.ready,
          })
          webMs.push(performance.now() - start)
          while (feed.ready?.('/synthetic') === false) await delay(1)
          surfaceMs.push(performance.now() - start)
          await server.close()
          await feed.close()
        }
        rows.push({
          count,
          assetReads: 2 * count + 1,
          scans: median(scans),
          hashes: median(hashes),
          scanMs: median(scanMs),
          pageMs: median(pageMs),
          clientPage: {
            repeats: 3,
            requests: 2 * count + 1,
            ms: median(clientTimes),
            scans: median(clientScans),
            hashes: median(clientHashes),
            coldRosterMs: coldClientMs,
          },
          prepareMs: prepare,
          prepareResources,
          webMs: median(webMs),
          surfaceMs: median(surfaceMs),
        })
      }
      const output = process.env.AGH_PERFORMANCE_OUTPUT
      if (!output) throw new Error('missing benchmark output')
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(
        output,
        `${JSON.stringify({ node: process.version, repeats: 5, bytesPerPlugin: 8 * 32 * 1024, rows }, null, 2)}\n`,
      )
    } finally {
      scan.mockRestore()
      hash.mockRestore()
      if (priorHome === undefined) delete process.env.AGH_HOME
      else process.env.AGH_HOME = priorHome
      rmSync(home, { recursive: true, force: true })
    }
  },
  60_000,
)

it('gates real immutable package preparation, readonly views and Surface event latency', async () => {
  const f = await createFixture(dataset)
  const rows = []
  const feed = await fetchSurfaceMountLookup({
    socketPath: '/synthetic.sock',
    scope: { scopeID: 'package-load' },
  } as never)
  try {
    const readyDeadline = performance.now() + budgets.surfaceChanged
    while (!feed.ready()) {
      if (performance.now() > readyDeadline) throw new Error('initial Surface table did not become ready')
      await delay(1)
    }
    expect(feed.lookup('/synthetic/asset')?.port).toBe(surfaceState.port)
    for (let run = 0; run < dataset.runs; run++) {
      const loading = runPackageLoad(f, run)
      const changing = measure(async () => {
        // Deliver the hint on an event-loop turn while package IO/verification is active.
        await new Promise<void>((resolve) => setImmediate(resolve))
        const port = ++surfaceState.port
        surfaceState.handlers.get('notice')?.({ kind: 'packages_changed' })
        const deadline = performance.now() + budgets.surfaceChanged
        while (feed.lookup('/synthetic/asset')?.port !== port) {
          if (performance.now() > deadline) throw new Error('Surface event did not publish within budget')
          await delay(1)
        }
      })
      // Settle both jobs before releasing their fixture, including on a failed latency bound.
      const [prepared, changed] = await Promise.allSettled([loading, changing])
      if (prepared.status === 'rejected') throw prepared.reason
      if (changed.status === 'rejected') throw changed.reason
      const { results } = prepared.value
      rows.push({ ...results, surfaceChanged: changed.value.sample })
    }
    await assertTamperRefused(f)
    const report = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      machine: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryMiB: totalmem() / 1024 / 1024 },
      dataset,
      budgets,
      resourceBudget,
      rows,
      surfaceTransport: 'synthetic SDK mounts response; production event feed and route lookup',
    }
    console.info('package-load gate', JSON.stringify(report))
    if (process.env.AGH_PERFORMANCE_OUTPUT) {
      mkdirSync(dirname(process.env.AGH_PERFORMANCE_OUTPUT), { recursive: true })
      writeFileSync(
        `${process.env.AGH_PERFORMANCE_OUTPUT}.package-load.json`,
        `${JSON.stringify(report, null, 2)}\n`,
      )
    }
    for (const row of rows) {
      for (const stage of Object.keys(budgets) as Stage[]) {
        const sample = row[stage]
        expect(sample, `missing ${stage}`).toBeDefined()
        if (sample) assertBudget(stage, sample)
      }
    }
  } finally {
    await feed.close()
    f.close()
  }
}, 180_000)
