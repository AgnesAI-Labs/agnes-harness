import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { selfCheckTask } from './self-check.js'
import { defaultTasksDir, loadSuite } from './suite.js'
import type { EvalTask } from './types.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const prompt = (n: number) => ({
  text: `prompt ${n}`,
  checks: [{ command: `cat out-${n}.txt`, contains: `value-${n}` }],
  solution: [`echo value-${n} > out-${n}.txt`],
})

const sampleTask = (id: string, overrides: Partial<EvalTask> = {}): EvalTask => ({
  id,
  category: 'directory',
  description: 'sample',
  trap: { signatures: ['boom'], reproduce: 'echo boom', note: 'sample trap' },
  sessions: [{ prompts: [prompt(1), prompt(2), prompt(3)] }],
  ...overrides,
})

// Writes `tasks` as <root>/<dir>/task.json plus a fixture/ (and every other fixture a session
// names) holding a README, and returns the root.
const writeSuite = (tasks: { dir: string; json: unknown }[]): string => {
  const root = mkdtempSync(join(tmpdir(), 'rsi-suite-test-'))
  roots.push(root)
  for (const { dir, json } of tasks) {
    const sessions = (json as { sessions?: { fixture?: unknown }[] }).sessions ?? []
    const named = sessions.map((s) => s?.fixture).filter((f): f is string => typeof f === 'string')
    for (const fixture of new Set(['fixture', ...named])) {
      mkdirSync(join(root, dir, fixture), { recursive: true })
      writeFileSync(join(root, dir, fixture, 'README'), 'fixture\n')
    }
    writeFileSync(join(root, dir, 'task.json'), JSON.stringify(json, null, 2))
  }
  return root
}

const relaxed = { minTasks: 0 }

