import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import fixed from '../../src/computer-use/computer-use-driver-lock.json' with { type: 'json' }
import type { ComputerUseDriverLock } from '../../src/computer-use/driver-lock.js'
import {
  doctorLockedMacOSComputerUseDriver,
  installOrUpdateLockedMacOSComputerUseDriver,
  probeMacOSComputerUseDriverHealth,
  readMacOSComputerUseDriverState,
} from '../../src/computer-use/macos-driver-install.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('doctor re-verifies the macOS bundle before health and stops on identity failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-mac-doctor-'))
  roots.push(root)
  const verify = vi.fn(async () => {
    throw new Error('bundle signature changed')
  })
  const health = vi.fn(async () => undefined)
  await expect(
    doctorLockedMacOSComputerUseDriver({
      directory: root,
      lock: fixed as ComputerUseDriverLock,
      dependencies: { verify, health },
    }),
  ).rejects.toThrow('bundle signature changed')
  expect(verify).toHaveBeenCalledOnce()
  expect(health).not.toHaveBeenCalled()
})

it('doctor passes the requested health selectors only after macOS identity verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-mac-doctor-filter-'))
  roots.push(root)
  const verified = driver(root, fixed as ComputerUseDriverLock)
  const verify = vi.fn(async () => verified)
  const health = vi.fn(async () => undefined)
  await doctorLockedMacOSComputerUseDriver({
    directory: root,
    lock: fixed as ComputerUseDriverLock,
    selectors: { include: ['binary_version'], skip: ['session_active'] },
    dependencies: { verify, health },
  })
  expect(health).toHaveBeenCalledWith(verified, expect.any(AbortSignal), {
    include: ['binary_version'],
    skip: ['session_active'],
  })
})

function driver(directory: string, lock: ComputerUseDriverLock) {
  return {
    executablePath: join(directory, 'cua-driver'),
    version: lock.source.tag.slice('cua-driver-rs-v'.length),
    bundleId: 'com.trycua.driver',
    teamId: 'YCK386LBJ7',
    authority: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
    appPath: join(directory, 'CuaDriver.app'),
  }
}

function dependencies() {
  let sequence = 0
  const health = vi.fn(async (_value: { version: string }) => undefined)
  return {
    download: vi.fn(async () => new Uint8Array([1, 2, 3])),
    extract: vi.fn(async (input: { stagingParent: string; lock: ComputerUseDriverLock }) => {
      const container = join(input.stagingParent, `fake-${sequence++}`)
      const directory = join(container, 'payload')
      mkdirSync(directory, { recursive: true })
      return {
        directory,
        container,
        verified: driver(directory, input.lock),
        async release() {
          rmSync(container, { recursive: true, force: true })
        },
      }
    }),
    activate: vi.fn((extracted: { directory: string }, destination: string) => {
      mkdirSync(dirname(destination), { recursive: true })
      renameSync(extracted.directory, destination)
    }),
    verify: vi.fn(async (directory: string, lock: ComputerUseDriverLock) => driver(directory, lock)),
    health,
  }
}

it('limits automatic macOS health checks to permission-independent core rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-mac-health-'))
  roots.push(root)
  const call = vi.fn(async () => ({
    content: [],
    isError: false,
    structuredContent: {
      schema_version: '1',
      platform: 'darwin',
      driver_version: '0.28.1',
      overall: 'ok',
      checks: [
        { name: 'binary_version', status: 'pass' },
        { name: 'platform_supported', status: 'pass' },
        { name: 'session_active', status: 'pass' },
      ],
    },
  }))
  const connection = {
    catalog: new Map([
      ['health_report', {}],
      ['check_permissions', {}],
      ['get_window_state', {}],
    ]),
    call,
  }
  const runtime = {
    open: vi.fn(async () => connection),
    close: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  }

  await probeMacOSComputerUseDriverHealth(
    driver(root, fixed as ComputerUseDriverLock),
    new AbortController().signal,
    undefined,
    { runtime: runtime as never },
  )

  expect(call).toHaveBeenCalledWith(
    'health_report',
    { include: ['binary_version', 'platform_supported', 'session_active'] },
    expect.objectContaining({ timeoutMs: 10_000 }),
  )
  expect(runtime.close).toHaveBeenCalledOnce()
  expect(runtime.dispose).toHaveBeenCalledOnce()
})

it('installs once, persists a canonical activation record and reuses the healthy version', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-mac-install-'))
  roots.push(root)
  const deps = dependencies()
  const first = await installOrUpdateLockedMacOSComputerUseDriver({
    root,
    lock: fixed as ComputerUseDriverLock,
    dependencies: deps,
  })
  expect(first).toMatchObject({ installed: true, usedLastKnownGood: false })
  expect(first.state.generation).toBe(1)
  const second = await installOrUpdateLockedMacOSComputerUseDriver({
    root,
    lock: fixed as ComputerUseDriverLock,
    dependencies: deps,
  })
  expect(second).toMatchObject({ installed: false, usedLastKnownGood: false })
  expect(deps.download).toHaveBeenCalledOnce()
  expect(readMacOSComputerUseDriverState(root)).toEqual(second.state)
})

