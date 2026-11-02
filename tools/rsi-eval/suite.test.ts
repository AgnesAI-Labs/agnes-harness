import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// Writes `tasks` as <root>/<dir>/task.json plus an empty fixture/, and returns the root.
const writeSuite = (tasks: { dir: string; json: unknown }[]): string => {
  const root = mkdtempSync(join(tmpdir(), 'rsi-suite-test-'))
  roots.push(root)
  for (const { dir, json } of tasks) {
    mkdirSync(join(root, dir, 'fixture'), { recursive: true })
    writeFileSync(join(root, dir, 'fixture', 'README'), 'fixture\n')
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

  it('requires a fixture directory', () => {
    const root = writeSuite([{ dir: 'a', json: sampleTask('a') }])
    rmSync(join(root, 'a', 'fixture'), { recursive: true })
    expect(() => loadSuite(root, relaxed)).toThrow(/missing fixture/)
  })

  it('enforces the size floors, and a smaller minTasks relaxes both floors', () => {
    const root = writeSuite([{ dir: 'a', json: sampleTask('a') }])
    expect(() => loadSuite(root)).toThrow(/at least 20 tasks/)
    expect(() => loadSuite(root, { minTasks: 1 })).not.toThrow()

    const prompts = [prompt(1), prompt(2), prompt(3)]
    const lopsided = writeSuite(
      Array.from({ length: 20 }, (_, index) => {
        const id = `t${String(index).padStart(2, '0')}`
        return { dir: id, json: sampleTask(id, { category: 'directory', sessions: [{ prompts }] }) }
      }),
    )
    expect(() => loadSuite(lopsided)).toThrow(/at least 5 .* tasks/)
  })
})

// The task commands are bash, make and python3 scripts: they are written for the Linux container the
// tasks run in, and the self-check runs them on the host, so it needs a POSIX host. The format checks
// in `loadSuite` above run everywhere.
const posixDescribe = describe.skipIf(process.platform === 'win32')

posixDescribe('selfCheckTask', () => {
  const taskDirFor = (task: EvalTask, files: Record<string, string> = {}): string => {
    const root = writeSuite([{ dir: task.id, json: task }])
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, task.id, 'fixture', name)), { recursive: true })
      writeFileSync(join(root, task.id, 'fixture', name), content)
    }
    return join(root, task.id)
  }

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
