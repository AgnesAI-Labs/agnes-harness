import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { createMemoryAudit } from '@agnes/host-infrastructure/audit'
import { expect, it, vi } from 'vitest'
import { fetchSurfaceMountProxy } from '../packages/cli/launch/surface-mounts.js'
import { assemble } from '../packages/host/src/runtime/assemble/assemble.js'
import { resolveProfile } from '../packages/host-common/src/profile/resolve.js'
import { MemoryPackageLoader } from '../packages/host-extensions/src/assemble/packages.js'
import {
  createPackageManager,
  emptyLock,
  packageDir,
  writeLock,
} from '../packages/package-manager/src/index.js'
import { inspectStaged } from '../packages/package-manager/src/inspect.js'
import * as inventoryModule from '../packages/package-manager/src/inventory.js'
import type { RuntimePluginSnapshot } from '../packages/package-manager/src/package-plugin-loader.js'
import * as sources from '../packages/package-manager/src/sources.js'
import { createWebServer } from '../packages/web-server/src/server.js'

// Opt-in, serial synthetic benchmark; no daemon, native build, private home or external provider.
// nice -n 10 pnpm exec vitest run tools/plugin-performance.slow.test.ts --maxWorkers=1
// Set AGH_PERFORMANCE_OUTPUT to a report file outside the repository to enable it.
vi.mock('../packages/sdk/src/index.node.js', async (actual) => ({
  ...(await actual<typeof import('../packages/sdk/src/index.node.js')>()),
  createClient: () => ({
    initialize: async () => {
      await delay(20)
    },
    surfaces: { mounts: async () => ({ mounts: [] }) },
    close: async () => {},
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
        lock.resolvedProfileHash = `sha256-${'0'.repeat(64)}`
        lock.seams = Object.fromEntries(
          [
            'approval',
            'checkpoint',
            'ledger',
            'sandbox',
            'verifier',
            'repair',
            'artifacts',
            'principals',
            'platform',
            'harness',
          ].map((name) => [name, '@agnes/base']),
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
              agnes: { plugins: [{ export: 'main', apiRange: '^1.4.0' }] },
            }),
          )
          writeFileSync(join(directory, 'index.mjs'), 'export const main = () => {}\n')
          for (let file = 0; file < 8; file++)
            writeFileSync(join(directory, `asset-${file}.txt`), Buffer.alloc(32 * 1024, 97))
          const source = { type: 'file' as const, ref: `file:./plugin-${index}` }
          const tree = sources.hashDirectory(directory, { exclude: [] })
          const { preview } = inspectStaged({
            dir: directory,
            source,
            ceiling: [],
            fetched: { dir: directory, version: '1.0.0', integrity: tree, license: 'MIT', dependencies: {} },
          })
          lock.packages[id] = {
            version: '1.0.0',
            source,
            integrity: tree,
            treeIntegrity: tree,
            license: 'MIT',
            trust: 'trusted',
            state: { installed: '2026-01-01T00:00:00Z', trusted: null, enabled: false },
            dependencies: {},
            previous: null,
            contributions: preview.contributions,
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
        const profile = await resolveProfile(
          { builtin: 'local-dev' },
          {
            platform: { os: 'linux', arch: 'x64', capabilities: {} },
            agnesVersion: '0.1.0',
            now: '2026-01-01T00:00:00Z',
          },
        )
        const prepare: Record<string, unknown> = {}
        for (const concurrency of [1, 2, 4]) {
          const times: number[] = []
          for (let repeat = 0; repeat < 5; repeat++) {
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
                extensionLoader: {
                  import: async () => {
                    await delay(5)
                    return { main: () => {} }
                  },
                },
                // The pre-change assembly ignores this candidate setting. After the change it selects
                // the exact same stage, integrity checks and synthetic sources at this bound.
                ...{ runtimePrepareConcurrency: concurrency },
              }),
            ).rejects.toThrow('crash:packages')
            times.push(performance.now() - start)
          }
          prepare[String(concurrency)] = median(times)
        }
        const webMs: number[] = []
        writeFileSync(join(dataDir, 'index.html'), '<html>synthetic</html>')
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
          })
          webMs.push(performance.now() - start)
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
          prepareMs: prepare,
          webMs: median(webMs),
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
