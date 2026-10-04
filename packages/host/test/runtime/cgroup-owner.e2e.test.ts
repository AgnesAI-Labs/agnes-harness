import { execFileSync, spawn } from 'node:child_process'
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
import { until } from './sandbox-exec-scenarios.js'

describe.skipIf(process.platform !== 'linux')('delegated cgroup hard gates', () => {
  it.each(['missing', 'ordinary-directory', 'ordinary-file'] as const)(
    'refuses %s delegation with zero business effects',
    async (kind) => {
      const directory = mkdtempSync(join(tmpdir(), 'hard-gate-delegation-'))
      let fd: number | undefined
      try {
        const effect = join(directory, 'must-not-exist')
        if (kind === 'ordinary-directory') fd = openSync(directory, 'r')
        if (kind === 'ordinary-file') {
          const file = join(directory, 'not-cgroup')
          writeFileSync(file, 'memory.max')
          fd = openSync(file, 'r')
        }
        await expect(
          runOwnedExecution({
            argv: ['/usr/bin/touch', effect],
            cwd: directory,
            env: {},
            stdin: new Uint8Array(),
            limits,
            ...(fd === undefined ? {} : { cgroupDirectoryFd: fd }),
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow(kind === 'missing' ? 'exec_delegation_unsupported' : 'exec_delegation_invalid')
        expect(existsSync(effect)).toBe(false)
      } finally {
        if (fd !== undefined) closeSync(fd)
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
  it.skipIf(!process.env.AGNES_TEST_CGROUP)(
    'rejects a populated delegated subtree without killing its existing owner',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'hard-gate-populated-'))
      const fd = openSync(process.env.AGNES_TEST_CGROUP ?? '', 'r')
      try {
        const effect = join(directory, 'must-not-exist')
        // CI's runner is a descendant; the domain itself has no direct members.
        expect(readFileSync(join(process.env.AGNES_TEST_CGROUP ?? '', 'cgroup.procs'), 'utf8').trim()).toBe(
          '',
        )
        await expect(
          runOwnedExecution({
            argv: ['/usr/bin/touch', effect],
            cwd: directory,
            env: {},
            stdin: new Uint8Array(),
            limits,
            cgroupDirectoryFd: fd,
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow('exec_delegation_invalid')
        expect(existsSync(effect)).toBe(false)
      } finally {
        closeSync(fd)
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
  // Positive controller proofs and fault injection require an actual kernel delegation.
  it
    .skipIf(!process.env.AGNES_TEST_CGROUP)
    .each(
      (['verified', 'write-failure', 'short-write', 'read-mismatch'] as const).flatMap((mode) =>
        ['memory.max', 'pids.max'].map((control) => ({ mode, control })),
      ),
    )(
    'checks real $control before launch: $mode',
    async ({ mode, control }) => {
      const directory = mkdtempSync(join(tmpdir(), 'hard-gate-kernel-'))
      const group = join(process.env.AGNES_TEST_CGROUP ?? '', `case-${process.pid}-${control}-${mode}`)
      mkdirSync(group)
      const fd = openSync(group, 'r')
      try {
        const binary = join(directory, 'governor'),
          effect = join(directory, 'must-not-exist')
        execFileSync('cc', [
          '-O2',
          '-o',
          binary,
          '-DGOVERNOR_SOURCE="' +
            fileURLToPath(new URL('../../native/exec-governor.c', import.meta.url)) +
            '"',
          fileURLToPath(new URL('./cgroup-fault.c', import.meta.url)),
        ])
        await expect(
          runOwnedExecution({
            argv: ['/usr/bin/touch', effect],
            cwd: directory,
            env: { HARD_GATE_FAULT: mode, HARD_GATE_CONTROL: control },
            stdin: new Uint8Array(),
            limits,
            cgroupDirectoryFd: fd,
            governor: binary,
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow(
          mode === 'verified'
            ? 'exec_limit_cpuMs_unsupported'
            : mode === 'read-mismatch'
              ? 'exec_cgroup_verification_failed'
              : 'exec_cgroup_setup_failed',
        )
        expect(existsSync(effect)).toBe(false)
        expect(readFileSync(join(group, 'cgroup.procs'), 'utf8').trim()).toBe('')
        if (mode === 'verified') {
          for (const [name, value] of [
            ['memory.max', limits.memoryBytes],
            ['memory.swap.max', 0],
            ['pids.max', limits.processes],
            ['memory.oom.group', 1],
          ])
            expect(readFileSync(join(group, String(name)), 'utf8').trim()).toBe(String(value))
        }
      } finally {
        closeSync(fd)
        rmdirSync(group)
        rmSync(directory, { recursive: true, force: true })
      }
    },
    30000,
  )
  it.skipIf(!process.env.AGNES_TEST_CGROUP).each(['memory', 'pids'] as const)(
    'proves the real %s controller covers descendants in a nested group',
    async (resource) => {
      const directory = mkdtempSync(join(tmpdir(), 'hard-gate-tree-'))
      const group = join(process.env.AGNES_TEST_CGROUP ?? '', `case-${process.pid}-${resource}`)
      const leaf = join(group, 'descendants')
      mkdirSync(group)
      const fd = openSync(group, 'r')
      let leafFd: number | undefined
      try {
        // The complete service still refuses: these are controller proofs only.
        const ceiling = { ...limits, memoryBytes: 64 * 1024 * 1024, processes: 2 }
        await expect(
          runOwnedExecution({
            argv: ['/usr/bin/false'],
            cwd: directory,
            env: {},
            stdin: new Uint8Array(),
            limits: ceiling,
            cgroupDirectoryFd: fd,
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow('exec_limit_cpuMs_unsupported')
        writeFileSync(join(group, 'cgroup.subtree_control'), '+memory +pids')
        mkdirSync(leaf)
        leafFd = openSync(leaf, 'r')
        const binary = join(directory, 'probe')
        execFileSync('cc', ['-O2', '-o', binary, fileURLToPath(new URL('./cgroup-tree.c', import.meta.url))])
        const child = spawn(binary, [resource], {
          stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', leafFd],
        })
        let output = ''
        child.stdout?.on('data', (bytes) => {
          output += bytes.toString()
        })
        child.stderr?.resume()
        const ended = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolve({ code, signal }))
        })
        if (resource === 'pids') {
          expect(ended.code).toBe(0)
          expect(output.trim()).toBe('fork-denied')
          expect(
            Number(readFileSync(join(group, 'pids.events'), 'utf8').match(/max (\d+)/u)?.[1]),
          ).toBeGreaterThan(0)
        } else {
          expect(ended.signal).toBe('SIGKILL')
          expect(
            Number(readFileSync(join(group, 'memory.events'), 'utf8').match(/oom_kill (\d+)/u)?.[1]),
          ).toBeGreaterThan(0)
        }
        await until(() => readFileSync(join(group, 'cgroup.events'), 'utf8').includes('populated 0'))
      } finally {
        writeFileSync(join(group, 'cgroup.kill'), '1')
        await until(() => readFileSync(join(group, 'cgroup.events'), 'utf8').includes('populated 0'))
        if (leafFd !== undefined) {
          closeSync(leafFd)
          rmdirSync(leaf)
        }
        closeSync(fd)
        rmdirSync(group)
        rmSync(directory, { recursive: true, force: true })
      }
    },
    30000,
  )
})
