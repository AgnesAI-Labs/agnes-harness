// Integration test: compiles the REAL C helper and spawns the REAL compiled binary, unlike
// process-identity-macos.test.ts which only exercises the TS parsing logic against canned
// stdout. Skipped gracefully (not a failure) on any non-darwin platform, or if no C compiler is
// on PATH, since this is a macOS dev/CI-machine concern only.
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { macosProcessIdentity } from '../src/adapters/process-identity-macos.js'

function hasCompiler(): boolean {
  try {
    execFileSync('cc', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const skip = process.platform !== 'darwin' || !hasCompiler()

describe.skipIf(skip)('macosProcessIdentity against the real compiled helper', () => {
  let binary: string
  let workDir: string

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'agnes-macos-process-identity-'))
    binary = join(workDir, 'macos-process-identity')
    const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'macos-process-identity.c')
    execFileSync('cc', ['-O2', '-Wall', '-Wextra', '-o', binary, source])
  })

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  // Ignores the resolved default-location `bin` argument and always runs the freshly compiled
  // temp binary instead, so this test exercises the real C helper regardless of whether
  // `pnpm build:native` has been run against the checked-in packages/host/native/ location.
  const realSpawn = (_bin: string, args: string[]): Promise<{ stdout: string; code: number }> =>
    new Promise((resolve, reject) => {
      execFile(binary, args, { timeout: 2000 }, (error, stdout) => {
        if (error && typeof error.code !== 'number') {
          reject(error)
          return
        }
        resolve({ stdout: stdout.toString(), code: error ? (error.code as number) : 0 })
      })
    })

  it('reports the current test process as alive with a well-formed startId', async () => {
    const result = await macosProcessIdentity(process.pid, { spawn: realSpawn })
    expect(result.state).toBe('alive')
    if (result.state === 'alive') expect(result.startId).toMatch(/^darwin:\d+\.\d{6}:\d+:\d+\.\d{6}$/)
  })

  it('reports a PID confirmed absent via process.kill(pid, 0) as dead (or unknown, never alive)', async () => {
    const candidate = 999_999
    let confirmedAbsent = false
    try {
      process.kill(candidate, 0)
    } catch (error) {
      confirmedAbsent = (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
    // If this specific high PID happens to be in use on the test machine (implausible but not
    // impossible), skip the assertion rather than risk a flaky false failure — the point of this
    // test is "never alive for a confirmed-absent PID", not "999999 is universally free".
    if (!confirmedAbsent) return
    const result = await macosProcessIdentity(candidate, { spawn: realSpawn })
    expect(result.state).not.toBe('alive')
  })
})
