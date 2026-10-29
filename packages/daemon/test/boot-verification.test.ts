import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import * as sources from '../../package-manager/src/sources.js'
import {
  verifiedDirectoryDigest,
  withoutPackageVerification,
} from '../../package-manager/src/verification-operation.js'
import { openBootVerification } from '../src/supervisor/boot-verification.js'
import { resolveDaemonProfile } from '../src/supervisor/scope.js'
import { runAgnesd, type startProductionSupervisor } from '../src/supervisor/supervisor.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agh-boot-verification-'))
  roots.push(dir)
  writeFileSync(join(dir, 'payload'), 'first')
  const tree = sources.hashDirectory(dir, { exclude: [] })
  const identity = {
    version: '1.0.0',
    integrity: sources.hashDirectory(dir),
    treeIntegrity: tree,
    capabilityHash: 'a'.repeat(64),
  }
  return { dir, identity }
}

it('shares one observation across boot steps and re-hashes in tasks that outlive or escape the boundary', async () => {
  const { dir, identity } = fixture()
  const hash = vi.spyOn(sources, 'hashDirectory')
  const boot = openBootVerification()
  let releaseLate!: () => void
  const lateGate = new Promise<void>((resolve) => {
    releaseLate = resolve
  })
  let late!: Promise<string>
  let escaped!: Promise<string>
  const step = boot.bind(async () => verifiedDirectoryDigest(dir, identity))
  await step()
  await step()
  expect(hash).toHaveBeenCalledTimes(1)
  await boot.bind(async () => {
    // A timer created inside a step (keeper prewarm, watcher, retry) that fires after boot.
    late = lateGate.then(
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => resolve(verifiedDirectoryDigest(dir, identity)), 0),
        ),
    )
    // A worker-socket style callback created through outside() never joins the live boundary.
    escaped = boot.outside(
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => resolve(verifiedDirectoryDigest(dir, identity)), 0),
        ),
    )
  })()
  expect(await escaped).toBe(identity.treeIntegrity)
  expect(hash).toHaveBeenCalledTimes(2)
  // A write inside the boundary clears the shared observation.
  await boot.bind(async () => withoutPackageVerification(() => undefined))()
  await step()
  expect(hash).toHaveBeenCalledTimes(3)
  await boot.end()
  await boot.end()
  writeFileSync(join(dir, 'payload'), 'changed after boot')
  releaseLate()
  expect(await late).not.toBe(identity.treeIntegrity)
  expect(await step()).not.toBe(identity.treeIntegrity)
})

it('closes the boundary when a boot step fails', async () => {
  const { dir, identity } = fixture()
  const boot = openBootVerification()
  await boot.bind(async () => verifiedDirectoryDigest(dir, identity))()
  await expect(
    boot.bind(async () => {
      throw new Error('boot failed')
    })(),
  ).rejects.toThrow('boot failed')
  writeFileSync(join(dir, 'payload'), 'changed')
  expect(await boot.bind(async () => verifiedDirectoryDigest(dir, identity))()).not.toBe(
    identity.treeIntegrity,
  )
})

it('hashes each installed tree once across runAgnesd boot reads, while gates and later tasks re-hash', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agh-boot-hash-'))
  roots.push(home)
  createPrivateDirectorySync(join(home, 'home'))
  const args = { profile: 'local-dev', home: join(home, 'home'), workspace: join(home, 'home') }
  const handle = { socketPath: join(home, 'unused.sock'), owner: { pid: process.pid, generation: 1 } }
  const boot = (onBoot: (options: Parameters<typeof startProductionSupervisor>[0]) => Promise<void>) =>
    runAgnesd(args, {
      startProduction: (async (options) => {
        await onBoot(options)
        return { ...handle, reclaimNow: async () => [], close: async () => undefined } as never
      }) as typeof startProductionSupervisor,
      publishDiscovery: (async () => undefined) as never,
    })
  // The first boot provisions the release defaults; the measured boot is an initialized home.
  await boot(async () => undefined)
  const trees = new Map<string, number>()
  // Count full tree observations (exclude: []), the digest each boot read verifies.
  const count = (dir: string, opts?: { exclude?: string[] }) => {
    if (opts?.exclude?.length !== 0) return
    const key = realpathSync(dir)
    trees.set(key, (trees.get(key) ?? 0) + 1)
  }
  const sync = sources.hashDirectory
  const async = sources.hashDirectoryAsync
  vi.spyOn(sources, 'hashDirectory').mockImplementation((dir, opts) => {
    count(dir, opts)
    return sync(dir, opts)
  })
  vi.spyOn(sources, 'hashDirectoryAsync').mockImplementation((dir, opts) => {
    count(dir, opts)
    return async(dir, opts)
  })
  let booted!: () => void
  const afterBoot = new Promise<void>((resolve) => {
    booted = resolve
  })
  let late!: Promise<unknown>
  let installed!: string
  await boot(async (options) => {
    const runtime = options.packageRuntime!
    const profileDir = await runtime.profileDirectory('local-dev')
    // startSupervisor's own boot reads (skill inventory, surfaces, pins, client modules) join too.
    const inventory = await runtime.manager.inventory(profileDir)
    await runtime.manager.inventory(profileDir)
    expect(inventory.packages.length).toBeGreaterThan(0)
    expect(trees.size).toBeGreaterThanOrEqual(inventory.packages.length)
    expect([...trees.values()].every((calls) => calls === 1)).toBe(true)
    const pkg = inventory.packages.find((row) => row.directory && row.trusted && !row.blockers.length)!
    installed = realpathSync(pkg.directory!)
    // A runtime snapshot pin is a copy gate: it hashes its source again inside the boundary.
    await runtime.manager.pinRuntimeSnapshot(profileDir, {
      pinId: 'boot-gate',
      operationId: 'boot-gate',
      purpose: 'turn',
      packageId: pkg.id,
      selector: {
        kind: 'installed',
        expectedIntegrity: pkg.entry.integrity,
        expectedTreeIntegrity: pkg.entry.treeIntegrity!,
      },
    })
    expect(trees.get(installed)).toBeGreaterThan(1)
    trees.clear()
    // A timer created during boot that fires after it must observe the tree again.
    late = afterBoot
      .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
      .then(() => runtime.manager.inventory(profileDir))
  })
  booted()
  await late
  expect(trees.get(installed)).toBe(1)
}, 120_000)

it('closes the boot boundary when runAgnesd throws between bound steps', async () => {
  const { dir, identity } = fixture()
  const temporary = mkdtempSync(join(tmpdir(), 'agh-boot-throw-'))
  roots.push(temporary)
  const home = join(temporary, 'home')
  createPrivateDirectorySync(home)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let late!: Promise<string>
  await expect(
    runAgnesd(
      { profile: 'local-dev', home, workspace: home },
      {
        // A bound step memoizes the tree and leaves a task behind; the local Web check then throws.
        resolveProfile: async (...input) => {
          verifiedDirectoryDigest(dir, identity)
          late = gate.then(() => verifiedDirectoryDigest(dir, identity))
          return resolveDaemonProfile(...input)
        },
        localWeb: { addr: '127.0.0.1:0', origin: '' },
      },
    ),
  ).rejects.toThrow('local Web requires both address and exact origin')
  writeFileSync(join(dir, 'payload'), 'changed after a failed boot')
  release()
  expect(await late).not.toBe(identity.treeIntegrity)
})
