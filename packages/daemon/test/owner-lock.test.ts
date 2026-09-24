import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultProcessIdentity, type ProcessIdentity } from '@agnes/host'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireDaemonMutationLock } from '../src/supervisor/mutation-lock.js'
import { acquireOwnerLock, OwnerLockError } from '../src/supervisor/owner-lock.js'
import { readOwner } from '../src/supervisor/owner-record.js'

const roots: string[] = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-owner-lock-'))
  roots.push(dir)
  return dir
}
const options = {
  socketPath: '/tmp/agnes.sock',
  processIdentity: async (): Promise<ProcessIdentity> => ({ state: 'alive', startId: 'test-start' }),
}
afterEach(() => {
  vi.useRealTimers()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it('holds shared mutation exclusion until idempotent owner release', async () => {
  const dir = tmp(),
    held = await acquireOwnerLock(dir, options)
  expect(await readOwner(dir)).toEqual(held.owner)
  expect(() => acquireDaemonMutationLock(dir)).toThrow('lock is held')
  const first = held.release()
  expect(held.release()).toBe(first)
  await first
  expect(await readOwner(dir)).toBeNull()
  const next = await acquireOwnerLock(dir, options)
  expect(next.owner.generation).not.toBe(held.owner.generation)
  await held.release()
  expect(await readOwner(dir)).toEqual(next.owner)
  await next.release()
})
it('acquires and releases an owner using the actual platform process identity', async () => {
  const dir = tmp()
  const held = await acquireOwnerLock(dir, { ...options, processIdentity: defaultProcessIdentity })
  try {
    expect(await defaultProcessIdentity(process.pid)).toEqual({
      state: 'alive',
      startId: held.owner.processStartId,
    })
    expect(await readOwner(dir)).toEqual(held.owner)
  } finally {
    await held.release()
  }
  expect(await readOwner(dir)).toBeNull()
})
const oldOwner = {
  pid: 42,
  processStartId: 'old-start',
  generation: '11111111-2222-3333-4444-555555555555',
  startedAt: '2026-09-10T00:00:00.000Z',
  socketPath: '/tmp/old.sock',
}
function stale(dir: string) {
  createPrivateDirectorySync(join(dir, 'daemon'))
  writeFileSync(join(dir, 'daemon', 'owner.json'), JSON.stringify(oldOwner))
}
it.each(['dead', 'reused'])('replaces a confirmed %s owner while retaining the guard', async (state) => {
  const dir = tmp()
  stale(dir)
  const held = await acquireOwnerLock(dir, {
    ...options,
    processIdentity: async (pid) =>
      pid === 42
        ? state === 'dead'
          ? { state: 'dead' }
          : { state: 'alive', startId: 'different-start' }
        : { state: 'alive', startId: 'self-start' },
  })
  expect(held.owner.processStartId).toBe('self-start')
  expect(held.owner.generation).not.toBe(oldOwner.generation)
  await held.release()
})
it.each(['alive', 'unknown', 'throws'])(
  'preserves %s owner and releases the guard on refusal',
  async (state) => {
    const dir = tmp()
    stale(dir)
    await expect(
      acquireOwnerLock(dir, {
        ...options,
        processIdentity: async () => {
          if (state === 'throws') throw new Error('PRIVATE-MARKER')
          return state === 'alive'
            ? { state: 'alive', startId: 'old-start' }
            : { state: 'unknown', reason: 'private' }
        },
      }),
    ).rejects.toThrow(OwnerLockError)
    expect(await readOwner(dir)).toEqual(oldOwner)
    const guard = acquireDaemonMutationLock(dir)
    guard.release()
  },
)
it('preserves a changed generation even if the caller mutates the returned owner', async () => {
  const dir = tmp(),
    held = await acquireOwnerLock(dir, options)
  const replacement = { ...held.owner, generation: oldOwner.generation }
  writeFileSync(join(dir, 'daemon', 'owner.json'), JSON.stringify(replacement))
  held.owner.generation = replacement.generation
  await expect(held.release()).rejects.toThrow(OwnerLockError)
  expect(await readOwner(dir)).toEqual(replacement)
})
it('does not replace a corrupt record and releases the acquisition guard', async () => {
  const dir = tmp()
  createPrivateDirectorySync(join(dir, 'daemon'))
  const file = join(dir, 'daemon', 'owner.json')
  writeFileSync(file, '{')
  await expect(acquireOwnerLock(dir, options)).rejects.toThrow(OwnerLockError)
  expect(readFileSync(file, 'utf8')).toBe('{')
  const guard = acquireDaemonMutationLock(dir)
  guard.release()
})
it('refuses an unavailable self identity without publishing an owner', async () => {
  const dir = tmp()
  await expect(
    acquireOwnerLock(dir, { ...options, processIdentity: async () => ({ state: 'dead' }) }),
  ).rejects.toThrow(OwnerLockError)
  expect(await readOwner(dir)).toBeNull()
})
it('enforces the default identity deadline on an uncooperative query', async () => {
  vi.useFakeTimers()
  const dir = tmp()
  let started!: () => void
  const queryStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const outcome = acquireOwnerLock(dir, {
    ...options,
    processIdentity: () => {
      started()
      return new Promise(() => {})
    },
  }).catch((error: unknown) => error)
  await queryStarted
  let settled = false
  void outcome.then(() => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(2_999)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await outcome).toBeInstanceOf(OwnerLockError)
  expect(await readOwner(dir)).toBeNull()
  const guard = acquireDaemonMutationLock(dir)
  guard.release()
})

it.each(['', ' ', 'bad\nidentity', 'x'.repeat(257), 42, null])(
  'rejects malformed stale process identity %j without replacing it',
  async (startId) => {
    const dir = tmp()
    stale(dir)
    await expect(
      acquireOwnerLock(dir, {
        ...options,
        processIdentity: async (pid) =>
          ({ state: 'alive', startId: pid === 42 ? startId : 'self-valid' }) as ProcessIdentity,
      }),
    ).rejects.toThrow(OwnerLockError)
    expect(await readOwner(dir)).toEqual(oldOwner)
    acquireDaemonMutationLock(dir).release()
  },
)
