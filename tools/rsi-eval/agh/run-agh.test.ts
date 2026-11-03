import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EvalTask, RunConfig } from '../types.js'
import {
  type AghHost,
  type AghSession,
  aghProfile,
  type CheckRun,
  checkRoute,
  EVAL_MEMORY,
  type LaunchInput,
  type LedgerRow,
  parseAghArgs,
  REFINE_WAIT_MS,
  requireKey,
  runOne,
  SECRET_ENV,
  SECRET_REF,
} from './run-agh.js'

const KEY_ENV = 'RSI_TEST_API_KEY'
const KEY_VALUE = 'sk-test-secret-value-456'

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

const prompt = (text: string) => ({
  text,
  checks: [{ command: `check ${text}`, contains: 'PASS' }],
  solution: [],
})
const task = (category: EvalTask['category'], sessions: string[][]): EvalTask => ({
  id: 't1',
  category,
  description: 'd',
  trap: { signatures: ['x'], reproduce: 'true', note: 'n' },
  sessions: sessions.map((prompts) => ({ prompts: prompts.map(prompt) })),
})

type Call =
  | { op: 'launch'; input: LaunchInput }
  | { op: 'open'; key: string; workspace: string }
  | { op: 'prompt'; key: string; text: string }
  | { op: 'review'; key: string }
  | { op: 'settled'; key: string; runId: string; ms: number }
  | { op: 'close-session'; key: string }
  | { op: 'close-host' }

type Script = {
  /** How each prompt ends, by prompt text; `hang` waits for the abort. Default `completed`. */
  turns?: Record<string, string>
  review?: { runId: string } | { refused: string }
  settled?: string
}

/** A launcher that records what the runner asks of a host and answers from a script; no model, no host. */
function stubLaunch(calls: Call[], script: Script = {}) {
  return async (input: LaunchInput): Promise<AghHost> => {
    calls.push({ op: 'launch', input })
    // The real launcher makes the home; the stub only marks it so isolation can be checked.
    mkdirSync(input.home, { recursive: true })
    writeFileSync(join(input.home, 'marker'), input.refinement ? 'on' : 'off')
    let reviews = 0
    const opened: string[] = []
    return {
      openSession: async (key, workspace): Promise<AghSession> => {
        calls.push({ op: 'open', key, workspace })
        opened.push(key)
        return {
          key,
          prompt: (text, signal) => {
            calls.push({ op: 'prompt', key, text })
            const end = script.turns?.[text] ?? 'completed'
            if (end !== 'hang') return Promise.resolve(end)
            return new Promise((resolve) => signal.addEventListener('abort', () => resolve('cancelled')))
          },
          review: async () => {
            calls.push({ op: 'review', key })
            return script.review ?? { runId: `run-${++reviews}` }
          },
          settled: async (runId, ms) => {
            calls.push({ op: 'settled', key, runId, ms })
            return script.settled ?? 'applied'
          },
          close: async () => {
            calls.push({ op: 'close-session', key })
          },
        }
      },
      close: async () => {
        calls.push({ op: 'close-host' })
      },
      ledger: (key): LedgerRow[] => {
        if (!opened.includes(key)) throw new Error(`not opened: ${key}`)
        return [
          {
            seq: 1,
            ts: '2026-11-03T00:00:00Z',
            type: 'session/start',
            lane: 'main',
            origin: 'system',
            data: { key },
          },
        ]
      },
    }
  }
}

