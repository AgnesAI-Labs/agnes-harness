import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runOwnedExecution } from '../../src/runtime/platform/resource-owners.js'
import { limits } from './sandbox-exec-fixture.js'
import { alive, pids, until } from './sandbox-exec-scenarios.js'

describe.skipIf(process.platform !== 'linux')('delegated cgroup execution ownership', () => {
  it('refuses to launch without a delegated cgroup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-owner-'))
    try {
      const effect = join(directory, 'must-not-exist')
      await expect(
        runOwnedExecution({
          argv: ['/usr/bin/touch', effect],
          cwd: directory,
          env: {},
          stdin: new Uint8Array(),
          limits,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('exec_delegation_unsupported')
      expect(existsSync(effect)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.skipIf(!process.env.AGNES_TEST_CGROUP)(
    'kills a setsid double-fork even after it closes all inherited descriptors',
    async () => {
      const delegated = process.env.AGNES_TEST_CGROUP ?? '/missing-delegation',
        group = join(delegated, `case-${process.pid}`)
      const directory = mkdtempSync(join(tmpdir(), 'runtime-owner-'))
      mkdirSync(group)
      const fd = openSync(group, 'r')
      try {
        const binary = join(directory, 'orphan'),
          trace = join(directory, 'pids')
        execFileSync('cc', ['-O2', '-o', binary, fileURLToPath(new URL('./orphan-probe.c', import.meta.url))])
        const result = await runOwnedExecution({
          argv: [binary, trace, 'close-all'],
          cwd: directory,
          env: {},
          stdin: new Uint8Array(),
          limits,
          cgroupDirectoryFd: fd,
          signal: new AbortController().signal,
        })
        expect(result.metrics.ownership).toBe('strong')
        expect(result.metrics.ownershipVerified).toBe(true)
        expect(result.metrics.reason).not.toBe('completed')
        expect(result.metrics.remaining).toBe(0)
        expect(pids(trace)).toHaveLength(1)
        expect(readFileSync(join(group, 'cgroup.procs'), 'utf8').trim()).toBe('')
        await until(() => pids(trace).every((pid) => !alive(pid)))
      } finally {
        try {
          writeFileSync(join(group, 'cgroup.kill'), '1')
          await until(() => readFileSync(join(group, 'cgroup.procs'), 'utf8').trim() === '')
        } finally {
          closeSync(fd)
          rmdirSync(group)
          rmSync(directory, { recursive: true, force: true })
        }
      }
    },
    30000,
  )
})
