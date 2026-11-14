import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { childEnvironment, runCommand } from '../src/app/subprocess.js'

let directory: string
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'subprocess-')))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})
const run = (argv: string[], overrides: Partial<Parameters<typeof runCommand>[1]> = {}) =>
  runCommand(argv, { signal: new AbortController().signal, timeoutMs: 10_000, ...overrides })
const node = (script: string): string[] => [process.execPath, '-e', script]

it('returns the exit code and both output streams, from the given working directory', async () => {
  const result = await run(
    node('process.stdout.write(process.cwd()); process.stderr.write("warn"); process.exit(3)'),
    { cwd: directory },
  )
  expect(result).toEqual({ code: 3, stdout: directory, stderr: 'warn' })
})

it('gives the child no standard input', async () => {
  const result = await run(
    node('process.stdin.on("end", () => process.stdout.write("closed")); process.stdin.resume()'),
  )
  expect(result).toEqual({ code: 0, stdout: 'closed', stderr: '' })
})

it('removes variables named like credentials, whether inherited or passed, and keeps the others', async () => {
  process.env.SUPERAGENT_TEST_API_KEY = 'inherited'
  try {
    const result = await run(
      node(
        'process.stdout.write(JSON.stringify(Object.keys(process.env).filter((name) => name.startsWith("SA_") || name.startsWith("SUPERAGENT_TEST_")).sort()))',
      ),
      { env: { SA_PLAIN: '1', SA_DB_PASSWORD: 'x', SA_client_secret: 'x', GH_TOKEN: 'x', SA_TOKENISH: 'x' } },
    )
    expect(JSON.parse(result.stdout)).toEqual(['SA_PLAIN'])
    expect(Object.keys(childEnvironment({ A_KEY: 'x', B: 'y' }))).toContain('B')
    expect(Object.keys(childEnvironment({ A_KEY: 'x' }))).not.toContain('A_KEY')
  } finally {
    delete process.env.SUPERAGENT_TEST_API_KEY
  }
})

it('lets passed variables replace inherited ones', async () => {
  process.env.SA_OVERRIDE = 'inherited'
  try {
    const result = await run(node('process.stdout.write(process.env.SA_OVERRIDE ?? "")'), {
      env: { SA_OVERRIDE: 'passed' },
    })
    expect(result.stdout).toBe('passed')
  } finally {
    delete process.env.SA_OVERRIDE
  }
})

it('stops a process that outlives its deadline, and one whose signal aborts, with code -1', async () => {
  const sleeper = node('setInterval(() => {}, 1000)')
  expect((await run(sleeper, { timeoutMs: 100 })).code).toBe(-1)
  const controller = new AbortController()
  const started = Date.now()
  const running = run(sleeper, { signal: controller.signal, timeoutMs: 60_000 })
  setTimeout(() => controller.abort(), 100)
  expect((await running).code).toBe(-1)
  expect(Date.now() - started).toBeLessThan(5000)
  const aborted = new AbortController()
  aborted.abort()
  expect(await run(sleeper, { signal: aborted.signal })).toEqual({ code: -1, stdout: '', stderr: '' })
})

it('keeps the start of output beyond its limit and still lets the process finish', async () => {
  const result = await run(
    node('process.stdout.write("a".repeat(2 * 1024 * 1024)); process.stderr.write("b".repeat(200000))'),
  )
  expect(result.code).toBe(0)
  expect([result.stdout.length, result.stderr.length]).toEqual([1 << 20, 1 << 16])
})

it('rejects a program that cannot start, and an empty command', async () => {
  await expect(run([join(directory, 'missing')])).rejects.toThrow('ENOENT')
  await expect(run([])).rejects.toThrow('needs a program')
})

/** True while a process with this id exists. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const gone = async (pid: number): Promise<boolean> => {
  for (let tries = 0; tries < 40; tries++) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}
// A shell that starts a background grandchild, prints its id, and waits for it.
const withGrandchild = ['sh', '-c', 'sleep 30 & echo $!; wait']

it('stops the whole process group at the deadline, so a grandchild holding the pipes cannot hang the call', async () => {
  const started = Date.now()
  const result = await run(withGrandchild, { timeoutMs: 300 })
  expect(result.code).toBe(-1)
  expect(Date.now() - started).toBeLessThan(5000)
  const grandchild = Number(result.stdout.trim())
  expect(grandchild).toBeGreaterThan(0)
  expect(await gone(grandchild)).toBe(true)
})

it('stops the whole process group when the signal aborts', async () => {
  const controller = new AbortController()
  const started = Date.now()
  const running = run(withGrandchild, { signal: controller.signal, timeoutMs: 60_000 })
  setTimeout(() => controller.abort(), 300)
  const result = await running
  expect(result.code).toBe(-1)
  expect(Date.now() - started).toBeLessThan(5000)
  expect(await gone(Number(result.stdout.trim()))).toBe(true)
})

it('returns once the process has exited even if a grandchild it left behind keeps the pipes open', async () => {
  const started = Date.now()
  const result = await run(['sh', '-c', 'sleep 30 & echo $!'], { timeoutMs: 60_000 })
  const grandchild = Number(result.stdout.trim())
  try {
    expect(result.code).toBe(0)
    expect(Date.now() - started).toBeLessThan(5000)
  } finally {
    process.kill(grandchild, 'SIGKILL')
  }
})
