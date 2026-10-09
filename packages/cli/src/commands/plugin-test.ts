import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { createPlatform } from '@agnes/host'
import type { MainIO } from '../bin.js'
import { UsageError } from '../errors.js'

export function pluginTestInvocation(args: readonly string[], cwd: string) {
  if (args[0] !== 'test') throw new UsageError('usage: agh plugin test [folder] [-- <test-runner args>]')
  const separator = args.indexOf('--')
  const positionals = args.slice(1, separator < 0 ? args.length : separator)
  if (positionals.length > 1 || positionals.some((arg) => arg.startsWith('-')))
    throw new UsageError('usage: agh plugin test [folder] [-- <test-runner args>]')
  return {
    directory: resolve(cwd, positionals[0] ?? '.'),
    runnerArgs: separator < 0 ? [] : args.slice(separator + 1),
  }
}

/** Credentials and Node injection options are not inherited by author tests. */
export function pluginTestEnvironment(source: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'COMSPEC',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
  ])
    if (source[name] !== undefined) env[name] = source[name]
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    AGH_HOME: join(home, '.agh'),
    npm_config_cache: join(home, '.npm'),
    npm_config_userconfig: join(home, '.npmrc'),
    npm_config_offline: 'true',
  }
}

async function npmCommand(env: NodeJS.ProcessEnv) {
  if (createPlatform().os !== 'win32') return { executable: 'npm', prefix: [] as string[] }
  // Execute npm's JS entry with Node; never interpolate runner arguments into cmd.exe.
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!directory) continue
    const entry = join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    try {
      await access(entry)
      return { executable: 'node', prefix: [entry] }
    } catch {}
  }
  throw new Error('Plugin tests require Node and npm on PATH')
}

/** Thin local wrapper: use the author's installed test runner and propagate its exit code. */
export async function runPluginTests(
  args: readonly string[],
  io: Pick<MainIO, 'cwd' | 'env' | 'stdout' | 'stderr'>,
): Promise<number> {
  const { directory, runnerArgs } = pluginTestInvocation(args, io.cwd)
  const manifest: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const scripts = (manifest as { scripts?: { test?: unknown } } | null)?.scripts
  if (typeof scripts?.test !== 'string' || !scripts.test.trim())
    throw new UsageError(
      'Plugin package needs a scripts.test command and installed author testkit dependencies',
    )
  const home = await mkdtemp(join(tmpdir(), 'agh-plugin-test-'))
  try {
    await writeFile(join(home, '.npmrc'), '', { mode: 0o600 })
    const command = await npmCommand(io.env)
    return await new Promise<number>((resolveExit, reject) => {
      const child = spawn(
        command.executable,
        [...command.prefix, '--offline', '--ignore-scripts', 'run', 'test', '--', ...runnerArgs],
        {
          cwd: directory,
          env: pluginTestEnvironment(io.env, home),
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        },
      )
      child.stdout?.on('data', (chunk: Buffer) => io.stdout.write(chunk))
      child.stderr?.on('data', (chunk: Buffer) => io.stderr.write(chunk))
      child.once('error', reject)
      child.once('close', (code, signal) => resolveExit(code ?? (signal ? 130 : 1)))
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
