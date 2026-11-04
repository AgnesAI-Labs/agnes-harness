import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { oracleApplies, oracleSeedPoint } from './agh/run-agh.js'
import { longTools, unpackTool } from './long-tools.js'
import { checkPasses, runCommand } from './self-check.js'
import { defaultTasksDir, loadSuite } from './suite.js'
import type { EvalTask } from './types.js'

// The long tasks are meant to be learnt from use, not read: no prompt states the rule, the trap's error
// does not say the fix, and nothing in the workspace (files, the tool's help) shows it. These tests hold
// each task to that and run what a naive agent would do. Per task:
// - `naive` turns a milestone's reference solution into the natural one that does not know the rule;
// - `errorMustNotSay` is what the trap's error must not contain (the fix's values, names and flags), and
//   `fix` prints, after the trap, the values the fix needs right then;
// - `workspaceMustNotSay` is what no fixture file and no help text may contain;
// - `probes` are the looks around a careful agent takes before it has failed once (after `setup`): what
//   they print must not give the rule away either.
type Rules = {
  tool: string
  naive: (commands: string[]) => string[]
  errorMustNotSay: RegExp[]
  workspaceMustNotSay: RegExp[]
  fix?: string
  probes: { setup?: string; command: string; mustNotSay: RegExp[] }[]
}

/** Each `python3 - <vendor file> <table> <copy> ...` conversion of a reference solution, as source and copy. */
const conversions = (commands: string[]) =>
  commands.flatMap((c) => {
    const m = /^python3 - (\S+) \S+ (\S+)/.exec(c)
    return m ? [{ source: m[1] as string, copy: m[2] as string }] : []
  })

const RULES: Record<string, Rules> = {
  'long-01-release-train': {
    tool: 'bin/ship',
    // The natural note says what changed and nothing about the build.
    naive: (commands) =>
      commands.map((c) =>
        c.includes('NEXT.md') ? `printf 'What changed.\\n' > ${/> (\S+NEXT\.md)$/.exec(c)?.[1]}` : c,
      ),
    errorMustNotSay: [/NEXT\.md/, /inspect/i, /\bid\b/i],
    workspaceMustNotSay: [/tied/i, /\bcite/i, /build id/i],
    fix: "bin/ship inspect alpha --verbose | sed -n 's/^build //p'",
    // Only `inspect --verbose` shows the id.
    probes: [{ setup: 'bin/ship build alpha', command: 'bin/ship inspect alpha', mustNotSay: [/^build /m] }],
  },
  'long-02-vendor-import': {
    tool: 'bin/ingest',
    // The natural import loads the vendor's file as it came.
    naive: (commands) => {
      const pairs = conversions(commands)
      return commands
        .filter((c) => !c.startsWith('python3 - '))
        .map((c) => pairs.reduce((out, { source, copy }) => out.replace(copy, source), c))
    },
    errorMustNotSay: [/cent/i, /schema/i, /order/i, /position/i, /column/i, /header/i],
    workspaceMustNotSay: [/cent/i, /position/i, /placed/i, /by order/i],
    // The schema names no unit and lists the columns in alphabetical order, not the table's.
    probes: ['orders', 'refunds'].map((table) => ({
      command: `bin/ingest schema ${table}`,
      mustNotSay: [/cent/i, /: id /, /placed date, amount/],
    })),
  },
  'long-03-config-rollout': {
    tool: 'bin/rollout',
    // The natural deploy goes straight to the environment asked for.
    naive: (commands) => commands.filter((c) => !/ shadow$/.test(c)),
    errorMustNotSay: [/shadow/i, /canary/i, /first/i, /before/i],
    workspaceMustNotSay: [/unproven/i, /prove/i, /gate/i, /before prod/i, /first/i],
    // Status shows the values, not the change ids that would show shadow and prod running the same change.
    probes: ['web', 'api', 'worker'].map((service) => ({
      command: `bin/rollout status ${service}`,
      mustNotSay: [/\b[0-9a-f]{8}\b/],
    })),
  },
  'long-04-test-harness': {
    tool: 'bin/harness',
    // The natural run is the one the README shows, without a seed.
    naive: (commands) => commands.map((c) => c.replace(/ --seed \d+$/, '')),
    errorMustNotSay: [/seed/i, /\d{4}/, /suites/i],
    workspaceMustNotSay: [/1307|4441|2213|3089/, /reproducib/i, /registered/i],
    // The suites' own seeds show only in the runs, next to every other seed.
    probes: [{ command: 'bin/harness suites', mustNotSay: [/1307|4441|2213|3089/, /seed/i] }],
  },
}

