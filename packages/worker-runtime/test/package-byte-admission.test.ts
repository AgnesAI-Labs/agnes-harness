import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashDirectory, packageByteBinding } from '@agnes/package-manager'
import { expect, it, vi } from 'vitest'
import { workerByteAdmission } from '../src/package-byte-admission.js'

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}))

it.each([
  'valid',
  'wrong-token',
  'wrong-profile',
  'wrong-generation',
  'bad-refs',
  'null-ref',
  'timeout',
  'disconnect',
  'unsupported',
  'string-generation',
  'bad-binding',
  'too-many-refs',
  'non-hash-integrity',
])('handles %s before Host or session initialization and releases input listeners', async (mode) => {
  const home = mkdtempSync(join(tmpdir(), 'agh-boot-admission-')),
    file = join(home, 'profile.json')
  mkdirSync(join(home, 'profiles/p'), { recursive: true })
  writeFileSync(file, JSON.stringify({ name: 'p', hash: 'profile-hash', dataDir: home }))
  const env = {
    AGNES_PACKAGE_BYTE_ADMISSION: mode === 'unsupported' ? '0' : '1',
    AGNES_PROFILE_FILE: file,
    AGNES_WORKER_TOKEN: 'token',
    AGNES_WORKER_GENERATION: '2',
  }
  const channel = Object.assign(new EventEmitter(), {
    send() {
      if (mode === 'timeout') return
      queueMicrotask(() => {
        if (mode === 'disconnect') {
          channel.emit('disconnect')
          return
        }
        channel.emit('message', {
          kind: 'package-byte-admission',
          token: mode === 'wrong-token' ? 'other' : 'token',
          profileHash: mode === 'wrong-profile' ? 'other' : 'profile-hash',
          generation: mode === 'wrong-generation' ? 1 : mode === 'string-generation' ? '2' : 2,
          admission: {
            binding: mode === 'bad-binding' ? null : packageByteBinding(join(home, 'profiles/p')),
            trees:
              mode === 'bad-refs'
                ? [{ directory: '/arbitrary' }]
                : mode === 'null-ref'
                  ? [null]
                  : mode === 'too-many-refs'
                    ? Array.from({ length: 4097 }, () => ({}))
                    : mode === 'non-hash-integrity'
                      ? [
                          {
                            directory: home,
                            identity: {
                              version: '1',
                              capabilityHash: 'cap',
                              integrity: 'integrity',
                              treeIntegrity: 'unverified',
                            },
                          },
                        ]
                      : [],
          },
        })
      })
    },
  })
  try {
    if (mode === 'timeout') vi.useFakeTimers()
    const pending = workerByteAdmission(env, home, channel)
    if (mode === 'valid') {
      const value = await pending
      expect(value?.admission.trees).toEqual([])
      await value?.owner.close()
    } else if (mode === 'unsupported') expect(await pending).toBeUndefined()
    else {
      const rejected = expect(pending).rejects.toThrow()
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(2000)
      await rejected
    }
    expect(channel.listenerCount('message')).toBe(0)
    expect(channel.listenerCount('disconnect')).toBe(0)
  } finally {
    vi.useRealTimers()
    rmSync(home, { recursive: true, force: true })
  }
})

it.each(['success', 'reject'] as const)(
  'recheck: private IPC admission cannot bypass full reads again after assembly %s',
  async (completion) => {
    const home = mkdtempSync(join(tmpdir(), 'agh-recheck-admission-'))
    const profileDir = join(home, 'profiles/p'),
      directory = join(profileDir, 'packages/payload')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'index.mjs'), 'GOOD')
    const file = join(home, 'profile.json')
    writeFileSync(file, JSON.stringify({ name: 'p', hash: 'profile-hash', dataDir: home }))
    const digest = hashDirectory(directory, { exclude: [] })
    const expected = {
      version: '1.0.0',
      integrity: digest,
      treeIntegrity: digest,
      capabilityHash: 'a'.repeat(64),
    }
    const frame = {
      kind: 'package-byte-admission',
      token: 'token',
      profileHash: 'profile-hash',
      generation: 2,
      admission: {
        binding: packageByteBinding(profileDir),
        trees: [{ directory: realpathSync(directory), identity: expected }],
      },
    }
    const channel = Object.assign(new EventEmitter(), {
      send() {
        queueMicrotask(() => channel.emit('message', frame))
      },
    })
    const env = {
      AGNES_PACKAGE_BYTE_ADMISSION: '1',
      AGNES_PROFILE_FILE: file,
      AGNES_WORKER_TOKEN: 'token',
      AGNES_WORKER_GENERATION: '2',
    }
    let owner: Awaited<ReturnType<typeof workerByteAdmission>>
    try {
      owner = await workerByteAdmission(env, home, channel)
      if (!owner) throw new Error('missing worker admission')
      const bytes = owner.owner
      vi.spyOn(fs, 'open').mockRejectedValue(
        Object.assign(new Error('full gate unavailable'), { code: 'EIO' }),
      )
      const first = bytes.boot(owner.admission, async () => {
        expect(await bytes.read(directory, expected)).toBe(digest)
        if (completion === 'reject') throw new Error('assembly rejected')
      })
      if (completion === 'reject') await expect(first).rejects.toThrow('assembly rejected')
      else await first
      expect(channel.listenerCount('message')).toBe(0)
      expect(channel.listenerCount('disconnect')).toBe(0)
      channel.emit('message', frame)
      await expect(bytes.boot(owner.admission, () => bytes.read(directory, expected))).rejects.toThrow(
        'full gate unavailable',
      )
    } finally {
      await owner?.owner.close()
      vi.restoreAllMocks()
      rmSync(home, { recursive: true, force: true })
    }
  },
)
