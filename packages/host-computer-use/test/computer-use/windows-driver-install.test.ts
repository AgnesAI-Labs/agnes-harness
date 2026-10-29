import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it, vi } from 'vitest'
import fixedLock from '../../src/computer-use/computer-use-driver-lock.json' with { type: 'json' }
import type { ComputerUseDriverLock } from '../../src/computer-use/driver-lock.js'
import {
  doctorLockedWindowsComputerUseDriver,
  installOrUpdateLockedWindowsComputerUseDriver,
  readWindowsComputerUseDriverState,
  recoverLockedWindowsComputerUseDriver,
  type WindowsComputerUseDriverInstallDependencies,
} from '../../src/computer-use/windows-driver-install.js'

const root = mkdtempSync(join(tmpdir(), 'agnes-cua-driver-store-'))

afterAll(() => rmSync(root, { recursive: true, force: true }))

it('doctor re-verifies the Windows signer before health and stops on identity failure', async () => {
  const verify = vi.fn(async () => {
    throw new Error('signer changed')
  })
  const health = vi.fn(async () => undefined)
  await expect(
    doctorLockedWindowsComputerUseDriver({
      directory: root,
      lock: fixedLock as ComputerUseDriverLock,
      dependencies: { verify, health },
    }),
  ).rejects.toThrow('signer changed')
  expect(verify).toHaveBeenCalledOnce()
  expect(health).not.toHaveBeenCalled()
})

it('doctor passes the requested health selectors only after Windows identity verification', async () => {
  const verified = {
    executablePath: join(root, 'cua-driver.exe'),
    version: '0.28.1',
    publisher: 'Cua AI, Inc.',
    leafThumbprint: 'A'.repeat(40),
    publisherSha256: 'b'.repeat(64),
  }
  const verify = vi.fn(async () => verified)
  const health = vi.fn(async () => undefined)
  await doctorLockedWindowsComputerUseDriver({
    directory: root,
    lock: fixedLock as ComputerUseDriverLock,
    selectors: { include: ['binary_version'], skip: ['session_active'] },
    dependencies: { verify, health },
  })
  expect(health).toHaveBeenCalledWith(verified, expect.any(AbortSignal), {
    include: ['binary_version'],
    skip: ['session_active'],
  })
})

function lock(version: string, marker: string): ComputerUseDriverLock {
  const value = structuredClone(fixedLock) as ComputerUseDriverLock
  const artifacts = value.artifacts.filter((entry) => entry.platform === 'win32')
  if (!artifacts.length) throw new Error('fixture lacks Windows artifacts')
  Object.assign(value.source, {
    tag: `cua-driver-rs-v${version}`,
    commit: marker.repeat(40),
  })
  for (const artifact of artifacts)
    Object.assign(artifact, {
      name: `cua-driver-rs-${version}-windows-${artifact.architectures[0]}.zip`,
      url: `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${version}/cua-driver-rs-${version}-windows-${artifact.architectures[0]}.zip`,
      sha256: marker.repeat(64),
      size: 1,
    })
  return value
}

function dependencies(health?: (version: string) => void): WindowsComputerUseDriverInstallDependencies {
  return {
    ensurePrivateDirectory: (path) => mkdirSync(path, { recursive: true }),
    readPrivateText: (path) => readFileSync(path, 'utf8'),
    writePrivateFile: async (path, bytes) => writeFileSync(path, bytes),
    exists: () => false,
    download: async () => Uint8Array.of(1),
    extract: async ({ stagingParent, lock: value }) => {
      const directory = join(stagingParent, `staged-${value.source.tag}`)
      mkdirSync(directory, { recursive: true })
      const version = value.source.tag.slice('cua-driver-rs-v'.length)
      return {
        directory,
        verified: {
          executablePath: join(directory, 'cua-driver.exe'),
          version,
          publisher: 'Cua AI, Inc.',
          leafThumbprint: 'A'.repeat(40),
          publisherSha256: 'b'.repeat(64),
        },
        async release() {
          rmSync(directory, { recursive: true, force: true })
        },
      }
    },
    activate: (extracted, destination) => {
      rmSync(extracted.directory, { recursive: true, force: true })
      mkdirSync(destination, { recursive: true })
    },
    verify: async (directory, value) => ({
      executablePath: join(directory, 'cua-driver.exe'),
      version: value.source.tag.slice('cua-driver-rs-v'.length),
      publisher: 'Cua AI, Inc.',
      leafThumbprint: 'A'.repeat(40),
      publisherSha256: 'b'.repeat(64),
    }),
    health: async (driver) => health?.(driver.version),
  }
}

