import { realpathSync, writeFileSync } from 'node:fs'
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