describe('loadSuite', () => {
  it('loads a valid task and sorts by id', () => {
    const root = writeSuite([
      { dir: 'b', json: sampleTask('b') },
      { dir: 'a', json: sampleTask('a') },
    ])
    expect(loadSuite(root, relaxed).map((task) => task.id)).toEqual(['a', 'b'])
  })

  it('rejects unknown keys, duplicate ids and bad regexes', () => {
    const unknownTop = writeSuite([{ dir: 'a', json: { ...sampleTask('a'), extra: 1 } }])
    expect(() => loadSuite(unknownTop, relaxed)).toThrow(/unknown key "extra"/)

    const base = sampleTask('a')
    const unknownNested = writeSuite([
      {
        dir: 'a',
        json: { ...base, sessions: [{ prompts: base.sessions[0]?.prompts, note: 'x' }] },
      },
    ])
    expect(() => loadSuite(unknownNested, relaxed)).toThrow(/unknown key "note"/)

    const duplicate = writeSuite([
      { dir: 'a', json: sampleTask('a') },
      { dir: 'b', json: sampleTask('a') },
    ])
    expect(() => loadSuite(duplicate, relaxed)).toThrow(/duplicate id "a"/)

    const mismatch = writeSuite([{ dir: 'a', json: sampleTask('other') }])
    expect(() => loadSuite(mismatch, relaxed)).toThrow(/does not match directory/)

    const badRegex = writeSuite([
      { dir: 'a', json: sampleTask('a', { trap: { signatures: ['(unclosed'], reproduce: 'x', note: 'n' } }) },
    ])
    expect(() => loadSuite(badRegex, relaxed)).toThrow(/signature "\(unclosed"/)
  })

  it('requires two sessions for cross-session tasks and at least three prompts per session', () => {
    const prompts = [prompt(1), prompt(2), prompt(3)]
    const oneSessionCross = writeSuite([
      { dir: 'a', json: sampleTask('a', { category: 'cross-session', sessions: [{ prompts }] }) },
    ])
    expect(() => loadSuite(oneSessionCross, relaxed)).toThrow(/exactly 2 sessions/)

    const twoSessionsPlain = writeSuite([
      { dir: 'a', json: sampleTask('a', { sessions: [{ prompts }, { prompts }] }) },
    ])
    expect(() => loadSuite(twoSessionsPlain, relaxed)).toThrow(/exactly 1 session/)

    const shortSession = writeSuite([
      { dir: 'a', json: sampleTask('a', { sessions: [{ prompts: prompts.slice(0, 2) }] }) },
    ])
    expect(() => loadSuite(shortSession, relaxed)).toThrow(/at least 3 prompts/)

    const goodCross = writeSuite([
      {
        dir: 'a',
        json: sampleTask('a', { category: 'cross-session', sessions: [{ prompts }, { prompts }] }),
      },
    ])
    expect(loadSuite(goodCross, relaxed)).toHaveLength(1)
  })

  it('suite requires 2 sessions with distinct fixtures for cross-workspace', () => {
    const prompts = [prompt(1), prompt(2), prompt(3)]
    const xws = (sessions: EvalTask['sessions']) => sampleTask('a', { category: 'cross-workspace', sessions })

    const good = writeSuite([{ dir: 'a', json: xws([{ prompts }, { prompts, fixture: 'fixture-b' }]) }])
    expect(loadSuite(good, relaxed)[0]?.sessions.map((s) => s.fixture)).toEqual([undefined, 'fixture-b'])

    const oneSession = writeSuite([{ dir: 'a', json: xws([{ prompts }]) }])
    expect(() => loadSuite(oneSession, relaxed)).toThrow(/exactly 2 sessions/)

    const sameFixture = writeSuite([{ dir: 'a', json: xws([{ prompts }, { prompts }]) }])
    expect(() => loadSuite(sameFixture, relaxed)).toThrow(/second session must name a fixture other than/)

    const sameNamed = writeSuite([
      {
        dir: 'a',
        json: xws([
          { prompts, fixture: 'fixture-b' },
          { prompts, fixture: 'fixture-b' },
        ]),
      },
    ])
    expect(() => loadSuite(sameNamed, relaxed)).toThrow(/second session must name a fixture other than/)

    const badName = writeSuite([{ dir: 'a', json: xws([{ prompts }, { prompts, fixture: '../x' }]) }])
    expect(() => loadSuite(badName, relaxed)).toThrow(/fixture "\.\.\/x"/)

    const missingDir = writeSuite([{ dir: 'a', json: xws([{ prompts }, { prompts, fixture: 'fixture-b' }]) }])
    rmSync(join(missingDir, 'a', 'fixture-b'), { recursive: true })
    expect(() => loadSuite(missingDir, relaxed)).toThrow(/missing fixture-b\/ directory/)

    // Only cross-workspace tasks move a session to another workspace.
    const crossSession = writeSuite([
      {
        dir: 'a',
        json: sampleTask('a', {
          category: 'cross-session',
          sessions: [{ prompts }, { prompts, fixture: 'fixture-b' }],
        }),
      },
    ])
    expect(() => loadSuite(crossSession, relaxed)).toThrow(/only cross-workspace tasks name another fixture/)

    // What has to be learned must fit the small user memory.
    const longNote = writeSuite([
      {
        dir: 'a',
        json: {
          ...xws([{ prompts }, { prompts, fixture: 'fixture-b' }]),
          trap: { signatures: ['boom'], reproduce: 'echo boom', note: 'x'.repeat(300) },
        },
      },
    ])
    expect(() => loadSuite(longNote, relaxed)).toThrow(/trap.note.*at most 256/)
  })

  it('requires a fixture directory', () => {
    const root = writeSuite([{ dir: 'a', json: sampleTask('a') }])
    rmSync(join(root, 'a', 'fixture'), { recursive: true })
    expect(() => loadSuite(root, relaxed)).toThrow(/missing fixture/)
  })

  it('needs one task by default and no category a floor of its own; minTasks still sets the total', () => {
    const root = writeSuite([{ dir: 'a', json: sampleTask('a') }])
    expect(loadSuite(root).map((t) => t.id)).toEqual(['a'])
    expect(() => loadSuite(root, { minTasks: 2 })).toThrow(/at least 2 tasks/)
    expect(() => loadSuite(writeSuite([]))).toThrow(/at least 1 tasks/)
    // Every category is still read, for the runner's two-session, cross-workspace and workflow features.
    const two = { prompts: [prompt(1), prompt(2), prompt(3)] }
    const mixed = writeSuite([
      { dir: 'cross-1', json: sampleTask('cross-1', { category: 'cross-session', sessions: [two, two] }) },
      { dir: 'wf-1', json: sampleTask('wf-1', { category: 'workflow', sessions: [two, two] }) },
      { dir: 'long-1', json: sampleTask('long-1', { category: 'long' }) },
    ])
    expect(loadSuite(mixed).map((t) => t.category)).toEqual(['cross-session', 'long', 'workflow'])
  })

  it('bundles the long tasks alone', () => {
    const bundled = loadSuite(defaultTasksDir)
    expect(bundled.map((t) => t.id)).toEqual([
      'long-01-release-train',
      'long-02-vendor-import',
      'long-03-config-rollout',
      'long-04-test-harness',
    ])
    expect(new Set(bundled.map((t) => t.category))).toEqual(new Set(['long']))
  })

  it('reads milestones, a request cap and the oracle seeding point, and refuses bad ones', () => {
    const staged = sampleTask('long-1', {
      category: 'long',
      maxRequests: 120,
      oracle: { afterPrompt: 0 },
      sessions: [
        {
          prompts: [
            { ...prompt(1), milestone: 'stage 1' },
            { ...prompt(2), milestone: 'stage 2' },
            prompt(3),
          ],
        },
      ],
    })
    const [task] = loadSuite(writeSuite([{ dir: 'long-1', json: staged }]), relaxed)
    expect(task?.maxRequests).toBe(120)
    expect(task?.oracle).toEqual({ afterPrompt: 0 })
    expect(task?.sessions[0]?.prompts.map((p) => p.milestone)).toEqual(['stage 1', 'stage 2', undefined])

    const bad = (json: object, message: RegExp) =>
      expect(() => loadSuite(writeSuite([{ dir: 'long-1', json }]), relaxed)).toThrow(message)
    bad({ ...staged, maxRequests: 0 }, /maxRequests/)
    bad({ ...staged, maxRequests: 2.5 }, /maxRequests/)
    // The lesson must land before a prompt of the first session that can use it.
    bad({ ...staged, oracle: { afterPrompt: 2 } }, /afterPrompt/)
    bad({ ...staged, oracle: { afterPrompt: -1 } }, /afterPrompt/)
    bad({ ...staged, oracle: { afterPrompt: 0, extra: 1 } }, /unknown key/)
    bad(
      { ...staged, sessions: [{ prompts: [{ ...prompt(1), milestone: '' }, prompt(2), prompt(3)] }] },
      /milestone/,
    )
    // A long task has up to ten sessions in its workspace, and a session of a long task may be short.
    const session = { prompts: [prompt(1), prompt(2), prompt(3)] }
    const short = {
      prompts: [
        { ...prompt(4), milestone: 'm4' },
        { ...prompt(5), milestone: 'm5' },
      ],
    }
    bad({ ...staged, sessions: Array.from({ length: 11 }, () => short) }, /at most 10 sessions/)
    expect(
      loadSuite(writeSuite([{ dir: 'long-1', json: { ...staged, sessions: [session, session] } }]), relaxed),
    ).toHaveLength(1)
    const [five] = loadSuite(
      writeSuite([{ dir: 'long-1', json: { ...staged, sessions: [session, short, short, short, short] } }]),
      relaxed,
    )
    expect(five?.sessions.map((s) => s.prompts.length)).toEqual([3, 2, 2, 2, 2])
    // Other categories keep their floor of three prompts per session.
    bad(
      sampleTask('cross-1', { category: 'cross-session', sessions: [session, short] }),
      /at least 3 prompts/,
    )
    // Workflow tasks have no oracle arm.
    bad(
      sampleTask('long-1', {
        category: 'workflow',
        oracle: { afterPrompt: 0 },
        sessions: [session, session],
      }),
      /workflow tasks have no oracle arm/,
    )
  })
})

