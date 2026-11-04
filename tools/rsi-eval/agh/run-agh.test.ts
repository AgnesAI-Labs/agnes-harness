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
import { createInfraStreak, INFRA_STOP_AFTER } from '../infra.js'
import { defaultTasksDir, loadSuite } from '../suite.js'
import type { Arm, EvalTask } from '../types.js'
import {
  type AghHost,
  aghProfile,
  BLOCKED_FILE,
  type CheckRun,
  checkRoute,
  EVAL_MEMORY,
  finishedOutcome,
  frozenSourcesMadeHere,
  INFRA_FAILURES_FILE,
  type LaunchInput,
  type LedgerRow,
  oracleApplies,
  oracleLesson,
  orderArms,
  parseAghArgs,
  proxyRunId,
  REFINE_WAIT_MS,
  requireKey,
  runOne,
  SECRET_ENV,
  SECRET_REF,
} from './run-agh.js'
import { type Call, cfg, KEY_ENV, KEY_VALUE, type Script, stubLaunch, task } from './test-stub.js'

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

  const run = (t: EvalTask, setting: Arm, calls: Call[], script?: Script, rep = 1, timeout?: number) =>
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
      reps: 3,
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

  it('ends session 1 of an on cross-workspace task with the user save, as Prime ends it with --global', async () => {
    const t = task('cross-workspace', [
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ])
    mkdirSync(join(dir, 'fixture-b'))
    t.sessions[1] = { ...(t.sessions[1] as EvalTask['sessions'][number]), fixture: 'fixture-b' }
    const on: Call[] = []
    expect(await run(t, 'on', on)).not.toHaveProperty('alignment')
    // One review after every prompt as before; only the last of the first session saves to user memory.
    expect(on.filter((c) => c.op === 'review').map((c) => ('saveTo' in c ? c.saveTo : undefined))).toEqual([
      undefined,
      undefined,
      'user',
      undefined,
      undefined,
      undefined,
    ])
    const off: Call[] = []
    expect(await run(t, 'off', off)).not.toHaveProperty('alignment')
    expect(off.filter((c) => c.op === 'review')).toHaveLength(0)
    // Tasks that are not cross-workspace never save to user memory.
    for (const category of ['cross-session', 'directory'] as const) {
      const calls: Call[] = []
      await run(task(category, [['a'], ['b']]), 'on', calls, {}, category === 'cross-session' ? 2 : 1)
      expect(
        calls.some((c) => c.op === 'review' && c.saveTo === 'user'),
        category,
      ).toBe(false)
    }
  })

  it('ends the first session of an on workflow run with the save to the workspace, in place of the last review', async () => {
    const t = task('workflow', [
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ])
    const on: Call[] = []
    const outcome = await run(t, 'on', on)
    const reviews = on.flatMap((c) => (c.op === 'review' ? [c] : []))
    expect(reviews.map((c) => `${c.key.slice(-2)}:${c.saveTo ?? '-'}`)).toEqual([
      's1:-',
      's1:-',
      's1:workspace',
      's2:-',
      's2:-',
      's2:-',
    ])
    // The save is sent, so the run is not marked auto-only.
    expect(outcome.alignment).toBeUndefined()
    const off: Call[] = []
    await run(t, 'off', off)
    expect(off.some((c) => c.op === 'review')).toBe(false)
  })

  it('records why the host refused the workspace save, and only that refusal', async () => {
    const t = task('workflow', [
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ])
    const refused = await run(t, 'on', [], { review: { refused: 'unpriced' } })
    expect(refused.saveRefused).toBe('unpriced')
    expect(refused.sessions).toHaveLength(2)
    expect(Object.keys(refused.sessions[0] ?? {}).sort()).toEqual([
      'exitCode',
      'sessionFiles',
      'stdoutFile',
      'timedOut',
    ])
    expect((await run(t, 'on', [], {}, 2)).saveRefused).toBeUndefined()
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

  describe('the oracle arm', () => {
    const twoSessions = (category: EvalTask['category'] = 'cross-session'): EvalTask => ({
      ...task(category, [
        ['a', 'b', 'c'],
        ['d', 'e', 'f'],
      ]),
      trap: { signatures: ['x'], reproduce: 'true', note: 'Run the tool from studio/, never from the root.' },
    })

    /** What the runner asked of the host, with the names that differ by arm made equal. */
    const shape = (calls: Call[]): Record<string, unknown>[] =>
      calls.flatMap((c): Record<string, unknown>[] => {
        if (c.op === 'seed') return []
        if (c.op === 'launch') {
          const { home: _h, profileDocument: _p, env: _e, workspace, workspaces, ...rest } = c.input
          return [
            { op: c.op, ...rest, workspace: workspaces.indexOf(workspace), workspaces: workspaces.length },
          ]
        }
        if (c.op === 'open') return [{ op: c.op, key: c.key.replace(/\.(off|oracle)\./, '.arm.') }]
        if ('key' in c) return [{ ...c, key: c.key.replace(/\.(off|oracle)\./, '.arm.') }]
        return [{ ...c }]
      })

    it('runs the same as off, with refinement off and no review', async () => {
      const t = twoSessions()
      const off: Call[] = []
      const oracle: Call[] = []
      await run(t, 'off', off)
      await run(t, 'oracle', oracle)
      expect(shape(oracle)).toEqual(shape(off))
      expect(oracle.some((c) => c.op === 'review')).toBe(false)
      const launch = oracle.find((c) => c.op === 'launch')
      expect(launch && 'input' in launch ? launch.input.refinement : 'missing').toBeUndefined()
      expect(readFileSync(join(out, 't1.oracle.r1', 'home', 'marker'), 'utf8')).toBe('off')
      expect(JSON.parse(readFileSync(join(out, 't1.oracle.r1', 'outcome.json'), 'utf8')).runId).toBe(
        't1.oracle.r1',
      )
    })

    it('writes the lesson to the second session workspace after the first session ends and before the second opens', async () => {
      const t = twoSessions()
      const calls: Call[] = []
      await run(t, 'oracle', calls)
      const ops = calls.map((c) => (c.op === 'prompt' ? `prompt:${c.text}` : c.op))
      expect(ops).toEqual([
        'launch',
        'open',
        'prompt:a',
        'prompt:b',
        'prompt:c',
        'close-session',
        'seed',
        'open',
        'prompt:d',
        'prompt:e',
        'prompt:f',
        'close-session',
        'close-host',
      ])
      const seeds = calls.flatMap((c) => (c.op === 'seed' ? [c] : []))
      const opens = calls.flatMap((c) => (c.op === 'open' ? [c] : []))
      expect(seeds).toEqual([{ op: 'seed', workspace: opens[1]?.workspace, text: t.trap.note }])
    })

    it('seeds the second session workspace of a cross-workspace task, not the first', async () => {
      mkdirSync(join(dir, 'fixture-b'))
      const t = twoSessions('cross-workspace')
      t.sessions[1] = { ...(t.sessions[1] as EvalTask['sessions'][number]), fixture: 'fixture-b' }
      const calls: Call[] = []
      await run(t, 'oracle', calls)
      const [first, second] = calls.flatMap((c) => (c.op === 'open' ? [c.workspace] : []))
      expect(first).not.toBe(second)
      expect(calls.flatMap((c) => (c.op === 'seed' ? [c.workspace] : []))).toEqual([second])
    })

    it('is for tasks of two sessions that are not workflow tasks', async () => {
      expect(oracleApplies(twoSessions())).toBe(true)
      expect(oracleApplies(twoSessions('workflow'))).toBe(false)
      expect(oracleApplies(task('directory', [['a', 'b', 'c']]))).toBe(false)
      for (const t of [twoSessions('workflow'), task('directory', [['a', 'b', 'c']])])
        await expect(run(t, 'oracle', [])).rejects.toThrow(/no oracle arm/)
    })

    it('needs a host that can seed memory, and finds out before the first session is paid for', async () => {
      const calls: Call[] = []
      const launch = stubLaunch(calls)
      const bare = async (input: LaunchInput) => {
        const { seedMemory: _s, ...host } = await launch(input)
        return host as AghHost
      }
      await expect(
        runOne(twoSessions(), 'oracle', 1, cfg, out, {
          launch: bare,
          fixtureDir: fixture,
          workBase: work,
          runCheck,
        }),
      ).rejects.toThrow(/cannot seed memory/)
      // No session was opened and no prompt sent; the host was closed again.
      expect(calls.map((c) => c.op)).toEqual(['launch', 'close-host'])
    })

    it('takes the lesson from the note, and no note gives away what the checks expect or a whole solution step', () => {
      const tasks = loadSuite(defaultTasksDir)
      expect(tasks.filter(oracleApplies).length).toBeGreaterThan(0)
      // A note may state its rule with an example command (`ACME_PROFILE=dev bin/acme build about`), so a
      // solution command inside a note is allowed only here, by name; every other note stays clear of the
      // solutions' commands of any length that is a step by itself.
      const MAY_QUOTE_A_COMMAND = new Set(['xws-01-profile-env'])
      const MIN_STEP = 15
      for (const t of tasks) {
        const note = t.trap.note.trim()
        if (oracleApplies(t)) expect(oracleLesson(t), t.id).toBe(note)
        for (const p of t.sessions.flatMap((s) => s.prompts)) {
          for (const check of p.checks)
            expect(note, `${t.id}: what a check expects`).not.toContain(check.contains)
          for (const command of p.solution) {
            expect(note, `${t.id}: the note is a whole solution step`).not.toBe(command.trim())
            if (!MAY_QUOTE_A_COMMAND.has(t.id) && command.trim().length >= MIN_STEP)
              expect(note, `${t.id}: the note quotes the solution step ${command}`).not.toContain(
                command.trim(),
              )
          }
        }
      }
    })

    it('is chosen with --arms; --settings and the default stay as they were', () => {
      const base = ['--config', 'c.json', '--out', 'o']
      expect(parseAghArgs(base).settings).toEqual(['on', 'off'])
      expect(parseAghArgs([...base, '--arms', 'off,on,oracle']).settings).toEqual(['off', 'on', 'oracle'])
      expect(parseAghArgs([...base, '--settings', 'off']).settings).toEqual(['off'])
      expect(() => parseAghArgs([...base, '--settings', 'off,oracle'])).toThrow(/oracle/)
      expect(() => parseAghArgs([...base, '--arms', 'off,maybe'])).toThrow(/maybe/)
      expect(() => parseAghArgs([...base, '--arms', 'off', '--settings', 'on'])).toThrow(/same option/)
    })
  })

  describe('runs the infrastructure ended', () => {
    // Rows of the first evaluation's run that the provider ended with HTTP 402 (see fixtures/real).
    const quotaRows = (name: string): LedgerRow[] =>
      readFileSync(join(import.meta.dirname, '..', 'fixtures', 'real', name), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '' && !line.includes('"type": "session/start"'))
        .map((line) => JSON.parse(line) as LedgerRow)
    const failing = { turns: { a: 'failed' }, ledgerRows: { s1: quotaRows('infra-402.xws-05.off-s1.jsonl') } }

    it('marks a run whose turn ended in HTTP 402 as infra-failed, with the reason and status', async () => {
      const t = task('directory', [['a', 'b', 'c']])
      const outcome = await run(t, 'off', [], failing)
      expect(outcome.infraFailed).toEqual({ session: 0, reason: 'QUOTA (HTTP 402)', status: 402 })
      // The run is still recorded as it ended, so its folder says what happened.
      expect(outcome.sessions[0]?.exitCode).toBe(1)
      expect(
        JSON.parse(readFileSync(join(out, 't1.off.r1', 'outcome.json'), 'utf8')).infraFailed,
      ).toMatchObject({
        status: 402,
      })
    })

    it('does not mark a run that failed for another reason, nor one that completed', async () => {
      const t = task('directory', [['a', 'b', 'c']])
      expect((await run(t, 'off', [], { turns: { a: 'failed' } })).infraFailed).toBeUndefined()
      expect((await run(t, 'off', [], {}, 2)).infraFailed).toBeUndefined()
    })

    it('falls back on the statuses the proxy saw when the ledger names no error', async () => {
      const t = task('directory', [['a', 'b', 'c']])
      const withStatuses = (statuses: number[], rep: number) =>
        runOne(t, 'off', rep, cfg, out, {
          launch: stubLaunch([], { turns: { a: 'failed' } }),
          fixtureDir: fixture,
          workBase: work,
          runCheck,
          statuses: () => statuses,
        })
      expect((await withStatuses([200, 503, 503, 503], 1)).infraFailed).toMatchObject({ status: 503 })
      expect((await withStatuses([503, 200, 400], 2)).infraFailed).toBeUndefined()
    })

    it('is redone on the next start, not skipped, and counted under a new proxy id', async () => {
      const t = task('directory', [['a', 'b', 'c']])
      const first: Call[] = []
      await run(t, 'off', first, failing)
      expect(finishedOutcome(out, 't1.off.r1')).toBeUndefined()
      const again: Call[] = []
      const redone = await run(t, 'off', again)
      expect(redone.infraFailed).toBeUndefined()
      expect(redone.sessions[0]?.exitCode).toBe(0)
      expect(finishedOutcome(out, 't1.off.r1')).toBeDefined()
      const profile = (calls: Call[]) =>
        calls.flatMap((c) => (c.op === 'launch' ? [c.input.profileDocument] : []))[0]
      expect(profile(first)).toEqual(aghProfile(cfg, 't1.off.r1'))
      expect(profile(again)).toEqual(aghProfile(cfg, proxyRunId('t1.off.r1', 1)))
      expect(proxyRunId('t1.off.r1', 1)).toBe('t1.off.r1~a1')
      // The failed attempt is noted before it is replaced.
      const notes = readFileSync(join(out, INFRA_FAILURES_FILE), 'utf8').trim().split('\n')
      expect(notes).toHaveLength(1)
      expect(JSON.parse(notes[0] as string)).toMatchObject({ runId: 't1.off.r1', status: 402 })
      // A finished run is still skipped.
      const third: Call[] = []
      await run(t, 'off', third)
      expect(third).toEqual([])
    })

    it('stops a shard after a few runs in a row, and a good run starts the count over', () => {
      const streak = createInfraStreak()
      expect(INFRA_STOP_AFTER).toBe(3)
      expect([true, true, false, true, true].map((x) => streak.record(x))).toEqual([
        false,
        false,
        false,
        false,
        false,
      ])
      expect(streak.stopped).toBe(false)
      expect(streak.record(true)).toBe(true)
      expect(streak.stopped).toBe(true)
    })
  })

  describe("runs the host's verifier blocked", () => {
    // A real run whose first turn the host's verifier ended blocked (tool_call_as_text; see fixtures/real).
    const blockedRows = (): LedgerRow[] =>
      readFileSync(join(import.meta.dirname, '..', 'fixtures', 'real', 'blocked.long-01.on-s1.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as LedgerRow)
    const blocking = { turns: { b: 'blocked' }, ledgerRows: { s1: blockedRows() } }

    it('records the run as blocked, with where and why, and not as infra-failed', async () => {
      const t = task('directory', [['a', 'b', 'c']])
      const outcome = await run(t, 'off', [], blocking)
      expect(outcome.blocked).toEqual({ session: 0, prompt: 1, reasons: ['tool_call_as_text'] })
      expect(outcome.infraFailed).toBeUndefined()
      expect(outcome.prompts?.map((p) => p.reason)).toEqual(['completed', 'blocked'])
      // A turn that failed for another reason is not blocked.
      expect((await run(t, 'off', [], { turns: { a: 'failed' } }, 2)).blocked).toBeUndefined()
    })

    it('is redone once on the next start under a new proxy id, then left as blocked', async () => {
      const t = task('directory', [['a', 'b', 'c']])
      await run(t, 'on', [], blocking)
      expect(finishedOutcome(out, 't1.on.r1')).toBeUndefined()
      const again: Call[] = []
      const second = await run(t, 'on', again, blocking)
      expect(second.blocked).toBeDefined()
      const profile = (calls: Call[]) =>
        calls.flatMap((c) => (c.op === 'launch' ? [c.input.profileDocument] : []))[0]
      expect(profile(again)).toEqual(aghProfile(cfg, proxyRunId('t1.on.r1', 1)))
      const notes = readFileSync(join(out, BLOCKED_FILE), 'utf8').trim().split('\n')
      expect(notes).toHaveLength(1)
      expect(JSON.parse(notes[0] as string)).toMatchObject({
        runId: 't1.on.r1',
        reasons: ['tool_call_as_text'],
      })
      // Blocked again: it stays as it is.
      expect(finishedOutcome(out, 't1.on.r1')?.blocked).toBeDefined()
      const third: Call[] = []
      expect((await run(t, 'on', third)).blocked).toBeDefined()
      expect(third).toEqual([])
    })
  })

  describe('the order of the arms', () => {
    it('runs frozen after on, so a frozen run can copy the on run of the same invocation', () => {
      expect(orderArms(['frozen', 'off', 'on', 'oracle'])).toEqual(['off', 'on', 'oracle', 'frozen'])
      expect(orderArms(['on', 'off', 'oracle', 'frozen'])).toEqual(['on', 'off', 'oracle', 'frozen'])
      expect(orderArms(['off', 'frozen'])).toEqual(['off', 'frozen'])
      const base = ['--config', 'c.json', '--out', 'o', '--frozen-from', 'o']
      expect(parseAghArgs([...base, '--arms', 'frozen,on,off']).settings).toEqual(['on', 'off', 'frozen'])
      // The frozen sources are this invocation's own on runs only with the same folder and the on arm.
      expect(frozenSourcesMadeHere(parseAghArgs([...base, '--arms', 'on,frozen']))).toBe(true)
      expect(frozenSourcesMadeHere(parseAghArgs([...base, '--arms', 'off,frozen']))).toBe(false)
      expect(
        frozenSourcesMadeHere(
          parseAghArgs(['--config', 'c', '--out', 'o', '--frozen-from', 'p', '--arms', 'on,frozen']),
        ),
      ).toBe(false)
    })
  })
})
