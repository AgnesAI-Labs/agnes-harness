import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../../', import.meta.url))
const pin = readFileSync(join(root, '.node-version'), 'utf8').trim()
const { packageManager } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const fix = 'mise install && mise exec -- node tools/toolchain/run.mjs'

function fail(message) {
  throw new Error(`Toolchain mismatch: ${message}\nFix from the repository root: ${fix}`)
}

export function assertRuntime(runtime, expected = { version: `v${pin}`, execPath: process.execPath }) {
  if (
    runtime.version !== expected.version ||
    realpathSync(runtime.execPath) !== realpathSync(expected.execPath)
  )
    fail(`expected ${JSON.stringify(expected)}, actual ${JSON.stringify(runtime)}`)
}

// Only verification/build subprocesses receive this PATH. Never change the shell, global Node,
// daemon environment, user-project commands or external MCP launch configuration.
export function verificationEnvironment(source = process.env) {
  const env = { ...source }
  const keys = Object.keys(env)
    .filter((name) => name.toLowerCase() === 'path')
    .sort()
  const inherited = env[keys[0]] ?? ''
  // Windows treats these keys as equivalent; leaving both can select the stale value at spawn.
  for (const key of keys) delete env[key]
  return { ...env, PATH: `${dirname(process.execPath)}${delimiter}${inherited}` }
}

// Run JavaScript with the selected executable, bypassing pnpm/Corepack shebangs and shell shims.
export function pnpmInvocation(env = process.env) {
  if (env.npm_execpath && /[/\\]pnpm\.[cm]?js$/.test(env.npm_execpath) && existsSync(env.npm_execpath))
    return [env.npm_execpath]
  const bin = dirname(process.execPath)
  const corepack = [
    join(bin, '../lib/node_modules/corepack/dist/corepack.js'),
    join(bin, 'node_modules/corepack/dist/corepack.js'),
  ].find(existsSync)
  if (!corepack) fail('Corepack is missing beside Node; provision Corepack or use the CI pnpm setup')
  return [corepack, 'pnpm']
}

/** Windows cannot exec npm.cmd directly; keep the selected Node and literal argv. */
export function npmCommand() {
  if (process.platform !== 'win32') return { bin: 'npm', args: [] } // guards-allow-platform: verification npm launch leaf.
  const cli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  if (!existsSync(cli)) throw new Error('Windows verification requires Node with bundled npm')
  return { bin: process.execPath, args: [cli] }
}

export function checkToolchain(env = process.env) {
  const runtime = { version: process.version, execPath: process.execPath }
  assertRuntime(runtime)
  const args = pnpmInvocation(env)
  const run = (...argv) => {
    try {
      return execFileSync(process.execPath, [...args, ...argv], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    } catch {
      // A stale Node may not even support the probe's flags. Still give the standard repair,
      // without printing package-manager stderr that could contain private registry settings.
      fail(`could not run ${packageManager} ${argv[0] === '--version' ? '--version' : 'test-runner probe'}`)
    }
  }
  const actual = run('--version')
  if (`pnpm@${actual}` !== packageManager) fail(`expected ${packageManager}, actual pnpm@${actual}`)
  // Exercise pnpm, PATH resolution and an actual test-runner child, even before pnpm install.
  const output = run(
    'exec',
    'node',
    '--test',
    '--test-isolation=process',
    '--test-reporter=tap',
    fileURLToPath(new URL('./runtime-probe.test.mjs', import.meta.url)),
  )
  const reported = /^# AGH_TOOLCHAIN_RUNTIME (\{[^\n]+\})\r?$/m.exec(output)?.[1]
  if (!reported) fail('the test-runner child did not report its runtime')
  const child = JSON.parse(reported)
  assertRuntime(child)
  process.stdout.write(
    `Toolchain OK ${JSON.stringify(runtime)} ${packageManager}; runner ${JSON.stringify(child)}\n`,
  )
  return { runtime, child, packageManager }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkToolchain()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
