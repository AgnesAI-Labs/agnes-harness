import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runCommand } from '../src/app/subprocess.js'
import { mergeVariables } from '../src/infra/platform.js'
import { workerBin } from '../src/infra/worker-paths.js'
import { writeEnvironment } from '../src/runtime/environment.js'

// What only a real cmd.exe shows: arguments that pass through it and through the gh shim whole, and a shim that keeps
// its changes to itself. The directories hold a space, parentheses and, for the state, characters that are not ASCII.
const windowsIt = it.runIf(process.platform === 'win32')
let root: string
let cli: string
let shims: string
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sa-cmd-')))
  const bin = join(root, 'bin (x86)')
  mkdirSync(bin)
  // The agent CLI: a batch wrapper that runs a Node script, which prints what it received and exits as told.
  const script = join(bin, 'probe.mjs')
  writeFileSync(
    script,
    [
      'const args = process.argv.slice(2)',
      'process.stdout.write(`${JSON.stringify({ args, path: process.env.PATH, token: process.env.GH_TOKEN ?? null })}\\n`)',
      "if (args[0] === 'exit') process.exitCode = Number(args[1])",
      '',
    ].join('\n'),
  )
  cli = join(bin, 'gh-agent.cmd')
  writeFileSync(cli, `@"${process.execPath}" "${script}" %*\r\n`)
  const state = join(root, '状态 (x86)', 'state')
  const config = { login: 'agent-bot', email: 'a@example.invalid', blocked: ['curl'], cli }
  await writeEnvironment(state, config, 'win32', process.env)
  shims = workerBin(state)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The output of the probe CLI. */
type Seen = { args: string[]; path: string; token: string | null }
const seen = (stdout: string): Seen =>
  JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1))
const run = async (argv: string[], env: Record<string, string> = {}) =>
  runCommand(argv, { env, platform: 'win32', signal: new AbortController().signal, timeoutMs: 30_000 })

/** Every character cmd.exe reads specially, a space and parentheses; a quote and a line break are refused. */
const ARGS = [
  'x&y',
  '100%',
  '%PATH%',
  'c^d',
  'e!f',
  'g|h',
  '<i>',
  'with space',
  '(paren)',
  'a;b,c',
  'w*?',
  'back\\',
]

windowsIt(
  'passes every argument whole to a batch CLI, once escaped for cmd.exe and once for the %* it passes on',
  async () => {
    const result = await run([cli, ...ARGS])
    expect(result.code, result.stderr).toBe(0)
    expect(seen(result.stdout).args).toEqual(ARGS)
    await expect(run([cli, 'a"b&c'])).rejects.toThrow('or a quote')
  },
)

windowsIt(
  'passes arguments through the gh shim to the agent CLI, from a state directory that is not ASCII',
  async () => {
    // Through the shim one more cmd.exe pass reads them, inside their quotes.
    const result = await run(['gh', ...ARGS], { PATH: `${shims};${process.env.PATH}` })
    expect(result.code, result.stderr).toBe(0)
    const probe = seen(result.stdout)
    expect(probe.args).toEqual(ARGS)
    expect(probe.path.toLowerCase().split(';')).not.toContain(shims.toLowerCase())
  },
)

windowsIt("keeps its changes from a caller's cmd.exe, and ends with the exit code of a batch CLI", () => {
  const env = mergeVariables(
    [process.env, { PATH: `${shims};${process.env.PATH}`, GH_TOKEN: 'leaked' }],
    'win32',
  )
  // One cmd.exe runs gh twice, then shows its own PATH and token, as an npm script or a `cmd /c` chain would.
  const { stdout: out } = spawnSync(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/v:on', '/s', '/c', '"gh exit 7 & echo rc=!ERRORLEVEL! & gh api user & set PATH & set GH_TOKEN"'],
    { env, encoding: 'utf8', windowsVerbatimArguments: true },
  )
  expect(out).toContain('rc=7')
  const probes = out.split('\n').filter((line) => line.includes('{"args"'))
  expect(probes).toHaveLength(2)
  for (const line of probes) {
    const probe = seen(line)
    expect(probe.token).toBeNull()
    expect(probe.path.toLowerCase().split(';')).not.toContain(shims.toLowerCase())
  }
  const callerPath = out.split(/\r?\n/).find((line) => /^path=/i.test(line)) ?? ''
  expect(callerPath.toLowerCase().split(/[=;]/), 'the caller keeps the shims').toContain(shims.toLowerCase())
  expect(out).toContain('GH_TOKEN=leaked')
})
