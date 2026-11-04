import { spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defaultTasksDir, loadSuite, sessionFixture, taskFixtures } from './suite.js'
import type { EvalTask } from './types.js'

export type SelfCheckResult = { ok: boolean; problems: string[] }
export type SelfCheckOptions = { timeoutMs?: number }

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_OUTPUT_BYTES = 1_000_000

export type CommandResult = { code: number | null; output: string; timedOut: boolean }

const insideGitRepo = (path: string): boolean => {
  let current = path
  for (;;) {
    if (existsSync(join(current, '.git'))) return true
    const parent = dirname(current)
    if (parent === current || current === parse(current).root) return false
    current = parent
  }
}

// Runs `bash -c command` with a fixed minimal environment and no stdin. The whole process group is
// killed on timeout so background children cannot outlive the command.
export const runCommand = (
  command: string,
  cwd: string,
  home: string,
  timeoutMs: number,
): Promise<CommandResult> =>
  new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: home,
        TERM: 'dumb',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let output = ''
    let timedOut = false
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_BYTES) output += chunk.toString('utf8')
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, output: `${output}${error.message}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output, timedOut })
    })
  })

// A check passes when the command exits 0 and its output (stdout and stderr) contains the text.
export const checkPasses = (result: CommandResult, contains: string): boolean =>
  !result.timedOut && result.code === 0 && result.output.includes(contains)

const DOC_FILE = /(^readme|\.md$|\.txt$)/i

/** Documentation files under `root` (README*, *.md, *.txt), as paths relative to it. */
const docFiles = (root: string, dir = root): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return docFiles(root, path)
    return entry.isFile() && DOC_FILE.test(entry.name) ? [relative(root, path)] : []
  })

/**
 * Proves a task is well formed without any model: the trap reproduces (in every fixture the task
 * uses), every prompt's checks fail on its session's untouched fixture, and each prompt's solution
 * alone makes its checks pass. For a cross-workspace task the second fixture's documentation must
 * not match a trap signature: the lesson has to come from the first workspace. Everything runs in
 * throwaway copies of the fixtures outside any git repository; the real fixtures are never touched.
 *
 * The runners check every prompt only after all sessions ended, in the workspace the sessions share.
 * So a last step makes a fresh copy of each fixture, runs the solutions of every prompt that uses it in
 * order, and requires every one of those prompts' checks to pass in that final state: a later prompt
 * or session must not undo what an earlier check looks for.
 *
 * A milestone prompt is different: the runner checks it right after it, in the workspace as the earlier
 * prompts left it. So its checks are judged in that same order instead, before and after its own solution,
 * with every earlier prompt's solution applied; they are not judged in the final state, and a milestone
 * is not solved from the untouched fixture on its own.
 */
export const selfCheckTask = async (
  task: EvalTask,
  taskDir: string,
  opts: SelfCheckOptions = {},
): Promise<SelfCheckResult> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const problems: string[] = []
  const fixtures = taskFixtures(task)
  const signatures = task.trap.signatures.map((signature) => new RegExp(signature))
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'rsi-self-check-'))
  try {
    if (insideGitRepo(root)) {
      return { ok: false, problems: [`temp directory ${root} is inside a git repository`] }
    }
    const home = join(root, 'home')
    mkdirSync(home)
    let copies = 0
    const freshCopy = (fixture: string): string => {
      const work = join(root, `work-${copies++}`)
      cpSync(join(taskDir, fixture), work, { recursive: true })
      return work
    }

    for (const fixture of fixtures) {
      // A single-fixture task keeps its messages as they were.
      const where = fixtures.length > 1 ? `${fixture}: ` : ''
      const reproduced = await runCommand(task.trap.reproduce, freshCopy(fixture), home, timeoutMs)
      if (reproduced.timedOut) {
        problems.push(`${where}trap.reproduce timed out after ${timeoutMs} ms`)
      } else if (!signatures.some((signature) => signature.test(reproduced.output))) {
        problems.push(
          `${where}trap.reproduce output matches none of the signatures: ${reproduced.output.trim().slice(0, 200)}`,
        )
      }
    }

    if (task.category === 'cross-workspace') {
      for (const fixture of fixtures.slice(1)) {
        for (const doc of docFiles(join(taskDir, fixture))) {
          const text = readFileSync(join(taskDir, fixture, doc), 'utf8')
          if (signatures.some((signature) => signature.test(text)))
            problems.push(`${fixture}: ${doc} mentions the trap; the second workspace must hold no clue`)
        }
      }
    }

    for (const [sessionIndex, session] of task.sessions.entries()) {
      for (const [promptIndex, prompt] of session.prompts.entries()) {
        if (prompt.milestone !== undefined) continue
        const label = `session ${sessionIndex} prompt ${promptIndex}`
        const work = freshCopy(sessionFixture(session))
        const runChecks = (): Promise<CommandResult[]> =>
          Promise.all(prompt.checks.map((check) => runCommand(check.command, work, home, timeoutMs)))

        const before = await runChecks()
        for (const [index, result] of before.entries()) {
          if (result.timedOut) problems.push(`${label} check ${index} timed out after ${timeoutMs} ms`)
          else if (checkPasses(result, prompt.checks[index]?.contains ?? '')) {
            problems.push(`${label} check ${index} passes before the solution`)
          }
        }

        let solved = true
        for (const command of prompt.solution) {
          const result = await runCommand(command, work, home, timeoutMs)
          if (result.timedOut) problems.push(`${label} solution timed out after ${timeoutMs} ms: ${command}`)
          else if (result.code !== 0) {
            problems.push(
              `${label} solution command failed (exit ${result.code}): ${command}: ${result.output.trim().slice(0, 200)}`,
            )
          }
          if (result.timedOut || result.code !== 0) {
            solved = false
            break
          }
        }
        if (!solved) continue

        const after = await runChecks()
        for (const [index, result] of after.entries()) {
          if (result.timedOut) problems.push(`${label} check ${index} timed out after ${timeoutMs} ms`)
          else if (!checkPasses(result, prompt.checks[index]?.contains ?? '')) {
            problems.push(
              `${label} check ${index} still fails after the solution: ${result.output.trim().slice(0, 200)}`,
            )
          }
        }
      }
    }

    for (const fixture of fixtures) {
      const prompts = task.sessions.flatMap((session, sessionIndex) =>
        sessionFixture(session) === fixture
          ? session.prompts.map((prompt, promptIndex) => ({
              prompt,
              label: `session ${sessionIndex} prompt ${promptIndex}`,
            }))
          : [],
      )
      const milestones = prompts.some(({ prompt }) => prompt.milestone !== undefined)
      if (prompts.length < 2 && !milestones) continue
      const work = freshCopy(fixture)
      let solved = true
      const judge = async (
        prompt: EvalTask['sessions'][number]['prompts'][number],
        label: string,
        after: boolean,
      ) => {
        for (const [index, check] of prompt.checks.entries()) {
          const result = await runCommand(check.command, work, home, timeoutMs)
          if (result.timedOut) problems.push(`${label} check ${index} timed out after ${timeoutMs} ms`)
          else if (checkPasses(result, check.contains) !== after)
            problems.push(
              after
                ? `${label} milestone check ${index} fails right after its solution, with every earlier solution applied: ${result.output.trim().slice(0, 200)}`
                : `${label} milestone check ${index} passes before its solution`,
            )
        }
      }
      for (const { prompt, label } of prompts) {
        if (prompt.milestone !== undefined && solved) await judge(prompt, label, false)
        for (const command of prompt.solution) {
          const result = await runCommand(command, work, home, timeoutMs)
          if (result.timedOut || result.code !== 0) {
            if (solved && prompt.milestone !== undefined)
              problems.push(
                `${label} solution command failed (exit ${result.code}): ${command}: ${result.output.trim().slice(0, 200)}`,
              )
            solved = false
          }
        }
        if (prompt.milestone !== undefined && solved) await judge(prompt, label, true)
      }
      // A solution that fails on its own is reported above; here only the final state matters.
      if (!solved) {
        problems.push(
          `${fixture}: running every prompt's solution in order failed, so the final state could not be checked`,
        )
        continue
      }
      for (const { prompt, label } of prompts) {
        if (prompt.milestone !== undefined) continue
        for (const [index, check] of prompt.checks.entries()) {
          const result = await runCommand(check.command, work, home, timeoutMs)
          if (!checkPasses(result, check.contains)) {
            problems.push(
              `${label} check ${index} fails in the final state, after every prompt's solution ran: ${result.output.trim().slice(0, 200)}`,
            )
          }
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { ok: problems.length === 0, problems }
}

const main = async (): Promise<void> => {
  const flag = process.argv.indexOf('--task')
  const only = flag >= 0 ? process.argv[flag + 1] : undefined
  if (flag >= 0 && !only) throw new Error('--task needs a task id')

  // Checking a single task does not need the whole suite to meet the size floors.
  const tasks = loadSuite(defaultTasksDir, only === undefined ? {} : { minTasks: 0 }).filter(
    (task) => only === undefined || task.id === only,
  )
  if (tasks.length === 0) throw new Error(`no task with id "${only}"`)

  let failed = 0
  for (const task of tasks) {
    const result = await selfCheckTask(task, join(defaultTasksDir, task.id))
    if (result.ok) console.log(`ok   ${task.id}`)
    else {
      failed++
      console.log(`FAIL ${task.id}`)
      for (const problem of result.problems) console.log(`     ${problem}`)
    }
  }
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
