import * as syncFs from 'node:fs'
import { realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { createPackageManager, readLock, withLock } from '@agnes/package-manager'
import { expect, it, vi } from 'vitest'
import { DaemonPluginByteVerification } from '../src/supervisor/plugin-byte-verification.js'
import { createWorkerByteFixture } from './plugin-byte-fixture.js'

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}))
vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }))

it('stops execution before a pending profile write and drains durable revocation outside the reader', async () => {
  const fixture = await createWorkerByteFixture()
  const owner = new DaemonPluginByteVerification(fixture.profileDir, fixture.home, 'local-dev')
  const stopped = vi.fn(),
    revoked: string[] = [],
    notice = vi.fn()
  owner.bind(
    stopped,
    (id) => {
      expect(
        readLock(fixture.profileDir, { profile: 'local-dev', agnesVersion: '0.0.0' }).packages[id]?.state
          .trusted,
      ).toBeNull()
      revoked.push(id)
    },
    notice,
  )
  const manager = createPackageManager({
    dataDir: fixture.home,
    cwd: fixture.home,
    agnesVersion: '0.0.0',
    references: async () => [],
    byteVerification: owner.verification,
  })
  try {
    const row = (await manager.inventory(fixture.profileDir)).packages[0]!
    let unlock!: () => void, locked!: () => void
    const held = new Promise<void>((r) => {
        unlock = r
      }),
      ready = new Promise<void>((r) => {
        locked = r
      })
    const writer = withLock(fixture.profileDir, async () => {
      locked()
      await held
    })
    await ready
    try {
      writeFileSync(
        join(row.directory!, 'index.mjs'),
        'export const main = {apply() {throw new Error("bad")}}',
      )
      await expect(manager.runtimePluginSnapshots(fixture.profileDir)).rejects.toThrow()
      await setImmediate()
      expect(stopped).toHaveBeenCalled()
      expect(revoked).toEqual([])
      expect(notice).not.toHaveBeenCalled()
    } finally {
      unlock()
      await writer
    }
    await owner.close()
    expect(revoked).toEqual([row.id])
    expect(notice).toHaveBeenCalledOnce()
    expect(
      readLock(fixture.profileDir, { profile: 'local-dev', agnesVersion: '0.0.0' }).packages[row.id]?.state
        .enabled,
    ).toBe(false)
  } finally {
    await owner.close()
    await fixture.close()
  }
})

it('review: a transient filesystem EIO must not kill the worker or persist a revoked grant', async () => {
  const fixture = await createWorkerByteFixture()
  const owner = new DaemonPluginByteVerification(fixture.profileDir, fixture.home, 'local-dev')
  const stopped = vi.fn(),
    revoked = vi.fn(),
    notice = vi.fn()
  owner.bind(stopped, revoked, notice)
  const manager = createPackageManager({
    dataDir: fixture.home,
    cwd: fixture.home,
    agnesVersion: '0.0.0',
    references: async () => [],
    byteVerification: owner.verification,
  })
  let restore = () => {}
  try {
    const row = (await manager.inventory(fixture.profileDir)).packages[0]!
    const canonical = realpathSync(row.directory!),
      original = fs.lstat
    const fault = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(canonical) || String(args[0]).startsWith(row.directory!))
        throw Object.assign(new Error('synthetic storage outage'), { code: 'EIO' })
      return original(...args)
    })
    restore = () => fault.mockRestore()
    await expect(manager.runtimePluginSnapshots(fixture.profileDir)).rejects.toThrow()
    restore()
    await owner.close()
    const current = readLock(fixture.profileDir, { profile: 'local-dev', agnesVersion: '0.0.0' }).packages[
      row.id
    ]!
    expect({
      workerStopped: stopped.mock.calls.length > 0,
      targetRevoked: revoked.mock.calls.length > 0,
      stillTrusted: current.state.trusted !== null,
      enabled: current.state.enabled,
    }).toEqual({
      workerStopped: false,
      targetRevoked: false,
      stillTrusted: true,
      enabled: true,
    })
  } finally {
    restore()
    await owner.close()
    await fixture.close()
    vi.restoreAllMocks()
  }
})

it.each([
  ['sync', 'digest'],
  ['async', 'digest'],
  ['sync', 'symlink'],
  ['async', 'symlink'],
] as const)('recheck: %s %s faults still stop execution and persist revocation', async (mode, damage) => {
  const fixture = await createWorkerByteFixture()
  const owner = new DaemonPluginByteVerification(fixture.profileDir, fixture.home, 'local-dev')
  const stopped = vi.fn(),
    revoked = vi.fn(),
    notice = vi.fn()
  owner.bind(stopped, revoked, notice)
  const manager = createPackageManager({
    dataDir: fixture.home,
    cwd: fixture.home,
    agnesVersion: '0.0.0',
    references: async () => [],
    byteVerification: owner.verification,
  })
  try {
    const row = (await manager.inventory(fixture.profileDir)).packages[0]!
    const expected = { ...row.entry, capabilityHash: row.capabilityHash, packageId: row.id }
    const file = join(row.directory!, 'index.mjs')
    if (damage === 'digest') writeFileSync(file, 'changed real package content')
    else {
      rmSync(file)
      symlinkSync(join(row.directory!, 'package.json'), file)
    }
    const use = async () => {
      const result =
        mode === 'sync'
          ? owner.verification.readSync(row.directory!, expected)
          : await owner.verification.read(row.directory!, expected)
      if (result !== expected.treeIntegrity) throw new Error('consumer refuses changed digest')
    }
    await expect(use()).rejects.toThrow()
    await setImmediate()
    expect(stopped).toHaveBeenCalled()
    await owner.close()
    const current = readLock(fixture.profileDir, { profile: 'local-dev', agnesVersion: '0.0.0' }).packages[
      row.id
    ]!
    expect(current.state).toMatchObject({ trusted: null, enabled: false })
    expect(current.trustDecision).toBeUndefined()
    expect(revoked).toHaveBeenCalledWith(row.id)
    expect(notice).toHaveBeenCalled()
  } finally {
    await owner.close()
    await fixture.close()
  }
})

