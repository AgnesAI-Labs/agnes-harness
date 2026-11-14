import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { childEnvironment, runCommand, setAgentVariables } from '../src/app/subprocess.js'

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

/** Sets `variables` in this process for the duration of `body`, then restores the previous values. */
async function withParentEnv(variables: Record<string, string>, body: () => Promise<void>): Promise<void> {
  const before = Object.fromEntries(Object.keys(variables).map((name) => [name, process.env[name]]))
  Object.assign(process.env, variables)
  try {
    await body()
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

it("keeps the daemon's git and gh configuration variables out of the runtime's own git, gh and prepare commands", async () => {
  const repo = join(directory, 'repo')
  await run(['git', 'init', '-q', repo])
  await withParentEnv(
    {
      // A count without its key makes every git that reads configuration fail ("missing config key").
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_VALUE_0: 'x',
      GIT_CONFIG_PARAMETERS: "'credential.helper'='operator'",
      GIT_CONFIG_GLOBAL: join(directory, 'operator-gitconfig'),
      GIT_DIR: join(directory, 'elsewhere'),
      GIT_AUTHOR_NAME: 'OPERATOR',
      GIT_COMMITTER_EMAIL: 'operator@example.invalid',
      GH_CONFIG_DIR: join(directory, 'operator-gh'),
      GH_HOST: 'ghe.example.invalid',
      SSH_ASKPASS: '/operator/askpass',
      GIT_ASKPASS: '/operator/askpass',
      GIT_TERMINAL_PROMPT: '1',
    },
    async () => {
      const listed = await run(['git', 'config', '--list', '--show-origin'], { cwd: repo })
      expect(listed.stderr).toBe('')
      expect(listed.code).toBe(0)
      expect(listed.stdout).not.toContain('operator')
      const seen = await run(
        node(
          'process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(GIT_|GH_|SSH_ASKPASS)/.test(name)))))',
        ),
      )
      const child = JSON.parse(seen.stdout) as Record<string, string>
      expect(child).toMatchObject({ GIT_ASKPASS: '', GIT_TERMINAL_PROMPT: '0' })
      for (const name of [
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_VALUE_0',
        'GIT_CONFIG_PARAMETERS',
        'GIT_CONFIG_GLOBAL',
        'GIT_DIR',
        'GIT_AUTHOR_NAME',
        'GIT_COMMITTER_EMAIL',
        'GH_CONFIG_DIR',
        'GH_HOST',
        'SSH_ASKPASS',
      ])
        expect(child, name).not.toHaveProperty(name)
    },
  )
})

it("runs the runtime's commands with the agent HOME and gh configuration once they are set, and without after", async () => {
  const read = async () =>
    JSON.parse(
      (
        await run(
          node(
            'process.stdout.write(JSON.stringify({ home: process.env.HOME, gh: process.env.GH_CONFIG_DIR ?? null }))',
          ),
        )
      ).stdout,
    )
  setAgentVariables({ HOME: '/state/home', GH_CONFIG_DIR: '/state/home/.config/gh' })
  try {
    expect(await read()).toEqual({ home: '/state/home', gh: '/state/home/.config/gh' })
    expect(childEnvironment({ HOME: '/passed' }).HOME, 'a caller may still pass its own').toBe('/passed')
  } finally {
    setAgentVariables(undefined)
  }
  expect(await read()).toEqual({ home: process.env.HOME, gh: null })
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
