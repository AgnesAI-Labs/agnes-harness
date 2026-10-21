import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { createPackageManager, readLock, withLock } from '@agnes/package-manager'
import { expect, it, vi } from 'vitest'
import { DaemonPluginByteVerification } from '../src/supervisor/plugin-byte-verification.js'
import { createWorkerByteFixture } from './plugin-byte-fixture.js'

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
