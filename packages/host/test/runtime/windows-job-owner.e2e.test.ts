import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  referenceWindowsOwnerPath,
  runReferenceWindowsExecution,
} from '../../../../examples/runtime-reference/src/providers/exec.js'
import { runWindowsJobExecution, windowsGovernorPath } from '../../src/runtime/platform/windows-job-owner.js'

let directory: string
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'agnes-windows-job-'))
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))
it('decodes injected File-only tables and fails closed on missing or truncated snapshots', () => {
  const executable = join(directory, process.platform === 'win32' ? 'snapshot.exe' : 'snapshot')
  const source = fileURLToPath(new URL('./windows-file-snapshot-fixture.cc', import.meta.url))
  if (process.platform === 'win32') {
    const environment = { ...process.env }
    delete environment.CL
    execFileSync(
      process.env.AGNES_WINDOWS_CL ?? 'cl.exe',
      [
        '/nologo',
        '/EHsc',
        '/W4',
        '/WX',
        '/std:c++17',
        '/Fo' + join(directory, 'snapshot.obj'),
        '/Fe' + executable,
        source,
      ],
      { env: environment, stdio: 'pipe' },
    )
  } else execFileSync('c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', source, '-o', executable])
  execFileSync(executable, [], { timeout: 5000 })
})
const limits = {
  cpuMs: 8000,
  wallMs: 10000,
  memoryBytes: 536870912,
  outputBytes: 65536,
  processes: 16,
}
const implementations = [
  ['default', runWindowsJobExecution, windowsGovernorPath],
  ['reference', runReferenceWindowsExecution, referenceWindowsOwnerPath],
] as const
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function assertDead(path: string) {
  const pids = readFileSync(path, 'utf8').trim().split(/\r?\n/u).map(Number)
  expect(pids.length).toBeGreaterThan(0)
  for (const pid of pids) expect(() => process.kill(pid, 0), 'surviving process ' + pid).toThrow()
  return pids.length
}
describe.skipIf(process.platform !== 'win32')(
  'real Windows Job qualification (not service conformance)',
  () => {
    let workload: string
    beforeAll(() => {
      workload = join(directory, 'workload.exe')
      const environment = { ...process.env }
      delete environment.CL
      execFileSync(
        process.env.AGNES_WINDOWS_CL ?? 'cl.exe',
        [
          '/nologo',
          '/EHsc',
          '/W4',
          '/WX',
          '/O2',
          '/std:c++17',
          '/Fo' + join(directory, 'workload.obj'),
          '/Fe' + workload,
          fileURLToPath(new URL('./windows-job-workload.cc', import.meta.url)),
        ],
        { env: environment, stdio: 'pipe' },
      )
      for (const [, , path] of implementations) expect(existsSync(path())).toBe(true)
    })
    describe.each(implementations)('%s native backend', (name, run, path) => {
      const request = (
        mode: string,
        patch: Partial<typeof limits> = {},
        signal = new AbortController().signal,
        fileMode: 'files' | 'five-limits' = 'five-limits',
      ) => {
        const trace = join(directory, name + '-' + mode + '-' + Date.now() + '.txt')
        return {
          trace,
          input: {
            argv: [workload, mode, trace],
            cwd: directory,
            env: process.env as Record<string, string>,
            stdin: new Uint8Array(),
            limits: { ...limits, ...patch },
            signal,
            fileMode,
          },
        }
      }
      it('executes Unicode argv, exact stdin and separate output streams', async () => {
        const text = '空 白 " \\'
        const result = await run({
          argv: [
            process.execPath,
            '-e',
            'process.stdin.on("data",b=>process.stdout.write(b));process.stderr.write(process.argv[1])',
            text,
          ],
          cwd: directory,
          env: process.env as Record<string, string>,
          stdin: Buffer.from(text),
          limits,
          signal: new AbortController().signal,
          fileMode: 'five-limits',
        })
        expect(Buffer.from(result.stdout).toString()).toBe(text)
        expect(Buffer.from(result.stderr).toString()).toBe(text)
        expect(result.metrics).toMatchObject({
          reason: 'completed',
          ownership: 'strong',
          remaining: 0,
          ownershipVerified: true,
          filesEnforced: false,
        })
      })
      it.each([
        ['cpu', 'cpuMs', { cpuMs: 200 }],
        ['wall', 'wallMs', { wallMs: 300 }],
        ['memory', 'memoryBytes', { memoryBytes: 67108864 }],
        ['output', 'outputBytes', { outputBytes: 1024 }],
        ['processes', 'processes', { processes: 3 }],
      ] as const)(
        'enforces %s and observes an empty Job independently of the root exit',
        async (mode, reason, patch) => {
          const job = request(mode, patch)
          const result = await run(job.input)
          expect(result.metrics).toMatchObject({ reason, remaining: 0, ownershipVerified: true })
          expect(result.stdout.byteLength + result.stderr.byteLength).toBeLessThanOrEqual(
            job.input.limits.outputBytes,
          )
          assertDead(job.trace)
        },
        20000,
      )
      it('denies breakaway and cleans children that close every standard handle', async () => {
        const attempt = request('breakaway')
        const result = await run(attempt.input)
        expect(Buffer.from(result.stdout).toString()).toBe('blocked')
        assertDead(attempt.trace)
        const family = request('descendants')
        const tree = await run(family.input)
        expect(tree.metrics).toMatchObject({ reason: 'residual', remaining: 0, ownershipVerified: true })
        expect(assertDead(family.trace)).toBe(2)
      })
      it('never resumes a command whose startup memory already exceeds its ceiling', async () => {
        const tiny = request('wall', { memoryBytes: 1 })
        try {
          const result = await run(tiny.input)
          expect(result.metrics).toMatchObject({
            reason: 'memoryBytes',
            remaining: 0,
            ownershipVerified: true,
          })
        } catch (error) {
          // Atomic Job-list creation or assignment may itself reject the initial commitment.
          expect(String(error)).toContain('exec_runner_unavailable')
        }
        expect(existsSync(tiny.trace)).toBe(false)
      })
      it('terminates the Job on cancellation and caller pipe EOF', async () => {
        const abort = new AbortController(),
          job = request('wall', {}, abort.signal)
        const result = run(job.input)
        await pause(150)
        abort.abort()
        expect((await result).metrics.reason).toBe('cancel')
        assertDead(job.trace)
        const cold = request('wall')
        const owner = spawn(
          path(),
          [limits.cpuMs, limits.wallMs, limits.memoryBytes, limits.outputBytes, limits.processes]
            .map(String)
            .concat('five-limits', ...cold.input.argv),
          { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] },
        )
        const framed = Buffer.alloc(4)
        owner.stdin.write(framed)
        owner.stdout.resume()
        owner.stderr.resume()
        for (let attempt = 0; attempt < 200 && !existsSync(cold.trace); ++attempt) await pause(10)
        expect(existsSync(cold.trace)).toBe(true)
        const done = new Promise<number | null>((resolve, reject) => {
          owner.once('close', resolve)
          owner.once('error', reject)
        })
        owner.stdin.end()
        expect(await done).toBe(0)
        assertDead(cold.trace)
        const killed = request('wall')
        const caller = spawn(
          process.execPath,
          [
            fileURLToPath(new URL('./windows-owner-caller.mjs', import.meta.url)),
            path(),
            workload,
            killed.trace,
          ],
          { cwd: directory, stdio: 'ignore', windowsHide: true },
        )
        const callerClosed = new Promise((resolve, reject) => {
          caller.once('close', resolve)
          caller.once('error', reject)
        })
        try {
          for (let attempt = 0; attempt < 200 && !existsSync(killed.trace); ++attempt) await pause(10)
          expect(existsSync(killed.trace)).toBe(true)
          caller.kill('SIGKILL')
          await callerClosed
          for (let attempt = 0; attempt < 300; ++attempt) {
            const pid = Number(readFileSync(killed.trace, 'utf8').trim())
            try {
              process.kill(pid, 0)
            } catch {
              break
            }
            await pause(10)
          }
          assertDead(killed.trace)
        } finally {
          caller.kill('SIGKILL')
        }
        const abandoned = request('family')
        const supervisor = spawn(
          path(),
          [...Object.values(limits).map(String), 'five-limits', ...abandoned.input.argv],
          { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
        )
        const exited = new Promise((resolve, reject) => {
          supervisor.once('close', resolve)
          supervisor.once('error', reject)
        })
        supervisor.stdin.on('error', () => {})
        supervisor.stdin.write(Buffer.alloc(4))
        supervisor.stdout.resume()
        supervisor.stderr.resume()
        try {
          let members: number[] = []
          for (let attempt = 0; attempt < 300; ++attempt) {
            if (existsSync(abandoned.trace))
              members = readFileSync(abandoned.trace, 'utf8').trim().split(/\r?\n/u).map(Number)
            if (members.length === 2) break
            await pause(10)
          }
          expect(members.length).toBe(2)
          supervisor.kill('SIGKILL')
          await exited
          for (let attempt = 0; attempt < 300; ++attempt) {
            const alive = members.some((pid) => {
              try {
                process.kill(pid, 0)
                return true
              } catch {
                return false
              }
            })
            if (!alive) break
            await pause(10)
          }
          expect(assertDead(abandoned.trace)).toBe(2)
        } finally {
          supervisor.kill('SIGKILL')
        }
      }, 20000)
      it('refuses File-constrained execution regardless of diagnostic query capability', async () => {
        const ordinary = JSON.parse(
          execFileSync(path(), ['--probe-files'], { encoding: 'utf8', timeout: 10000 }),
        ) as { fileHandles: boolean }
        const lowProbe = spawnSync(path(), ['--probe-files-low'], { encoding: 'utf8', timeout: 10000 })
        expect([0, 125]).toContain(lowProbe.status)
        const reduced = JSON.parse(lowProbe.stdout) as {
          fileHandles: boolean
          restrictedTokenApplied: boolean
        }
        expect(typeof ordinary.fileHandles).toBe('boolean')
        expect(typeof reduced.restrictedTokenApplied).toBe('boolean')
        if (lowProbe.status === 125)
          expect(reduced).toMatchObject({ restrictedTokenApplied: false, fileHandles: false })
        const files = request('wall', {}, new AbortController().signal, 'files')
        await expect(run(files.input)).rejects.toThrow('exec_limit_openFiles_unsupported')
        expect(existsSync(files.trace)).toBe(false)
        const rejected = spawnSync(
          path(),
          [...Object.values(limits).map(String), '256', 'files', ...files.input.argv],
          {
            cwd: directory,
            input: Buffer.alloc(4),
            encoding: 'utf8',
            timeout: 10000,
          },
        )
        expect(rejected.status).toBe(125)
        expect(JSON.parse(rejected.stdout)).toEqual({
          kind: 'refusal',
          detailCode: 'exec_limit_openFiles_unsupported',
        })
        expect(existsSync(files.trace)).toBe(false)
        console.info(
          JSON.stringify({ backend: name, ordinary, reduced, hardFileLimit: false, serviceQualified: false }),
        )
      })
      it.each(['cpuMs', 'wallMs', 'memoryBytes', 'outputBytes', 'processes'] as const)(
        'keeps native zero %s literal instead of unlimited',
        (field) => {
          const denied = request('wall', { [field]: 0 })
          const result = spawnSync(
            path(),
            [...Object.values(denied.input.limits).map(String), 'five-limits', ...denied.input.argv],
            {
              cwd: directory,
              input: Buffer.alloc(4),
              encoding: 'utf8',
              timeout: 10000,
            },
          )
          expect(result.status).toBe(125)
          expect(JSON.parse(result.stdout)).toEqual({ kind: 'refusal', detailCode: 'exec_resource_bounds' })
          expect(existsSync(denied.trace)).toBe(false)
        },
      )
    })
  },
)