const suite = loadSuite(defaultTasksDir)
const longTasks = suite.filter((task) => task.category === 'long')
const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const scratch = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rsi-long-tasks-')))
  roots.push(root)
  return root
}
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  )
const prompts = (task: EvalTask) => task.sessions.flatMap((session) => session.prompts)
const signatures = (task: EvalTask) => task.trap.signatures.map((s) => new RegExp(s))
const run = (command: string, cwd: string, home: string) => runCommand(command, cwd, home, 20_000)

// The task tools are bash launchers that run python3, written for the Linux container the tasks run in,
// and the checks below that run them, or read their executable bit, need a POSIX host. The checks of
// the task files themselves run everywhere.
const posixIt = it.skipIf(process.platform === 'win32')

describe('the long tasks', () => {
  it('are the four tasks the rules above cover', () => {
    expect(longTasks.map((task) => task.id).sort()).toEqual(Object.keys(RULES).sort())
  })

  posixIt('run their tools packed: every launcher runs exactly its source and is executable', () => {
    const tools = longTools()
    expect(tools.map((t) => relative(defaultTasksDir, t.launcher)).sort()).toEqual(
      longTasks.map((task) => `${task.id}/fixture/${RULES[task.id]?.tool}`).sort(),
    )
    for (const tool of tools) {
      expect(unpackTool(readFileSync(tool.launcher, 'utf8')), tool.launcher).toBe(
        readFileSync(tool.source, 'utf8'),
      )
      expect(statSync(tool.launcher).mode & 0o111, tool.launcher).not.toBe(0)
    }
  })

  it('keep the reviewers notes and the tool sources out of every workspace', () => {
    // The runner and the self-check copy a task's fixture directories only; LONG.md sits beside the tasks.
    expect(existsSync(join(defaultTasksDir, 'LONG.md'))).toBe(true)
    const sources = new Set(longTools().map((t) => readFileSync(t.source, 'utf8')))
    for (const task of suite)
      for (const file of filesUnder(join(defaultTasksDir, task.id, 'fixture'))) {
        expect(file.endsWith('LONG.md'), file).toBe(false)
        expect(sources.has(readFileSync(file, 'utf8')), file).toBe(false)
      }
  })

  for (const task of longTasks) {
    const rules = RULES[task.id] as Rules
    describe(task.id, () => {
      it('is five sessions of two milestones in one workspace, each with checks, a request cap, and the oracle before the second', () => {
        expect(task.sessions.map((s) => s.prompts.length)).toEqual([2, 2, 2, 2, 2])
        expect(task.sessions.every((s) => s.fixture === undefined)).toBe(true)
        const all = prompts(task)
        for (const prompt of all) {
          expect(prompt.milestone).toBeTypeOf('string')
          expect(prompt.checks.length).toBeGreaterThan(0)
        }
        expect(new Set(all.map((p) => p.milestone)).size).toBe(all.length)
        expect(task.maxRequests).toBeTypeOf('number')
        // The lesson is written after the first session, so the oracle's gap to off leaves out the first discovery.
        expect(task.oracle).toBeUndefined()
        expect(oracleApplies(task)).toBe(true)
        expect(oracleSeedPoint(task)).toEqual({ beforeSession: 1 })
        // Every session is a new conversation: each one is told not to read the tools.
        for (const session of task.sessions)
          expect(session.prompts[0]?.text).toMatch(/don't read their source/)
      })

      it('never states the rule in a prompt', () => {
        for (const prompt of prompts(task)) {
          expect(prompt.text).not.toMatch(/\b(remember|always|never|make sure|don't forget|note that)\b/i)
          for (const pattern of rules.workspaceMustNotSay)
            expect(prompt.text, pattern.source).not.toMatch(pattern)
        }
      })

      posixIt('shows the rule nowhere in the workspace: no file, no help text', async () => {
        const fixture = join(defaultTasksDir, task.id, 'fixture')
        const home = scratch()
        const help = await run(`${rules.tool} help`, fixture, home)
        expect(help.code).toBe(0)
        const texts = [
          ...filesUnder(fixture).map((file) => ({
            where: relative(fixture, file),
            text: readFileSync(file, 'latin1'),
          })),
          ...filesUnder(fixture).map((file) => ({
            where: `name ${relative(fixture, file)}`,
            text: relative(fixture, file),
          })),
          { where: 'help', text: help.output },
        ]
        for (const { where, text } of texts)
          for (const pattern of rules.workspaceMustNotSay)
            expect(text, `${where}: ${pattern.source}`).not.toMatch(pattern)
      })

      posixIt('gives the rule away in none of the looks a careful agent takes before its first failure', async () => {
        for (const probe of rules.probes) {
          const work = join(scratch(), 'work')
          const home = scratch()
          cpSync(join(defaultTasksDir, task.id, 'fixture'), work, { recursive: true })
          if (probe.setup) expect((await run(probe.setup, work, home)).code).toBe(0)
          const out = await run(probe.command, work, home)
          expect(out.code, out.output).toBe(0)
          for (const pattern of probe.mustNotSay)
            expect(out.output, `${probe.command}: ${pattern.source}`).not.toMatch(pattern)
        }
      })

      posixIt('trips the natural approach at the first milestone with an error that does not say the fix', async () => {
        const work = join(scratch(), 'work')
        const home = scratch()
        cpSync(join(defaultTasksDir, task.id, 'fixture'), work, { recursive: true })
        const trap = await run(task.trap.reproduce, work, home)
        expect(trap.code).not.toBe(0)
        const line = trap.output.split('\n').find((l) => signatures(task).some((s) => s.test(l)))
        expect(line, trap.output).toBeDefined()
        for (const pattern of rules.errorMustNotSay) expect(line, pattern.source).not.toMatch(pattern)
        if (rules.fix) {
          const values = (await run(rules.fix, work, home)).output.split('\n').filter(Boolean)
          expect(values.length).toBeGreaterThan(0)
          for (const value of values) expect(line).not.toContain(value)
        }
        const first = prompts(task)[0]
        const results = await Promise.all((first?.checks ?? []).map((c) => run(c.command, work, home)))
        expect(results.some((r, i) => !checkPasses(r, first?.checks[i]?.contains ?? ''))).toBe(true)
      })

      posixIt('meets the rule at the first milestone of every session, where the natural solution trips it', async () => {
        const root = scratch()
        const home = scratch()
        const work = join(root, 'work')
        cpSync(join(defaultTasksDir, task.id, 'fixture'), work, { recursive: true })
        const tripped: number[] = []
        for (const [index, prompt] of prompts(task).entries()) {
          const naive = join(root, `naive-${index}`)
          cpSync(work, naive, { recursive: true })
          for (const command of rules.naive(prompt.solution)) {
            const result = await run(command, naive, home)
            if (result.code !== 0) {
              if (signatures(task).some((s) => s.test(result.output))) tripped.push(index)
              break
            }
          }
          for (const command of prompt.solution)
            expect((await run(command, work, home)).code, command).toBe(0)
        }
        // A new session starts without the rule in its context: its first milestone must trip the natural way.
        const firsts = task.sessions.map((_, s) =>
          task.sessions.slice(0, s).reduce((sum, session) => sum + session.prompts.length, 0),
        )
        for (const first of firsts) expect(tripped, `milestone ${first + 1}`).toContain(first)
      }, 120_000)
    })
  }
})
