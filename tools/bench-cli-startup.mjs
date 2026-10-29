// Manual benchmark, never a CI gate. Measures CLI startup in an isolated temp home:
//   node tools/bench-cli-startup.mjs [--runs 10] [--json] [--entry <agnes.mjs>] [--launcher <bin/agh>] [--skip-session]
// Build first: pnpm --filter @agnes/cli build:local. It never touches ~/.agh: everything runs under a
// fresh AGH_HOME, the daemon it starts is stopped and the home deleted before it exits.
// Rows: --version and --help through the launcher and straight on the entry (wall time); `-p` to the
// first token with a cold and a warm daemon, and the TUI first frame / composer-ready (AGH_TIMING
// marks, milliseconds from process start). `-p` and TUI use a loopback provider and need python3.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const repo = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const flags = new Map()
for (let i = 0; i < args.length; i++) {
  const flag = args[i]
  if (['--json', '--skip-session', '--child'].includes(flag)) flags.set(flag, true)
  else if (['--runs', '--entry', '--launcher'].includes(flag)) {
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    flags.set(flag, value)
  } else throw new Error(`unknown argument ${flag}`)
}
const runs = Number(flags.get('--runs') ?? 10)
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer')
const entry = resolve(flags.get('--entry') ?? join(repo, 'packages/cli/dist/local/agnes.mjs'))
const launcher = resolve(flags.get('--launcher') ?? join(repo, 'packages/cli/bin/agh'))
if (!existsSync(entry)) throw new Error(`missing ${entry}; run: pnpm --filter @agnes/cli build:local`)

// The provider setup talks to the daemon through the workspace SDK, which ships as TypeScript.
if (!flags.has('--skip-session') && !flags.has('--child')) {
  const tsx = import.meta.resolve('tsx')
  const result = spawnSync(process.execPath, ['--import', tsx, import.meta.filename, '--child', ...args], {
    stdio: 'inherit',
  })
  process.exit(result.status ?? 1)
}

const root = mkdtempSync('/tmp/agh-bench-startup-') // short: the daemon socket path has a length limit
const home = join(root, 'home')
const workspace = join(root, 'workspace')
mkdirSync(home, { mode: 0o700 })
mkdirSync(workspace)
const env = { ...process.env, AGH_HOME: home, HOME: root, LANG: 'en_US.UTF-8' }
for (const name of ['AGH_TIMING', 'AGH_TIMING_ORIGIN', 'NODE_OPTIONS']) delete env[name]

const sorted = (values) => [...values].sort((a, b) => a - b)
const median = (values) => sorted(values)[Math.floor(values.length / 2)]
const p90 = (values) => sorted(values)[Math.min(values.length - 1, Math.ceil(values.length * 0.9) - 1)]
const round = (value) => Math.round(value * 10) / 10

function run(argv, options = {}) {
  return new Promise((done) => {
    const started = performance.now()
    const child = spawn(process.execPath, argv, {
      cwd: workspace,
      env: { ...env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('exit', (code) => done({ code, ms: performance.now() - started, stdout, stderr }))
  })
}

function marks(text) {
  const out = {}
  for (const match of text.matchAll(/agh-timing (\S+) (\d+(?:\.\d+)?)/g)) out[match[1]] ??= Number(match[2])
  return out
}

const rows = []
function record(name, samples) {
  rows.push({ name, runs: samples.length, medianMs: round(median(samples)), p90Ms: round(p90(samples)) })
}

async function wall(name, argv) {
  await run(argv) // warm filesystem and compile caches, outside the reported samples
  const samples = []
  for (let i = 0; i < runs; i++) {
    const result = await run(argv)
    if (result.code !== 0) throw new Error(`${name} exited ${result.code}: ${result.stderr}`)
    samples.push(result.ms)
  }
  record(name, samples)
}

let provider
let daemonPid
function stopDaemon() {
  return run([entry, 'daemon', 'stop'])
}

function startProvider() {
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }))
      return
    }
    req.resume()
    req.once('end', () => {
      const event = { id: 'bench', object: 'chat.completion.chunk', created: 0, model: 'deepseek-flash' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}\n\n`,
      )
      res.end(
        `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
      )
    })
  })
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({ server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }),
    ),
  )
}