it('repairs a same-version unhealthy active into a fresh immutable directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-mac-install-'))
  roots.push(root)
  const deps = dependencies()
  const first = await installOrUpdateLockedMacOSComputerUseDriver({
    root,
    lock: fixed as ComputerUseDriverLock,
    dependencies: deps,
  })
  const broken = first.state.active?.directory
  deps.verify.mockImplementation(async (directory: string, lock: ComputerUseDriverLock) => {
    if (directory.endsWith(String(broken))) throw new Error('corrupt')
    return driver(directory, lock)
  })
  const repaired = await installOrUpdateLockedMacOSComputerUseDriver({
    root,
    lock: fixed as ComputerUseDriverLock,
    dependencies: deps,
  })
  expect(repaired.installed).toBe(true)
  expect(repaired.state.active?.directory).not.toBe(broken)
  expect(repaired.state.generation).toBe(2)
})

it('keeps the healthy previous version when a candidate fails post-activation health', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-mac-install-'))
  roots.push(root)
  const deps = dependencies()
  const first = await installOrUpdateLockedMacOSComputerUseDriver({
    root,
    lock: fixed as ComputerUseDriverLock,
    dependencies: deps,
  })
  const next = structuredClone(fixed) as ComputerUseDriverLock
  ;(next.source as { tag: string }).tag = 'cua-driver-rs-v0.28.2'
  const artifact = next.artifacts.find((candidate) => candidate.platform === 'darwin') as {
    sha256: string
  }
  artifact.sha256 = 'f'.repeat(64)
  deps.health.mockImplementation(async (value: { version: string }) => {
    if (value.version === '0.28.2') throw new Error('unhealthy candidate')
  })
  const result = await installOrUpdateLockedMacOSComputerUseDriver({ root, lock: next, dependencies: deps })
  expect(result).toMatchObject({ installed: false, usedLastKnownGood: true })
  expect(result.state.active?.directory).toBe(first.state.active?.directory)
})

it('refuses a concurrent cross-process install lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-mac-install-'))
  roots.push(root)
  mkdirSync(join(root, '.install-lock'), { recursive: true })
  await expect(
    installOrUpdateLockedMacOSComputerUseDriver({
      root,
      lock: fixed as ComputerUseDriverLock,
      dependencies: dependencies(),
    }),
  ).rejects.toThrow('already in progress')
})

it('recovers only an old lock whose recorded process is confirmed dead', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-mac-install-'))
  roots.push(root)
  const lockDirectory = join(root, '.install-lock')
  mkdirSync(lockDirectory, { recursive: true })
  writeFileSync(join(lockDirectory, 'owner'), `${JSON.stringify({ createdAt: 1, pid: 999_999 })}\n`, {
    mode: 0o600,
  })
  const deps = { ...dependencies(), clock: () => 10 * 60_000 + 2, processAlive: () => false }
  await expect(
    installOrUpdateLockedMacOSComputerUseDriver({
      root,
      lock: fixed as ComputerUseDriverLock,
      dependencies: deps,
    }),
  ).resolves.toMatchObject({ installed: true })
})

it('serializes stale-lock recovery with an OS-released database lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-mac-install-'))
  roots.push(root)
  const deps = dependencies()
  await installOrUpdateLockedMacOSComputerUseDriver({
    root,
    lock: fixed as ComputerUseDriverLock,
    dependencies: deps,
  })
  const competing = new DatabaseSync(join(root, '.install-mutation-lock.db'))
  competing.exec('BEGIN IMMEDIATE')
  try {
    await expect(
      installOrUpdateLockedMacOSComputerUseDriver({
        root,
        lock: fixed as ComputerUseDriverLock,
        dependencies: deps,
      }),
    ).rejects.toThrow('already in progress')
  } finally {
    competing.exec('ROLLBACK')
    competing.close()
  }
})

it('rejects an invalid clock before acquiring the process lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-mac-install-'))
  roots.push(root)
  await expect(
    installOrUpdateLockedMacOSComputerUseDriver({
      root,
      lock: fixed as ComputerUseDriverLock,
      dependencies: { ...dependencies(), clock: () => Number.NaN },
    }),
  ).rejects.toThrow('clock is invalid')
  await expect(
    installOrUpdateLockedMacOSComputerUseDriver({
      root,
      lock: fixed as ComputerUseDriverLock,
      dependencies: dependencies(),
    }),
  ).resolves.toMatchObject({ installed: true })
})

it('rejects a symlinked installation root before attempting to repair its permissions', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'agnes-mac-install-root-'))
  roots.push(parent)
  const target = join(parent, 'target')
  const root = join(parent, 'root')
  mkdirSync(target)
  symlinkSync(target, root, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(
    installOrUpdateLockedMacOSComputerUseDriver({
      root,
      lock: fixed as ComputerUseDriverLock,
      dependencies: dependencies(),
    }),
  ).rejects.toThrow('not a directory')
})