it('recheck: confirmed symlink followed by EIO still persists the negative decision', async () => {
  const fixture = await createWorkerByteFixture()
  const owner = new DaemonPluginByteVerification(fixture.profileDir, fixture.home, 'local-dev')
  const stopped = vi.fn(),
    revoked = vi.fn()
  owner.bind(stopped, revoked, () => {})
  const manager = createPackageManager({
    dataDir: fixture.home,
    cwd: fixture.home,
    agnesVersion: '0.0.0',
    references: async () => [],
    byteVerification: owner.verification,
  })
  let restore = () => {}
  try {
    const row = (await manager.inventory(fixture.profileDir)).packages[0]!
    const expected = { ...row.entry, capabilityHash: row.capabilityHash, packageId: row.id }
    owner.verification.invalidate()
    const canonical = realpathSync(row.directory!),
      file = join(canonical, 'index.mjs')
    rmSync(file)
    symlinkSync(join(canonical, 'package.json'), file)
    const original = fs.lstat
    let confirmed = false,
      outage = false
    const fault = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const path = String(args[0])
      if (confirmed && (path === canonical || path === row.directory)) {
        outage = true
        throw Object.assign(new Error('root outage after confirmed symlink'), { code: 'EIO' })
      }
      const stat = await original(...args)
      if (path === file && stat.isSymbolicLink()) confirmed = true
      return stat
    })
    restore = () => fault.mockRestore()
    await expect(owner.verification.read(row.directory!, expected)).rejects.toThrow()
    restore()
    await owner.close()
    const current = readLock(fixture.profileDir, { profile: 'local-dev', agnesVersion: '0.0.0' }).packages[
      row.id
    ]!
    expect({
      confirmed,
      outage,
      stopped: stopped.mock.calls.length > 0,
      revoked: revoked.mock.calls.length > 0,
      trusted: current.state.trusted !== null,
      enabled: current.state.enabled,
    }).toEqual({
      confirmed: true,
      outage: true,
      stopped: true,
      revoked: true,
      trusted: false,
      enabled: false,
    })
  } finally {
    restore()
    await owner.close()
    await fixture.close()
    vi.restoreAllMocks()
  }
})

it('recheck2: control refresh outage cannot erase a confirmed fault for an actual trusted package', async () => {
  const fixture = await createWorkerByteFixture()
  const owner = new DaemonPluginByteVerification(fixture.profileDir, fixture.home, 'local-dev')
  const stopped = vi.fn(),
    revoked = vi.fn()
  owner.bind(stopped, revoked, () => {})
  const manager = createPackageManager({
    dataDir: fixture.home,
    cwd: fixture.home,
    agnesVersion: '0.0.0',
    references: async () => [],
    byteVerification: owner.verification,
  })
  let restore = () => {}
  try {
    const row = (await manager.inventory(fixture.profileDir)).packages[0]!
    const expected = { ...row.entry, capabilityHash: row.capabilityHash, packageId: row.id }
    owner.verification.invalidate()
    const file = join(realpathSync(row.directory!), 'index.mjs')
    rmSync(file)
    symlinkSync(join(realpathSync(row.directory!), 'package.json'), file)
    const originalStat = fs.lstat,
      originalControl = syncFs.readFileSync
    let confirmed = false,
      outage = false
    const stat = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const result = await originalStat(...args)
      if (String(args[0]) === file && result.isSymbolicLink()) confirmed = true
      return result
    })
    const control = vi.spyOn(syncFs, 'readFileSync').mockImplementation((...args) => {
      if (confirmed && !outage && String(args[0]) === join(fixture.profileDir, 'agnes-lock.json')) {
        outage = true
        throw Object.assign(new Error('control refresh unavailable after confirmed structure fault'), {
          code: 'EIO',
        })
      }
      return originalControl(...args)
    })
    restore = () => {
      stat.mockRestore()
      control.mockRestore()
    }
    await expect(owner.verification.read(row.directory!, expected)).rejects.toThrow()
    restore()
    await owner.close()
    const current = readLock(fixture.profileDir, { profile: 'local-dev', agnesVersion: '0.0.0' }).packages[
      row.id
    ]!
    expect({
      confirmed,
      outage,
      stopped: stopped.mock.calls.length > 0,
      revoked: revoked.mock.calls.length > 0,
      trusted: current.state.trusted !== null,
      enabled: current.state.enabled,
    }).toEqual({
      confirmed: true,
      outage: true,
      stopped: true,
      revoked: true,
      trusted: false,
      enabled: false,
    })
  } finally {
    restore()
    await owner.close()
    await fixture.close()
    vi.restoreAllMocks()
  }
})
