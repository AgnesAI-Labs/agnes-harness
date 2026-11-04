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
// - `workspaceMustNotSay` is what no fixture file and no help text may contain.
type Rules = {
  tool: string
  naive: (commands: string[]) => string[]
  errorMustNotSay: RegExp[]
  workspaceMustNotSay: RegExp[]
  fix?: string
}

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
    fix: "bin/ship inspect alpha | sed -n 's/^build //p'",
  },
  'long-02-vendor-import': {
    tool: 'bin/ingest',
    // The natural import loads the vendor's file as it came.
    naive: (commands) =>
      commands.filter((c) => !c.startsWith('python3 - ')).map((c) => c.replace(/\.ready\.csv\b/, '.csv')),
    errorMustNotSay: [/cent/i, /schema/i, /order/i, /position/i, /column/i, /header/i],
    workspaceMustNotSay: [/cent/i, /position/i, /placed/i, /by order/i],
  },
  'long-03-config-rollout': {
    tool: 'bin/rollout',
    // The natural deploy goes straight to the environment asked for.
    naive: (commands) => commands.filter((c) => !/ shadow$/.test(c)),
    errorMustNotSay: [/shadow/i, /canary/i, /first/i, /before/i],
    workspaceMustNotSay: [/unproven/i, /prove/i, /gate/i, /before prod/i, /first/i],
  },
  'long-04-test-harness': {
    tool: 'bin/harness',
    // The natural run is the one the README shows, without a seed.
    naive: (commands) => commands.map((c) => c.replace(/ --seed \d+$/, '')),
    errorMustNotSay: [/seed/i, /\d{4}/, /suites/i],
    workspaceMustNotSay: [/1307|4441|2213|3089/, /reproducib/i, /registered/i],
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

describe('the long tasks', () => {
  it('are the four tasks the rules above cover', () => {
    expect(longTasks.map((task) => task.id).sort()).toEqual(Object.keys(RULES).sort())
  })

  it('run their tools packed: every launcher runs exactly its source and is executable', () => {
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
      it('is one session of 8 to 12 milestones, each with checks, a request cap, and the oracle after the first', () => {
        expect(task.sessions).toHaveLength(1)
        const all = prompts(task)
        expect(all.length).toBeGreaterThanOrEqual(8)
        expect(all.length).toBeLessThanOrEqual(12)
        for (const prompt of all) {
          expect(prompt.milestone).toBeTypeOf('string')
          expect(prompt.checks.length).toBeGreaterThan(0)
        }
        expect(new Set(all.map((p) => p.milestone)).size).toBe(all.length)
        expect(task.maxRequests).toBeTypeOf('number')
        expect(task.oracle).toEqual({ afterPrompt: 0 })
        expect(all[0]?.text).toMatch(/don't read their source/)
      })

      it('never states the rule in a prompt', () => {
        for (const prompt of prompts(task)) {
          expect(prompt.text).not.toMatch(/\b(remember|always|never|make sure|don't forget|note that)\b/i)
          for (const pattern of rules.workspaceMustNotSay)
            expect(prompt.text, pattern.source).not.toMatch(pattern)
        }
      })

      it('shows the rule nowhere in the workspace: no file, no help text', async () => {
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

      it('trips the natural approach at the first milestone with an error that does not say the fix', async () => {
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

      it('meets the rule again in at least three later milestones, where the natural solution trips it', async () => {
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
        expect(tripped[0]).toBe(0)
        expect(tripped.filter((index) => index > 0).length).toBeGreaterThanOrEqual(3)
      }, 120_000)
    })
  }
})
