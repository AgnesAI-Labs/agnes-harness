// Manual benchmark, never a CI gate. Start the daemon for an isolated home first, then run:
// node tools/bench-cli-session-list.mjs --home <home> --entry packages/cli/dist/local/agnes.mjs
// For source runs add --source --entry packages/cli/src/bin.ts (requires installed dependencies).
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const flags = new Map()
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i]
  if (flag === '--source') flags.set(flag, true)
  else if (['--home', '--entry', '--profile', '--cwd', '--runs'].includes(flag)) {
    const value = process.argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    flags.set(flag, value)
  } else throw new Error(`unknown argument ${flag}`)
}
if (!flags.has('--home')) throw new Error('--home must select the already running daemon')
const home = resolve(flags.get('--home'))
const entry = resolve(flags.get('--entry') ?? 'packages/cli/dist/local/agnes.mjs')
const cwd = resolve(flags.get('--cwd') ?? process.cwd())
const profile = flags.get('--profile') ?? 'local-dev'
const runs = Number(flags.get('--runs') ?? 10)
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer')
const discoveryPath = join(home, 'daemon', 'discovery.json')
async function generation() {
  const discovery = JSON.parse(await readFile(discoveryPath, 'utf8'))
  const owner = JSON.parse(await readFile(join(home, 'daemon', 'owner.json'), 'utf8'))
  if (!discovery.ready || discovery.profile !== profile || discovery.owner.generation !== owner.generation)
    throw new Error('start a ready daemon for the selected home/profile before benchmarking')
  process.kill(owner.pid, 0)
  return owner.generation
}
const initial = await generation()
async function sample() {
  if ((await generation()) !== initial) throw new Error('daemon generation changed')
  const started = performance.now()
  const output = await new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [...(flags.has('--source') ? ['--import', 'tsx'] : []), entry, 'sessions', '--json'],
      {
        cwd,
        env: { ...process.env, AGH_HOME: home, AGNES_PROFILE: profile },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', fail)
    child.once('exit', (code) =>
      code === 0 ? done(stdout) : fail(new Error(`CLI exited ${code}: ${stderr}`)),
    )
  })
  const elapsed = performance.now() - started
  const page = JSON.parse(output)
  if (!Array.isArray(page.items)) throw new Error('CLI did not return a session page')
  if ((await generation()) !== initial) throw new Error('daemon restarted during measurement')
  return elapsed
}
await sample() // Warm process/module and filesystem caches, outside the reported samples.
const samplesMs = []
for (let i = 0; i < runs; i++) samplesMs.push(await sample())
const sorted = [...samplesMs].sort((a, b) => a - b)
console.log(
  JSON.stringify(
    {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      runs,
      command: 'agh sessions --json',
      source: flags.has('--source'),
      samplesMs,
      medianMs: sorted[Math.floor(runs / 2)],
      minMs: sorted[0],
      p95Ms: sorted[Math.ceil(runs * 0.95) - 1],
    },
    null,
    2,
  ),
)
