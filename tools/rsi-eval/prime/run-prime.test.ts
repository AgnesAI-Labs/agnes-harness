import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EvalTask, RunConfig } from '../types.js'
import { primeArgv, primeModels, primeSettings, runId, runOne } from './run-prime.js'

const KEY_ENV = 'RSI_TEST_API_KEY'
const KEY_VALUE = 'sk-test-secret-value-123'

const cfg: RunConfig = {
  provider: 'eval',
  api: 'anthropic-messages',
  upstream: 'https://api.example.test',
  model: 'model-x',
  keyEnv: KEY_ENV,
  prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  proxyPort: 4555,
  sessionTimeoutMs: 20_000,
}

function at<T>(items: T[], index = 0): T {
  const item = items[index]
  if (item === undefined) throw new Error(`no item at ${index}`)
  return item
}

function prompt(text: string, contains = 'PASS'): EvalTask['sessions'][number]['prompts'][number] {
  return { text, checks: [{ command: `echo ${contains}`, contains }], solution: [] }
}

function task(category: EvalTask['category'], sessions: string[][]): EvalTask {
  return {
    id: 't1',
    category,
    description: 'd',
    trap: { signatures: ['x'], reproduce: 'true', note: 'n' },
    sessions: sessions.map((prompts) => ({ prompts: prompts.map((text) => prompt(text)) })),
  }
}

// A docker stand-in written in Node so it runs the same on every OS (a shell script named `docker`
// on PATH cannot run on Windows). Mount paths may contain a drive-letter colon, so split on the last
// `:/work` / `:/agent`.
const STUB = String.raw`
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
appendFileSync(process.env.STUB_LOG, args.join('\n') + '\n---\n')
if (args[0] === 'kill') process.exit(0)
let work = ''
let agent = ''
let isPrime = false
args.forEach((a, i) => {
  if (args[i - 1] === '-v') {
    if (a.includes(':/work')) work = a.slice(0, a.lastIndexOf(':/work'))
    else if (a.includes(':/agent')) agent = a.slice(0, a.lastIndexOf(':/agent'))
  }
  if (a === 'prime-agent') isPrime = true
})
if (isPrime) {
  if (process.env.STUB_SLEEP) {
    setTimeout(() => process.exit(0), Number(process.env.STUB_SLEEP) * 1000)
  } else {
    mkdirSync(join(agent, 'sessions', 'cwd'), { recursive: true })
    writeFileSync(join(agent, 'sessions', 'cwd', 's' + process.pid + '.jsonl'), '{"type":"session"}\n')
    process.stdout.write('{"type":"agent_end"}\n')
    process.exitCode = Number(process.env.STUB_EXIT || 0)
  }
} else {
  const result = spawnSync(args[args.length - 1], { shell: true, cwd: work, stdio: 'inherit' })
  process.exitCode = result.status === null ? 1 : result.status
}
`