async function configureProvider(baseUrl) {
  const started = await run([entry, 'daemon', 'start'])
  if (started.code !== 0) throw new Error(`daemon start failed: ${started.stderr}`)
  const owner = JSON.parse(readFileSync(join(home, 'daemon', 'owner.json'), 'utf8'))
  daemonPid = owner.pid
  const discovery = JSON.parse(readFileSync(join(home, 'daemon', 'discovery.json'), 'utf8'))
  const { createClient, memoryJournal } = await import(
    pathToFileURL(createRequire(join(repo, 'packages/cli/package.json')).resolve('@agnes/sdk')).href
  )
  const client = createClient({
    journal: memoryJournal(),
    auth: { kind: 'local' },
    transport: { kind: 'unix', path: discovery.socketPath },
  })
  await client.initialize()
  const config = await client.config.get()
  await client.config.save({
    providerId: 'deepseek',
    baseUrl,
    apiKey: ['synthetic', 'bench', 'key'].join('-'),
    model: 'deepseek-flash',
    expectedRevision: config.revision,
  })
  await client.workspace.add(workspace)
  await client.close?.()
}

// A pseudo-terminal child: prints everything the TUI wrote until composer-ready, then ends it.
const ptyProgram = [
  'import fcntl, os, pty, select, struct, sys, termios, time',
  'pid, fd = pty.fork()',
  'if pid == 0: os.execvpe(sys.argv[1], sys.argv[1:], os.environ)',
  "fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))",
  "out = b''; deadline = time.monotonic() + 40",
  'while time.monotonic() < deadline:',
  '  r, _, _ = select.select([fd], [], [], 0.1)',
  '  if r:',
  '    try: d = os.read(fd, 65536)',
  "    except OSError: d = b''",
  '    if not d: break',
  '    out += d',
  "    if b'agh-timing composer-ready' in out: break",
  'try: os.kill(pid, 9)',
  'except OSError: pass',
  'os.waitpid(pid, 0)',
  'sys.stdout.buffer.write(out)',
].join('\n')

async function measureSession() {
  provider = await startProvider()
  await configureProvider(provider.baseUrl)
  const timed = { AGH_TIMING: '1' }
  const printArgv = [entry, '-p', 'ping']
  const printSamples = async (name, beforeEach) => {
    const wallMs = []
    const token = []
    for (let i = 0; i < runs; i++) {
      await beforeEach()
      const result = await run(printArgv, { env: timed })
      if (result.code !== 0) throw new Error(`${name} exited ${result.code}: ${result.stderr}`)
      const found = marks(result.stderr)
      if (found['first-token'] === undefined) throw new Error(`${name}: no first-token mark`)
      wallMs.push(result.ms)
      token.push(found['first-token'])
    }
    record(`${name} first token`, token)
    record(`${name} total`, wallMs)
  }
  await printSamples('agh -p, cold daemon', async () => {
    await stopDaemon()
  })
  await run(printArgv) // starts the daemon again and fills the caches
  await printSamples('agh -p, warm daemon', async () => {})
  const frame = []
  const composer = []
  for (let i = 0; i < runs; i++) {
    const result = await new Promise((done) => {
      const child = spawn('python3', ['-I', '-c', ptyProgram, process.execPath, entry], {
        cwd: workspace,
        env: { ...env, ...timed, TERM: 'xterm-256color' },
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      let out = ''
      child.stdout.on('data', (chunk) => {
        out += chunk
      })
      child.once('exit', () => done(out))
    })
    const found = marks(result)
    if (found['first-frame'] === undefined || found['composer-ready'] === undefined)
      throw new Error(`TUI run ${i + 1} did not reach composer-ready`)
    frame.push(found['first-frame'])
    composer.push(found['composer-ready'])
  }
  record('TUI first frame, warm daemon', frame)
  record('TUI composer ready, warm daemon', composer)
}

try {
  for (const [label, target] of [
    ['launcher', [launcher]],
    ['entry', [entry]],
  ]) {
    await wall(`agh --version (${label})`, [...target, '--version'])
    await wall(`agh --help (${label})`, [...target, '--help'])
  }
  if (!flags.has('--skip-session')) await measureSession()
} finally {
  if (daemonPid !== undefined) {
    await stopDaemon().catch(() => undefined)
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(daemonPid, 0)
      } catch {
        daemonPid = undefined
        break
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    if (daemonPid !== undefined) process.kill(daemonPid, 'SIGKILL')
  }
  provider?.server.closeAllConnections()
  provider?.server.close()
  rmSync(root, { recursive: true, force: true })
}

const meta = { platform: process.platform, arch: process.arch, node: process.version, runs }
if (flags.has('--json')) console.log(JSON.stringify({ ...meta, rows }, null, 2))
else {
  console.log(`${meta.platform} ${meta.arch}, Node ${meta.node}, ${runs} runs per row (ms)\n`)
  console.log('| item | median | p90 |\n|---|---:|---:|')
  for (const row of rows) console.log(`| ${row.name} | ${row.medianMs} | ${row.p90Ms} |`)
}