describe('run-agh', () => {
  let dir: string
  let out: string
  let work: string
  let fixture: string
  const checked: { command: string; cwd: string }[] = []
  const runCheck: CheckRun = async (check, cwd) => {
    checked.push({ command: check.command, cwd })
    return existsSync(join(cwd, 'README.md'))
  }

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'rsi-agh-test-')))
    out = join(dir, 'out')
    work = join(dir, 'work-base')
    fixture = join(dir, 'fixture')
    mkdirSync(work)
    mkdirSync(fixture)
    writeFileSync(join(fixture, 'README.md'), 'hello')
    checked.length = 0
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const run = (
    t: EvalTask,
    setting: 'on' | 'off',
    calls: Call[],
    script?: Script,
    rep = 1,
    timeout?: number,
  ) =>
    runOne(t, setting, rep, timeout ? { ...cfg, sessionTimeoutMs: timeout } : cfg, out, {
      launch: stubLaunch(calls, script),
      fixtureDir: fixture,
      workBase: work,
      runCheck,
    })

  it('parses the same arguments as the Prime runner, without an image', () => {
    expect(parseAghArgs(['--config', 'c.json', '--out', 'o'])).toMatchObject({
      config: 'c.json',
      out: 'o',
      reps: 5,
      settings: ['on', 'off'],
    })
    expect(
      parseAghArgs(['--config', 'c', '--out', 'o', '--tasks', 'a, b', '--reps', '2', '--settings', 'off']),
    ).toMatchObject({ tasks: ['a', 'b'], reps: 2, settings: ['off'] })
    expect(() => parseAghArgs(['--out', 'o'])).toThrow(/usage: run-agh.ts/)
    expect(() => parseAghArgs(['--config', 'c', '--out', 'o', '--reps', '0'])).toThrow(/--reps/)
    expect(() => parseAghArgs(['--config', 'c', '--out', 'o', '--settings', 'on,maybe'])).toThrow(/maybe/)
    expect(() => parseAghArgs(['--config', 'c', '--out', 'o', '--image', 'x'])).toThrow()
  })

  it('fails clearly when the key variable is missing, and never shows a key', () => {
    expect(() => requireKey(cfg, {})).toThrow(
      `environment variable ${KEY_ENV} (run-config keyEnv) is not set`,
    )
    expect(() => requireKey(cfg, { [KEY_ENV]: '  ' })).toThrow(KEY_ENV)
    expect(requireKey(cfg, { [KEY_ENV]: KEY_VALUE })).toBe(KEY_VALUE)
    try {
      requireKey({ ...cfg, keyEnv: 'OTHER' }, { [KEY_ENV]: KEY_VALUE })
    } catch (error) {
      expect(String(error)).not.toContain(KEY_VALUE)
    }
  })

  it('names the secret the way the host reads environment secrets', () => {
    // AGNES_SECRET_<namespace>_<name>, upper case, other characters as underscores.
    const [, ns, name] = /^secret:\/\/([a-z0-9-]+)\/([a-z0-9._-]+)$/.exec(SECRET_REF) ?? []
    expect(`AGNES_SECRET_${ns}_${name}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_')).toBe(SECRET_ENV)
  })

  it('points the one route at the proxy run path, prices the model, and holds no key', () => {
    const doc = aghProfile(cfg, 't1.on.r2')
    expect(doc).toMatchObject({
      adapters: { secrets: { kind: 'env' } },
      provider: {
        routes: [
          {
            route: 'eval',
            api: 'anthropic-messages',
            baseUrl: 'http://127.0.0.1:4555/run/t1.on.r2/',
            credentialRef: SECRET_REF,
            models: [{ id: 'model-x', route: 'eval', cost: cfg.prices }],
          },
        ],
      },
    })
    expect(JSON.stringify(doc)).not.toContain(KEY_VALUE)
    expect(() => checkRoute({ ...cfg, provider: 'Eval Route' })).toThrow(/provider/)
  })

  it('gives every run a fresh home of its own and saves the switch only for the on run', async () => {
    const t = task('directory', [['a', 'b', 'c']])
    const calls: Call[] = []
    await run(t, 'on', calls)
    await run(t, 'off', calls)
    await run(t, 'on', calls, {}, 2)
    const launches = calls.flatMap((c) => (c.op === 'launch' ? [c.input] : []))
    expect(launches.map((l) => relative(out, l.home))).toEqual([
      join('t1.on.r1', 'home'),
      join('t1.off.r1', 'home'),
      join('t1.on.r2', 'home'),
    ])
    for (const l of launches) {
      expect(l.env.AGH_HOME).toBe(l.home)
      expect(l.profileDocument).toEqual(aghProfile(cfg, relative(out, l.home).split(/[\\/]/)[0] as string))
      // The workspace is a throwaway copy outside the output directory.
      expect(relative(work, l.workspace).startsWith('..')).toBe(false)
      expect(l.model).toEqual({ route: 'eval', model: 'model-x' })
    }
    expect(launches.map((l) => l.refinement)).toEqual([
      { enabled: true, mode: 'auto' },
      undefined,
      { enabled: true, mode: 'auto' },
    ])
    expect(readFileSync(join(out, 't1.off.r1', 'home', 'marker'), 'utf8')).toBe('off')
    // Throwaway workspaces are gone; each run keeps its copy.
    expect(readdirSync(work)).toEqual([])
    expect(readFileSync(join(out, 't1.on.r1', 'work', 'README.md'), 'utf8')).toBe('hello')
  })

  it('agh runner gives each session its own workspace under one home', async () => {
    mkdirSync(join(dir, 'fixture-b'))
    writeFileSync(join(dir, 'fixture-b', 'README.md'), 'second project')
    const t: EvalTask = {
      ...task('cross-workspace', [
        ['a', 'b', 'c'],
        ['d', 'e', 'f'],
      ]),
    }
    t.sessions[1] = { ...(t.sessions[1] as EvalTask['sessions'][number]), fixture: 'fixture-b' }
    const calls: Call[] = []
    const outcome = await run(t, 'on', calls)
    const launches = calls.flatMap((c) => (c.op === 'launch' ? [c.input] : []))
    expect(launches).toHaveLength(1)
    const [first, second] = launches[0]?.workspaces ?? []
    expect(launches[0]?.workspace).toBe(first)
    expect(first).not.toBe(second)
    expect(calls.flatMap((c) => (c.op === 'open' ? [c.workspace] : []))).toEqual([first, second])
    // Each session's checks run in its own workspace.
    expect(checked.map((c) => c.cwd)).toEqual([first, first, first, second, second, second])
    // The run keeps both copies, and the throwaway ones are gone.
    expect(readFileSync(join(out, 't1.on.r1', 'work', 'README.md'), 'utf8')).toBe('hello')
    expect(readFileSync(join(out, 't1.on.r1', 'work-b', 'README.md'), 'utf8')).toBe('second project')
    expect(readdirSync(work)).toEqual([])
    expect(outcome.sessions.map((s) => s.exitCode)).toEqual([0, 0])

    // A cross-session task keeps one workspace: its second session is the same project.
    const same: Call[] = []
    await run(task('cross-session', [['a'], ['b']]), 'on', same, {}, 2)
    const opened = same.flatMap((c) => (c.op === 'open' ? [c.workspace] : []))
    expect(opened).toHaveLength(2)
    expect(opened[0]).toBe(opened[1])
    expect(same.flatMap((c) => (c.op === 'launch' ? c.input.workspaces : []))).toEqual([opened[0]])
  })

  it('both settings write identical memory settings with userEnabled', async () => {
    const t = task('directory', [['a', 'b', 'c']])
    const calls: Call[] = []
    await run(t, 'on', calls)
    await run(t, 'off', calls)
    const memory = calls.flatMap((c) => (c.op === 'launch' ? [c.input.memory] : []))
    expect(memory).toEqual([EVAL_MEMORY, EVAL_MEMORY])
    expect(EVAL_MEMORY).toEqual({ mode: 'auto', userEnabled: true })
  })

  it('marks an on cross-workspace run auto-only and sends nothing extra at the end of session 1', async () => {
    const t = task('cross-workspace', [
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ])
    mkdirSync(join(dir, 'fixture-b'))
    t.sessions[1] = { ...(t.sessions[1] as EvalTask['sessions'][number]), fixture: 'fixture-b' }
    const on: Call[] = []
    expect((await run(t, 'on', on)).alignment).toBe('auto-only')
    expect(on.filter((c) => c.op === 'review')).toHaveLength(6)
    expect((await run(t, 'off', [])).alignment).toBeUndefined()
    const cross = task('cross-session', [['a'], ['b']])
    expect((await run(cross, 'on', [], {}, 2)).alignment).toBeUndefined()
  })

  it('asks for one review after each prompt and waits for it when on, and none when off', async () => {
    const t = task('directory', [['a', 'b', 'c']])
    const on: Call[] = []
    await run(t, 'on', on)
    expect(
      on.filter((c) => c.op !== 'launch').map((c) => ('text' in c ? `${c.op}:${c.text}` : c.op)),
    ).toEqual([
      'open',
      'prompt:a',
      'review',
      'settled',
      'prompt:b',
      'review',
      'settled',
      'prompt:c',
      'review',
      'settled',
      'close-session',
      'close-host',
    ])
    const waits = on.flatMap((c) => (c.op === 'settled' ? [c] : []))
    expect(waits.map((w) => w.runId)).toEqual(['run-1', 'run-2', 'run-3'])
    expect(waits.every((w) => w.ms > 0 && w.ms <= REFINE_WAIT_MS)).toBe(true)
    const off: Call[] = []
    await run(t, 'off', off)
    expect(off.some((c) => c.op === 'review' || c.op === 'settled')).toBe(false)
    const log = readFileSync(join(out, 't1.on.r1', 'session1.turns.jsonl'), 'utf8')
      .trim()
      .split('\n')
    expect(JSON.parse(log[0] as string)).toEqual({
      prompt: 0,
      reason: 'completed',
      review: { runId: 'run-1', state: 'applied' },
    })
  })

  it('stops an on run whose host does not have refinement active', async () => {
    const t = task('directory', [['a', 'b', 'c']])
    await expect(run(t, 'on', [], { review: { refused: 'unavailable' } })).rejects.toThrow(/not active/)
    await expect(run(t, 'on', [], { review: { refused: 'refinement-off' } }, 2)).rejects.toThrow(/not active/)
    // Another refusal is recorded and the run goes on.
    const outcome = await run(t, 'on', [], { review: { refused: 'closing' } }, 3)
    expect(outcome.sessions[0]?.exitCode).toBe(0)
  })

  it('maps a clean run to exit 0, writes the ledger as the session file and runs every check', async () => {
    const t = task('cross-session', [
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ])
    const outcome = await run(t, 'off', [])
    expect(outcome.runId).toBe('t1.off.r1')
    expect(outcome.system).toBe('agh')
    expect(outcome.sessions.map((s) => [s.exitCode, s.timedOut])).toEqual([
      [0, false],
      [0, false],
    ])
    const file = outcome.sessions[1]?.sessionFiles[0] as string
    expect(JSON.parse(readFileSync(file, 'utf8').trim())).toMatchObject({
      type: 'session/start',
      data: { key: 'rsi-eval-t1.off.r1-s2' },
    })
    expect(outcome.checks).toHaveLength(6)
    expect(outcome.checks.every((c) => c.passed)).toBe(true)
    // Checks run in the workspace the sessions used, not in the kept copy.
    expect(checked.every((c) => relative(work, c.cwd).split(/[\\/]/).length === 1)).toBe(true)
    expect(JSON.parse(readFileSync(join(out, 't1.off.r1', 'outcome.json'), 'utf8'))).toEqual(outcome)
  })

  it('ends the run at a turn that does not complete: exit 1, no later session, no checks for it', async () => {
    const t = task('cross-session', [
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ])
    const calls: Call[] = []
    const outcome = await run(t, 'on', calls, { turns: { b: 'failed' } })
    expect(outcome.sessions).toHaveLength(1)
    expect(outcome.sessions[0]).toMatchObject({ exitCode: 1, timedOut: false })
    expect(outcome.checks).toEqual([])
    expect(calls.some((c) => c.op === 'prompt' && c.text === 'c')).toBe(false)
    expect(calls.filter((c) => c.op === 'review')).toHaveLength(1)
    expect(calls.at(-1)?.op).toBe('close-host')
  })

  it('records a session that runs past the timeout and cancels its turn', async () => {
    const t = task('directory', [['a', 'b', 'c']])
    const outcome = await run(t, 'off', [], { turns: { b: 'hang' } }, 1, 200)
    expect(outcome.sessions[0]).toMatchObject({ exitCode: null, timedOut: true })
    expect(outcome.checks).toEqual([])
  })

  it('reuses a finished run and starts a partial one over with a new home', async () => {
    const t = task('directory', [['a', 'b', 'c']])
    const first: Call[] = []
    const outcome = await run(t, 'off', first)
    const again: Call[] = []
    expect(await run(t, 'off', again)).toEqual(outcome)
    expect(again).toEqual([])
    rmSync(join(out, 't1.off.r1', 'outcome.json'))
    writeFileSync(join(out, 't1.off.r1', 'home', 'stale'), 'x')
    const third: Call[] = []
    await run(t, 'off', third)
    expect(third[0]?.op).toBe('launch')
    expect(existsSync(join(out, 't1.off.r1', 'home', 'stale'))).toBe(false)
  })

  it('writes no key anywhere in the run directory', async () => {
    const t = task('directory', [['a', 'b', 'c']])
    const saved = process.env[KEY_ENV]
    process.env[KEY_ENV] = KEY_VALUE
    try {
      await run(t, 'on', [])
    } finally {
      if (saved === undefined) delete process.env[KEY_ENV]
      else process.env[KEY_ENV] = saved
    }
    const files: string[] = []
    const walk = (path: string) => {
      for (const name of readdirSync(path)) {
        const child = join(path, name)
        if (statSync(child).isDirectory()) walk(child)
        else files.push(child)
      }
    }
    walk(out)
    expect(files.length).toBeGreaterThan(3)
    for (const file of files) expect(readFileSync(file, 'utf8')).not.toContain(KEY_VALUE)
  })

  it('refuses a work directory inside a git repository', async () => {
    mkdirSync(join(work, '.git'))
    await expect(run(task('directory', [['a', 'b', 'c']]), 'off', [])).rejects.toThrow(/git work tree/)
  })
})
