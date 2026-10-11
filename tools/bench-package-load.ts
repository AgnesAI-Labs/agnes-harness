import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { loadRuntimePackage } from '../packages/host/src/assemble/packages.js'
import { createLoader } from '../packages/host/src/ext-host/loader.js'
import {
  activeRuntimePinId,
  createPackageManager,
  emptyLock,
  hashDirectory,
  parseSource,
  writeLock,
} from '../packages/package-manager/src/index.js'

// Costs of reading and loading installed plugin packages: the package inventory, the runtime
// snapshot read, how long either holds the event loop, and loading each package's plugins the way
// assembly does. Not a CI gate and no timing assertion: the numbers go into the change record.
const readNumber = (flag: string, fallback: number): number => {
  const index = process.argv.indexOf(flag)
  const value = index < 0 ? fallback : Number(process.argv[index + 1])
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`)
  return value
}
const packages = readNumber('--packages', 20)
const files = readNumber('--files', 200)
const runs = readNumber('--runs', 3)

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] as number
}
const ms = (value: number): string => `${value.toFixed(1)} ms`

/** Wall time of `work`, and the longest the event loop went without running a 1 ms timer. */
async function timed<T>(work: () => Promise<T>): Promise<{ value: T; wall: number; blocked: number }> {
  let last = performance.now()
  let blocked = 0
  const probe = setInterval(() => {
    const now = performance.now()
    blocked = Math.max(blocked, now - last)
    last = now
  }, 1)
  const start = performance.now()
  try {
    const value = await work()
    const wall = performance.now() - start
    blocked = Math.max(blocked, performance.now() - last)
    return { value, wall, blocked }
  } finally {
    clearInterval(probe)
  }
}

const home = mkdtempSync(join(tmpdir(), 'agnes-bench-packages-'))
try {
  const dataDir = join(home, 'store')
  const profileDir = join(home, 'profiles', 'local-dev')
  mkdirSync(profileDir, { recursive: true })
  writeLock(profileDir, {
    ...emptyLock('local-dev', '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(
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
    ),
    policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
  })
  const manager = createPackageManager({
    dataDir,
    cwd: home,
    agnesVersion: '0.1.0',
    now: () => '2026-10-11T00:00:00Z',
    references: async () => [],
  })

  // Each package carries `files` small modules next to its entry, standing in for its own code and
  // vendored dependencies; the plugin export itself does nothing.
  const filler = `export const value = ${JSON.stringify('x'.repeat(900))}\n`
  const setupStart = performance.now()
  for (let n = 0; n < packages; n++) {
    const id = `bench/p${n}`
    const source = join(home, 'sources', `p${n}`)
    mkdirSync(join(source, 'lib'), { recursive: true })
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({
        name: id,
        version: '1.0.0',
        license: 'MIT',
        dependencies: {},
        exports: './index.mjs',
        agnes: { plugins: [{ export: 'runtime', id: `ext:bench/p${n}`, runtime: 'in-process' }] },
      }),
    )
    writeFileSync(join(source, 'index.mjs'), 'export const runtime = { apply() { return {} } }\n')
    for (let f = 0; f < files; f++) writeFileSync(join(source, 'lib', `m${f}.mjs`), filler)
    const ref = parseSource(`file:./sources/p${n}`)
    const preview = await manager.inspect(profileDir, ref)
    await manager.install(profileDir, ref, { expectedIntegrity: preview.integrity })
    const row = (await manager.inventory(profileDir)).packages.find((candidate) => candidate.id === id)
    if (!row?.entry.treeIntegrity) throw new Error(`${id} was not installed`)
    await manager.trust(profileDir, id, {
      integrity: row.entry.integrity,
      capabilityHash: row.capabilityHash,
    })
    const pinId = activeRuntimePinId({ packageId: id, integrity: row.entry.integrity })
    await manager.pinRuntimeSnapshot(profileDir, {
      pinId,
      operationId: pinId,
      packageId: id,
      purpose: 'active',
      selector: {
        kind: 'installed',
        expectedIntegrity: row.entry.integrity,
        expectedTreeIntegrity: row.entry.treeIntegrity,
      },
    })
  }
  const setup = performance.now() - setupStart

  const snapshots = await manager.runtimePluginSnapshots(profileDir)
  if (snapshots.length !== packages)
    throw new Error(`expected ${packages} snapshots, got ${snapshots.length}`)
  const first = snapshots[0]
  if (!first) throw new Error('no snapshot')

  const hashOne: number[] = []
  for (let run = 0; run < runs; run++) {
    const start = performance.now()
    hashDirectory(first.snapshot.directory, { exclude: [] })
    hashOne.push(performance.now() - start)
  }
  // A manager that has read nothing yet, as after a daemon or worker start, then the same manager
  // again, as for every later page, asset or service request.
  const reader = () =>
    createPackageManager({ dataDir, cwd: home, agnesVersion: '0.1.0', references: async () => [] })
  const inventoryReader = reader()
  const inventoryFirst = await timed(() => inventoryReader.inventory(profileDir))
  const inventory: { wall: number; blocked: number }[] = []
  for (let run = 0; run < runs; run++)
    inventory.push(await timed(() => inventoryReader.inventory(profileDir)))
  const snapshotReader = reader()
  const snapshotFirst = await timed(() => snapshotReader.runtimePluginSnapshots(profileDir))
  const snapshotRead: { wall: number; blocked: number }[] = []
  for (let run = 0; run < runs; run++)
    snapshotRead.push(await timed(() => snapshotReader.runtimePluginSnapshots(profileDir)))

  // Loading as assembly does it: one package after another, each verified and imported. The first
  // pass fills the loader's file cache; the second is what a restart with a warm cache costs.
  const cacheDir = join(home, 'loader-cache')
  const loadPass = async () => {
    const loader = createLoader({ cacheDir, hostRoot: process.cwd(), agnesVersion: '0.1.0' })
    return timed(async () => {
      for (const source of snapshots) {
        const loaded = await loadRuntimePackage(source, loader)
        if (!loaded) throw new Error(`${source.snapshot.packageId} loaded no plugins`)
      }
    })
  }
  const cold = await loadPass()
  const warm = await loadPass()

  const row = (label: string, samples: { wall: number; blocked: number }[]) =>
    `${label.padEnd(36)} ${ms(median(samples.map((s) => s.wall))).padStart(12)} ${ms(
      median(samples.map((s) => s.blocked)),
    ).padStart(14)}`
  console.log(`packages=${packages} files/package=${files} runs=${runs} (setup ${ms(setup)})`)
  console.log(`hashDirectory, one package               ${ms(median(hashOne))}`)
  console.log(`${'operation'.padEnd(36)} ${'wall'.padStart(12)} ${'longest block'.padStart(14)}`)
  console.log(row('inventory(), first read', [inventoryFirst]))
  console.log(row('inventory(), later reads', inventory))
  console.log(row('runtimePluginSnapshots(), first read', [snapshotFirst]))
  console.log(row('runtimePluginSnapshots(), later reads', snapshotRead))
  console.log(row('load all packages, cold loader cache', [cold]))
  console.log(row('load all packages, warm loader cache', [warm]))
} finally {
  rmSync(home, { recursive: true, force: true })
}