describe('run-prime', () => {
  let dir: string
  let log: string
  let docker: string[]
  const saved: Record<string, string | undefined> = {}

  function setEnv(name: string, value: string | undefined) {
    if (!(name in saved)) saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rsi-prime-'))
    const stubPath = join(dir, 'docker-stub.cjs')
    writeFileSync(stubPath, STUB)
    docker = [process.execPath, stubPath]
    log = join(dir, 'docker.log')
    writeFileSync(log, '')
    setEnv('STUB_LOG', log)
    setEnv(KEY_ENV, KEY_VALUE)
    setEnv('STUB_EXIT', undefined)
    setEnv('STUB_SLEEP', undefined)
  })

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  function fixture(): string {
    const fx = join(dir, 'fixture')
    mkdirSync(fx, { recursive: true })
    writeFileSync(join(fx, 'README.md'), 'hello')
    return fx
  }

  const invocations = () =>
    readFileSync(log, 'utf8')
      .split('---\n')
      .filter(Boolean)
      .map((chunk) => chunk.split('\n').filter((_, i, a) => i < a.length - 1 || a[i] !== ''))

  it('builds argv with /refine after each prompt when on and none when off', () => {
    const t = task('directory', [['a', 'b', 'c']])
    expect(primeArgv(t, 0, 'on', cfg)).toEqual([
      'prime-agent',
      '--mode',
      'json',
      '--cwd',
      '/work',
      '--provider',
      'eval',
      '--model',
      'model-x',
      '-p',
      'a',
      '/refine',
      'b',
      '/refine',
      'c',
      '/refine',
    ])
    const off = primeArgv(t, 0, 'off', cfg)
    expect(off.slice(10)).toEqual(['a', 'b', 'c'])
    expect(off).not.toContain('/refine')
  })

  it('uses /refine --global at the end of session 1 for cross-session tasks', () => {
    const t = task('cross-session', [
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(primeArgv(t, 0, 'on', cfg).slice(10)).toEqual(['a', '/refine', 'b', '/refine --global'])
    expect(primeArgv(t, 1, 'on', cfg).slice(10)).toEqual(['c', '/refine', 'd', '/refine'])
    expect(primeArgv(t, 0, 'off', cfg).slice(10)).toEqual(['a', 'b'])
  })

  it('writes settings with refinement switched by setting and one pinned model', () => {
    const on = primeSettings('on', cfg)
    const off = primeSettings('off', cfg)
    expect(on).toEqual({
      harnessRefinements: true,
      defaultProvider: 'eval',
      defaultModel: 'model-x',
      subagentDefaultModel: 'model-x',
    })
    expect(off).toEqual({ ...on, harnessRefinements: false })
    expect(on).not.toHaveProperty('auxiliaryModel')
  })

  it('points models.json at the proxy run path and contains no key value', () => {
    const id = runId('t1', 'on', 2)
    expect(id).toBe('t1.on.r2')
    const models = primeModels(cfg, id) as {
      providers: Record<
        string,
        { baseUrl: string; apiKey: string; api: string; models: { id: string; cost: object }[] }
      >
    }
    const provider = models.providers.eval
    if (!provider) throw new Error('provider missing')
    expect(provider.baseUrl).toBe('http://host.docker.internal:4555/run/t1.on.r2/')
    expect(provider.apiKey).toBe(KEY_ENV)
    expect(provider.api).toBe('anthropic-messages')
    expect(provider.models[0]).toMatchObject({
      id: 'model-x',
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    })
    expect(JSON.stringify(models)).not.toContain(KEY_VALUE)
  })

  it('runOne with a stub docker records exit code 1 and leaves later checks unrun', async () => {
    setEnv('STUB_EXIT', '1')
    const out = join(dir, 'out')
    const outcome = await runOne(task('directory', [['a', 'b', 'c']]), 'on', 1, cfg, out, {
      fixtureDir: fixture(),
      dockerCommand: docker,
    })
    expect(outcome.runId).toBe('t1.on.r1')
    expect(outcome.sessions).toHaveLength(1)
    expect(outcome.sessions[0]?.exitCode).toBe(1)
    expect(outcome.sessions[0]?.timedOut).toBe(false)
    expect(readFileSync(at(outcome.sessions).stdoutFile, 'utf8')).toContain('agent_end')
    expect(outcome.sessions[0]?.sessionFiles).toHaveLength(1)
    expect(readFileSync(at(at(outcome.sessions).sessionFiles), 'utf8')).toContain('"session"')
    expect(outcome.checks).toEqual([])
    expect(existsSync(join(out, 't1.on.r1', 'outcome.json'))).toBe(true)
    // the settings written for the run reflect the setting
    const settings = JSON.parse(readFileSync(join(out, 't1.on.r1', 'agent', 'settings.json'), 'utf8'))
    expect(settings.harnessRefinements).toBe(true)
  })

  it('does not start later sessions after a failed one', async () => {
    setEnv('STUB_EXIT', '1')
    const outcome = await runOne(task('cross-session', [['a'], ['b']]), 'off', 1, cfg, join(dir, 'out'), {
      fixtureDir: fixture(),
      dockerCommand: docker,
    })
    expect(outcome.sessions).toHaveLength(1)
    const runs = invocations().filter((args) => args.includes('prime-agent'))
    expect(runs).toHaveLength(1)
  })

  it('runs every check after all sessions, in the container, and records pass or fail', async () => {
    const t = task('cross-session', [['a'], ['b']])
    at(at(t.sessions, 1).prompts).checks = [{ command: 'echo nothing', contains: 'MISSING' }]
    const out = join(dir, 'out')
    const outcome = await runOne(t, 'off', 1, cfg, out, {
      fixtureDir: fixture(),
      image: 'img:test',
      dockerCommand: docker,
    })
    expect(outcome.sessions.map((s) => s.exitCode)).toEqual([0, 0])
    expect(outcome.sessions[0]?.sessionFiles).toHaveLength(1)
    expect(outcome.sessions[1]?.sessionFiles).toHaveLength(1)
    expect(at(at(outcome.sessions, 1).sessionFiles)).not.toBe(at(at(outcome.sessions).sessionFiles))
    expect(outcome.checks).toEqual([
      { session: 0, prompt: 0, passed: true },
      { session: 1, prompt: 0, passed: false },
    ])
    const all = invocations()
    const checkRuns = all.filter((args) => !args.includes('prime-agent'))
    expect(checkRuns).toHaveLength(2)
    for (const args of checkRuns) {
      expect(args).toContain('--network')
      expect(args).toContain('none')
      expect(args.join('\n')).not.toContain(KEY_ENV)
    }
    // all sessions ran before the first check
    const firstCheck = all.findIndex((args) => !args.includes('prime-agent'))
    expect(all.slice(0, firstCheck).filter((args) => args.includes('prime-agent'))).toHaveLength(2)
  })

  it('passes the key by variable name only and mounts work and agent dirs', async () => {
    const out = join(dir, 'out')
    await runOne(task('directory', [['a']]), 'on', 1, cfg, out, {
      fixtureDir: fixture(),
      image: 'img:test',
      dockerCommand: docker,
    })
    expect(readFileSync(log, 'utf8')).not.toContain(KEY_VALUE)
    const run = invocations().find((args) => args.includes('prime-agent'))
    expect(run).toBeDefined()
    const args = run as string[]
    expect(args[0]).toBe('run')
    expect(args).toContain('--rm')
    expect(args).toContain('--add-host')
    expect(args).toContain('host.docker.internal:host-gateway')
    const envs = args.flatMap((a, i) => (args[i - 1] === '-e' ? [a] : []))
    expect(envs).toEqual(['PRIME_AGENT_CODING_AGENT_DIR=/agent', 'PRIME_AGENT_TELEMETRY=0', KEY_ENV])
    const mounts = args.flatMap((a, i) => (args[i - 1] === '-v' ? [a] : []))
    expect(mounts).toEqual([
      `${join(out, 't1.on.r1', 'work')}:/work`,
      `${join(out, 't1.on.r1', 'agent')}:/agent`,
    ])
    expect(args[args.indexOf('img:test') + 1]).toBe('prime-agent')
    expect(existsSync(join(out, 't1.on.r1', 'work', 'README.md'))).toBe(true)
  })

  it('terminates a session that exceeds the timeout and records it', async () => {
    setEnv('STUB_SLEEP', '5')
    const started = Date.now()
    const outcome = await runOne(
      task('directory', [['a']]),
      'off',
      1,
      { ...cfg, sessionTimeoutMs: 300 },
      join(dir, 'out'),
      { fixtureDir: fixture(), dockerCommand: docker },
    )
    expect(Date.now() - started).toBeLessThan(4000)
    expect(outcome.sessions[0]?.timedOut).toBe(true)
    expect(outcome.sessions[0]?.exitCode).toBeNull()
    expect(outcome.checks).toEqual([])
    expect(invocations().some((args) => args[0] === 'kill')).toBe(true)
  })

  it('skips a runId whose outcome already exists', async () => {
    const out = join(dir, 'out')
    const existing = { runId: 't1.off.r3', sessions: [], checks: [{ session: 0, prompt: 0, passed: true }] }
    mkdirSync(join(out, 't1.off.r3'), { recursive: true })
    writeFileSync(join(out, 't1.off.r3', 'outcome.json'), JSON.stringify(existing))
    const outcome = await runOne(task('directory', [['a']]), 'off', 3, cfg, out, {
      fixtureDir: fixture(),
      dockerCommand: docker,
    })
    expect(outcome).toEqual(existing)
    expect(readFileSync(log, 'utf8')).toBe('')
  })
})
