import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packageByteBinding } from '@agnes/package-manager'
import { expect, it, vi } from 'vitest'
import { workerByteAdmission } from '../src/package-byte-admission.js'

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
