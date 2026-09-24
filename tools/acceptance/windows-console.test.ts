import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const windows = process.platform === 'win32' // guards-allow-platform: real Windows ConPTY acceptance.
const python = process.env.AGNES_TEST_PYTHON ?? 'python'
const driver = resolve('tools/test-fixtures/windows-console.py')
const execution = pathToFileURL(resolve('packages/resource-control-cli/src/execution.ts')).href

function run(script: string, options: string[] = [], nodeArgs: string[] = []) {
  const result = spawnSync(
    python,
    [
      '-I',
      '-X',
      'utf8',
      driver,
      '--timeout',
      '8',
      ...options,
      '--',
      process.execPath,
      ...nodeArgs,
      '-e',
      script,
    ],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 },
  )
  expect(result.error, `${python}: ${result.error?.message}`).toBeUndefined()
  expect(result.signal, result.stderr).toBeNull()
  return result
}

describe.skipIf(!windows)('real Windows console test driver', () => {
  it('provides real terminal handles, Unicode output and the actual exit code', () => {
    const result = run("console.log('终端', process.stdin.isTTY, process.stdout.isTTY); process.exitCode = 7")
    expect(result.status, result.stderr).toBe(7)
    expect(result.stdout).toContain('终端 true true')
  })

  it.each(['y', 'n'])('answers the production resource confirmation with %s', (reply) => {
    const result = run(
      `import { confirmResourceOperation } from ${JSON.stringify(execution)};
       console.log('CONFIRMED', await confirmResourceOperation(process, 'Fixture only'));`,
      ['--expect', 'Continue? [y/N]', '--reply', reply],
      ['--import', 'tsx', '--input-type=module'],
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`CONFIRMED ${reply === 'y'}`)
  })

  it('does not report confirmation when the expected prompt never appeared', () => {
    const result = run("console.log('No question')", ['--expect', 'Continue? [y/N]'])
    expect(result.status).toBe(125)
    expect(result.stderr).toContain('expected prompt was not observed')
  })

  it('times out and terminates the attached process', () => {
    const result = run("console.log('CHILD_PID=' + process.pid); setInterval(() => {}, 1000)", [
      '--timeout',
      '1',
    ])
    expect(result.status, result.stderr).toBe(124)
    const pid = Number(result.stdout.match(/CHILD_PID=(\d+)/)?.[1])
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('fails promptly and closes console pipes when the executable is missing', () => {
    const result = spawnSync(
      python,
      ['-I', '-X', 'utf8', driver, '--', resolve('missing-console-fixture.exe')],
      {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true,
      },
    )
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('WinError 2')
  })
})