describe('locked Windows Computer Use driver installation', () => {
  it('activates only after health succeeds and keeps the first healthy release as LKG', async () => {
    const store = join(root, 'first')
    const checked: string[] = []
    const result = await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: lock('0.28.1', 'a'),
      dependencies: dependencies((version) => checked.push(version)),
    })
    expect(result.installed).toBe(true)
    expect(result.state.generation).toBe(1)
    expect(result.state.active).toEqual(result.state.lastKnownGood)
    expect(checked).toEqual(['0.28.1'])
    expect(readWindowsComputerUseDriverState(store, dependencies())).toEqual(result.state)
    expect(readFileSync(join(store, 'activation.json'), 'utf8')).toBe(
      `${JSON.stringify(result.state, null, 2)}\n`,
    )
    expect(
      JSON.parse(readFileSync(join(store, 'locks', `${result.state.active?.directory}.json`), 'utf8')),
    ).toMatchObject({ source: { tag: 'cua-driver-rs-v0.28.1' } })
  })

  it('reopens a healthy activation written with a lowercase Windows thumbprint', async () => {
    const store = join(root, 'lowercase-thumbprint')
    const lowered: WindowsComputerUseDriverInstallDependencies = {
      ...dependencies(),
      verify: async (directory, value) => ({
        executablePath: join(directory, 'cua-driver.exe'),
        version: value.source.tag.slice('cua-driver-rs-v'.length),
        publisher: 'Cua AI, Inc.',
        leafThumbprint: 'A'.repeat(40),
        publisherSha256: 'b'.repeat(64),
      }),
    }
    const installed = await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: lock('0.28.1', 'a'),
      dependencies: lowered,
    })
    expect(installed.state.active?.leafThumbprint).toBe('A'.repeat(40))
    const activationPath = join(store, 'activation.json')
    const legacy = JSON.parse(readFileSync(activationPath, 'utf8')) as {
      active: { leafThumbprint: string }
      lastKnownGood: { leafThumbprint: string }
    }
    legacy.active.leafThumbprint = legacy.active.leafThumbprint.toLowerCase()
    legacy.lastKnownGood.leafThumbprint = legacy.lastKnownGood.leafThumbprint.toLowerCase()
    writeFileSync(activationPath, `${JSON.stringify(legacy, null, 2)}\n`)
    expect(readWindowsComputerUseDriverState(store, lowered).active?.leafThumbprint).toBe('a'.repeat(40))
    await expect(
      installOrUpdateLockedWindowsComputerUseDriver({
        root: store,
        lock: lock('0.28.1', 'a'),
        dependencies: lowered,
      }),
    ).resolves.toMatchObject({ installed: false })
  })

  it('does not publish a candidate whose health check fails and keeps serving the healthy active version', async () => {
    const store = join(root, 'health-failure')
    const oldLock = lock('0.28.0', 'c')
    const currentLock = lock('0.28.1', 'd')
    await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: oldLock,
      dependencies: dependencies(),
    })
    const before = readWindowsComputerUseDriverState(store, dependencies())
    const result = await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: currentLock,
      dependencies: dependencies((version) => {
        if (version === '0.28.1') throw new Error('unhealthy')
      }),
    })
    expect(result.usedLastKnownGood).toBe(true)
    expect(result.verified.version).toBe('0.28.0')
    expect(readWindowsComputerUseDriverState(store, dependencies())).toEqual(before)
  })

  it('rolls an unhealthy active release back to the separately verified LKG', async () => {
    const store = join(root, 'rollback')
    const oldLock = lock('0.28.0', 'e')
    const currentLock = lock('0.28.1', 'f')
    await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: oldLock,
      dependencies: dependencies(),
    })
    await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: currentLock,
      dependencies: dependencies(),
    })
    const result = await recoverLockedWindowsComputerUseDriver({
      root: store,
      activeLock: currentLock,
      dependencies: dependencies((version) => {
        if (version === '0.28.1') throw new Error('active failed')
      }),
    })
    expect(result.rolledBack).toBe(true)
    expect(result.state.active?.version).toBe('0.28.0')
    expect(result.state.lastKnownGood?.version).toBe('0.28.0')
    expect(result.state.generation).toBe(3)
  })

  it('automatically rolls an unhealthy active release back using its persisted lock snapshot', async () => {
    const store = join(root, 'automatic-rollback')
    const oldLock = lock('0.28.0', '1')
    const currentLock = lock('0.28.1', '2')
    await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: oldLock,
      dependencies: dependencies(),
    })
    await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: currentLock,
      dependencies: dependencies(),
    })

    const result = await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: currentLock,
      dependencies: dependencies((version) => {
        if (version === '0.28.1') throw new Error('active failed')
      }),
    })

    expect(result.usedLastKnownGood).toBe(true)
    expect(result.verified.version).toBe('0.28.0')
    expect(result.state.active?.version).toBe('0.28.0')
    expect(result.state.generation).toBe(3)
  })

  it('repairs an unhealthy sole active release into a fresh immutable directory', async () => {
    const store = join(root, 'automatic-repair')
    const currentLock = lock('0.28.1', '7')
    const first = await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: currentLock,
      dependencies: dependencies(),
    })
    let healthChecks = 0
    const repaired = await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: currentLock,
      dependencies: dependencies(() => {
        healthChecks += 1
        if (healthChecks === 1) throw new Error('active failed')
      }),
    })

    expect(repaired.installed).toBe(true)
    expect(repaired.usedLastKnownGood).toBe(false)
    expect(repaired.state.generation).toBe(2)
    expect(repaired.state.active).toEqual(repaired.state.lastKnownGood)
    expect(repaired.state.active?.directory).not.toBe(first.state.active?.directory)
    expect(repaired.state.active?.directory).toMatch(/-repair-[a-f0-9]{16}$/u)
    expect(healthChecks).toBe(2)
  })

  it('fails closed instead of trusting a corrupted LKG lock snapshot', async () => {
    const store = join(root, 'corrupt-lock')
    const oldLock = lock('0.28.0', '3')
    const currentLock = lock('0.28.1', '4')
    const first = await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: oldLock,
      dependencies: dependencies(),
    })
    await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: currentLock,
      dependencies: dependencies(),
    })
    writeFileSync(join(store, 'locks', `${first.state.active?.directory}.json`), '{}\n')

    await expect(
      installOrUpdateLockedWindowsComputerUseDriver({
        root: store,
        lock: currentLock,
        dependencies: dependencies((version) => {
          if (version === '0.28.1') throw new Error('active failed')
        }),
      }),
    ).rejects.toThrow('unavailable')
  })

  it('fails closed on noncanonical or unknown activation state fields', () => {
    const store = join(root, 'corrupt')
    mkdirSync(store, { recursive: true })
    writeFileSync(
      join(store, 'activation.json'),
      '{"schemaVersion":1,"generation":0,"active":null,"lastKnownGood":null,"extra":true}\n',
    )
    expect(() => readWindowsComputerUseDriverState(store, dependencies())).toThrow('unknown fields')
  })

  it('uses a digest-bound immutable version directory name', async () => {
    const store = join(root, 'directory')
    const result = await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: lock('0.28.1', '9'),
      dependencies: dependencies(),
    })
    expect(basename(result.verified.executablePath)).toBe('cua-driver.exe')
    expect(result.state.active?.directory).toBe(`cua-driver-rs-v0.28.1-${'9'.repeat(64)}`)
  })

  it('refuses a concurrent cross-process Windows installation lock', async () => {
    const store = join(root, 'concurrent-lock')
    const lockDirectory = join(store, '.install-lock')
    mkdirSync(lockDirectory, { recursive: true })
    writeFileSync(
      join(lockDirectory, 'owner'),
      `${JSON.stringify({ createdAt: 1_000, nonce: 'a'.repeat(48), pid: process.pid })}\n`,
    )
    await expect(
      installOrUpdateLockedWindowsComputerUseDriver({
        root: store,
        lock: lock('0.28.1', '8'),
        dependencies: { ...dependencies(), clock: () => 1_001, processAlive: () => true },
      }),
    ).rejects.toThrow('already in progress')
    expect(existsSync(lockDirectory)).toBe(true)
  })

  it('recovers only an old Windows installation lock whose recorded process is dead', async () => {
    const store = join(root, 'stale-lock')
    const lockDirectory = join(store, '.install-lock')
    mkdirSync(lockDirectory, { recursive: true })
    writeFileSync(
      join(lockDirectory, 'owner'),
      `${JSON.stringify({ createdAt: 1, nonce: 'b'.repeat(48), pid: 999_999 })}\n`,
    )
    const result = await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: lock('0.28.1', '6'),
      dependencies: {
        ...dependencies(),
        clock: () => 10 * 60_000 + 2,
        processAlive: () => false,
      },
    })
    expect(result.installed).toBe(true)
    expect(existsSync(lockDirectory)).toBe(false)
  })

  it('never treats a malformed Windows installation lock as stale', async () => {
    const store = join(root, 'malformed-lock')
    const lockDirectory = join(store, '.install-lock')
    mkdirSync(lockDirectory, { recursive: true })
    writeFileSync(join(lockDirectory, 'owner'), '{}\n')
    await expect(
      installOrUpdateLockedWindowsComputerUseDriver({
        root: store,
        lock: lock('0.28.1', '5'),
        dependencies: {
          ...dependencies(),
          clock: () => 20 * 60_000,
          processAlive: () => false,
        },
      }),
    ).rejects.toThrow('already in progress')
    expect(existsSync(lockDirectory)).toBe(true)
  })

  it('does not recursively remove unexpected content from a stale installation lock', async () => {
    const store = join(root, 'stale-lock-with-unexpected-entry')
    const lockDirectory = join(store, '.install-lock')
    const unexpected = join(lockDirectory, 'do-not-delete')
    mkdirSync(lockDirectory, { recursive: true })
    writeFileSync(
      join(lockDirectory, 'owner'),
      `${JSON.stringify({ createdAt: 1, nonce: 'd'.repeat(48), pid: 999_999 })}\n`,
    )
    writeFileSync(unexpected, 'preserve')

    await expect(
      installOrUpdateLockedWindowsComputerUseDriver({
        root: store,
        lock: lock('0.28.1', '4'),
        dependencies: {
          ...dependencies(),
          clock: () => 10 * 60_000 + 2,
          processAlive: () => false,
        },
      }),
    ).rejects.toThrow()
    const tombstone = readdirSync(store).find((name) => name.startsWith('.stale-install-lock-'))
    expect(tombstone).toBeDefined()
    expect(readFileSync(join(store, tombstone ?? '', 'do-not-delete'), 'utf8')).toBe('preserve')
  })

  it('uses the same cross-process lock for recovery mutations', async () => {
    const store = join(root, 'recovery-lock')
    const currentLock = lock('0.28.1', '0')
    await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: currentLock,
      dependencies: dependencies(),
    })
    const lockDirectory = join(store, '.install-lock')
    mkdirSync(lockDirectory)
    writeFileSync(
      join(lockDirectory, 'owner'),
      `${JSON.stringify({ createdAt: 1_000, nonce: 'c'.repeat(48), pid: process.pid })}\n`,
    )
    await expect(
      recoverLockedWindowsComputerUseDriver({
        root: store,
        activeLock: currentLock,
        dependencies: { ...dependencies(), clock: () => 1_001, processAlive: () => true },
      }),
    ).rejects.toThrow('already in progress')
  })

  it('serializes stale-lock recovery with an OS-released database lock', async () => {
    const store = join(root, 'serialization-lock')
    const currentLock = lock('0.28.1', 'e')
    await installOrUpdateLockedWindowsComputerUseDriver({
      root: store,
      lock: currentLock,
      dependencies: dependencies(),
    })
    const competing = new DatabaseSync(join(store, '.install-mutation-lock.db'))
    competing.exec('BEGIN IMMEDIATE')
    try {
      await expect(
        installOrUpdateLockedWindowsComputerUseDriver({
          root: store,
          lock: currentLock,
          dependencies: dependencies(),
        }),
      ).rejects.toThrow('already in progress')
    } finally {
      competing.exec('ROLLBACK')
      competing.close()
    }
  })

  it('rejects an invalid clock before acquiring the process lock', async () => {
    const store = join(root, 'invalid-clock')
    const currentLock = lock('0.28.1', 'f')
    await expect(
      installOrUpdateLockedWindowsComputerUseDriver({
        root: store,
        lock: currentLock,
        dependencies: { ...dependencies(), clock: () => Number.NaN },
      }),
    ).rejects.toThrow('clock is invalid')
    await expect(
      installOrUpdateLockedWindowsComputerUseDriver({
        root: store,
        lock: currentLock,
        dependencies: dependencies(),
      }),
    ).resolves.toMatchObject({ installed: true })
  })
})