// The task commands are bash, make and python3 scripts: they are written for the Linux container the
// tasks run in, and the self-check runs them on the host, so it needs a POSIX host. The format checks
// in `loadSuite` above run everywhere.
const posixDescribe = describe.skipIf(process.platform === 'win32')

posixDescribe('selfCheckTask', () => {
  // `files` paths are relative to the task directory when they start with a fixture name, else to fixture/.
  const taskDirFor = (task: EvalTask, files: Record<string, string> = {}): string => {
    const root = writeSuite([{ dir: task.id, json: task }])
    for (const [name, content] of Object.entries(files)) {
      const path = /^fixture(-[a-z0-9]+)?\//.test(name)
        ? join(root, task.id, name)
        : join(root, task.id, 'fixture', name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
    return join(root, task.id)
  }

  const crossWorkspace = (id: string, overrides: Partial<EvalTask> = {}): EvalTask =>
    sampleTask(id, {
      category: 'cross-workspace',
      // The trap is in each project's own tool; each session checks its own project's README.
      trap: { signatures: ['tool says no'], reproduce: './tool.sh', note: 'n' },
      sessions: [
        {
          prompts: [1, 2, 3].map((n) => ({
            text: `a${n}`,
            checks: [{ command: 'cat README', contains: `alpha-${n}` }],
            solution: [`echo alpha-${n} >> README`],
          })),
        },
        {
          fixture: 'fixture-b',
          prompts: [1, 2, 3].map((n) => ({
            text: `b${n}`,
            checks: [{ command: 'cat README', contains: `beta-${n}` }],
            solution: ['grep -q project-b README', `echo beta-${n} >> README`],
          })),
        },
      ],
      ...overrides,
    })
  const tool = '#!/usr/bin/env bash\necho "tool says no" >&2\nexit 1\n'
  const executable = (taskDir: string) => {
    for (const f of ['fixture', 'fixture-b']) chmodSync(join(taskDir, f, 'tool.sh'), 0o755)
    return taskDir
  }

  it('reproduces a cross-workspace trap in both fixtures and runs each session from its own', async () => {
    const task = crossWorkspace('xws')
    const taskDir = executable(
      taskDirFor(task, {
        'tool.sh': tool,
        'fixture-b/tool.sh': tool,
        'fixture-b/README': 'project-b\n',
      }),
    )
    expect(await selfCheckTask(task, taskDir)).toEqual({ ok: true, problems: [] })

    // The trap has to bite in the second project too.
    writeFileSync(join(taskDir, 'fixture-b', 'tool.sh'), '#!/usr/bin/env bash\necho fine\n')
    const result = await selfCheckTask(task, taskDir)
    expect(result.problems.join('\n')).toMatch(/fixture-b: trap.reproduce output matches none/)
  })

  it('requires every prompt check to hold in the final state, after all the solutions ran', async () => {
    const write = (word: string) => ({
      text: `write ${word}`,
      checks: [{ command: 'cat out.txt', contains: word }],
      solution: [`echo ${word} > out.txt`],
    })
    const overwritten = sampleTask('overwritten', {
      trap: { signatures: ['boom'], reproduce: 'echo boom', note: 'n' },
      sessions: [{ prompts: [write('one'), write('two'), prompt(3)] }],
    })
    const result = await selfCheckTask(overwritten, taskDirFor(overwritten))
    expect(result.ok).toBe(false)
    expect(result.problems.join('\n')).toMatch(/session 0 prompt 0 check 0 fails in the final state/)
    expect(result.problems).toHaveLength(1)

    const kept = sampleTask('kept', {
      trap: { signatures: ['boom'], reproduce: 'echo boom', note: 'n' },
      sessions: [
        {
          prompts: [1, 2, 3].map((n) => ({
            text: `append ${n}`,
            checks: [{ command: 'cat out.txt', contains: `word-${n}` }],
            solution: [`echo word-${n} >> out.txt`],
          })),
        },
      ],
    })
    expect(await selfCheckTask(kept, taskDirFor(kept))).toEqual({ ok: true, problems: [] })
  })

  it('judges a milestone right after its own solution, with the earlier stages applied', async () => {
    // Stage 2 builds on stage 1, and stage 3 changes what stage 1 left: a final-state check of stage 1 would
    // fail, a check right after it holds.
    const stage = (n: number, solution: string[], contains: string) => ({
      text: `stage ${n}`,
      milestone: `stage ${n}`,
      checks: [{ command: 'cat state.txt', contains }],
      solution,
    })
    const staged = sampleTask('staged', {
      category: 'long',
      sessions: [
        {
          prompts: [
            stage(1, ['echo one > state.txt'], 'one'),
            stage(2, ['grep -q one state.txt', 'echo two >> state.txt'], 'two'),
            stage(3, ['echo three > state.txt'], 'three'),
          ],
        },
      ],
    })
    expect(await selfCheckTask(staged, taskDirFor(staged))).toEqual({ ok: true, problems: [] })

    // A milestone whose check already holds before its solution measures nothing.
    const early = sampleTask('early', {
      category: 'long',
      sessions: [
        {
          prompts: [
            stage(1, ['echo one-two > state.txt'], 'one'),
            stage(2, ['echo two >> state.txt'], 'two'),
            stage(3, ['echo three >> state.txt'], 'three'),
          ],
        },
      ],
    })
    const result = await selfCheckTask(early, taskDirFor(early))
    expect(result.problems).toEqual(['session 0 prompt 1 milestone check 0 passes before its solution'])
  })

  it('flags a second fixture whose documentation gives the trap away', async () => {
    const task = crossWorkspace('xws-clue')
    const taskDir = executable(
      taskDirFor(task, {
        'tool.sh': tool,
        'fixture-b/tool.sh': tool,
        'fixture-b/README': 'project-b\n',
        'fixture-b/docs/NOTES.md': 'If the tool says no, ask nicely.\n',
      }),
    )
    const result = await selfCheckTask(task, taskDir)
    expect(result.problems).toEqual([
      'fixture-b: docs/NOTES.md mentions the trap; the second workspace must hold no clue',
    ])
  })

  it('passes a sound task', async () => {
    const task = sampleTask('sound')
    expect(await selfCheckTask(task, taskDirFor(task))).toEqual({ ok: true, problems: [] })
  })

  it('self-check fails when checks pass before the solution', async () => {
    const task = sampleTask('vacuous', {
      sessions: [
        {
          prompts: [
            { text: 'p1', checks: [{ command: 'echo always', contains: 'always' }], solution: ['true'] },
            prompt(2),
            prompt(3),
          ],
        },
      ],
    })
    const result = await selfCheckTask(task, taskDirFor(task))
    expect(result.ok).toBe(false)
    expect(result.problems.join('\n')).toMatch(/passes before the solution/)
  })

  it('fails when the solution does not make the checks pass, or the trap does not reproduce', async () => {
    const task = sampleTask('broken', {
      trap: { signatures: ['never-printed'], reproduce: 'echo boom', note: 'n' },
      sessions: [
        {
          prompts: [
            { text: 'p1', checks: [{ command: 'cat nope.txt', contains: 'x' }], solution: ['true'] },
            prompt(2),
            prompt(3),
          ],
        },
      ],
    })
    const result = await selfCheckTask(task, taskDirFor(task))
    const text = result.problems.join('\n')
    expect(result.ok).toBe(false)
    expect(text).toMatch(/reproduce/)
    expect(text).toMatch(/still fails after the solution/)
  })

  it('runs prompts independently from the initial fixture, in a temp copy outside git, with a clean env', async () => {
    process.env.RSI_SELF_CHECK_LEAK = 'leaked'
    const task = sampleTask('isolated', {
      trap: {
        signatures: ['^outside-git\\nleak=\\n$'],
        reproduce:
          'git rev-parse --git-dir >/dev/null 2>&1 && echo in-git || echo outside-git; echo "leak=$RSI_SELF_CHECK_LEAK"',
        note: 'n',
      },
      sessions: [
        {
          prompts: [
            {
              text: 'p1',
              checks: [{ command: 'cat made.txt', contains: 'one' }],
              solution: ['echo one > made.txt', 'echo changed >> README'],
            },
            {
              // Fails if prompt 1's solution leaked into this copy.
              text: 'p2',
              checks: [
                {
                  command: 'test -e made.txt && echo leaked || echo clean-copy; cat README',
                  contains: 'solved',
                },
              ],
              solution: ['echo solved >> README'],
            },
            prompt(3),
          ],
        },
      ],
    })
    const taskDir = taskDirFor(task)
    try {
      const result = await selfCheckTask(task, taskDir)
      expect(result.problems).toEqual([])
    } finally {
      delete process.env.RSI_SELF_CHECK_LEAK
    }
    // The real fixture is untouched.
    expect(readFileSync(join(taskDir, 'fixture', 'README'), 'utf8')).toBe('fixture\n')
    expect(existsSync(join(taskDir, 'fixture', 'made.txt'))).toBe(false)
  })

  it('kills commands that run too long', async () => {
    const task = sampleTask('slow', {
      sessions: [
        {
          prompts: [
            { text: 'p1', checks: [{ command: 'sleep 30', contains: 'x' }], solution: ['true'] },
            prompt(2),
            prompt(3),
          ],
        },
      ],
    })
    const result = await selfCheckTask(task, taskDirFor(task), { timeoutMs: 300 })
    expect(result.problems.join('\n')).toMatch(/timed out/)
  })
})

posixDescribe('bundled tasks', () => {
  it('every bundled task passes self-check', async () => {
    const tasks = loadSuite(defaultTasksDir)
    const outcomes = await Promise.all(
      tasks.map((task) => selfCheckTask(task, join(defaultTasksDir, task.id))),
    )
    const failures = outcomes.flatMap((outcome, index) =>
      outcome.problems.map((p) => `${tasks[index]?.id}: ${p}`),
    )
    expect(failures).toEqual([])
  }, 180_000)
})
