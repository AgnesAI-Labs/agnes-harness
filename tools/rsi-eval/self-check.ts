import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defaultTasksDir, loadSuite } from './suite.js'
import type { EvalTask } from './types.js'

export type SelfCheckResult = { ok: boolean; problems: string[] }
export type SelfCheckOptions = { timeoutMs?: number }

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_OUTPUT_BYTES = 1_000_000

type CommandResult = { code: number | null; output: string; timedOut: boolean }

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
const runCommand = (command: string, cwd: string, home: string, timeoutMs: number): Promise<CommandResult> =>
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
const checkPasses = (result: CommandResult, contains: string): boolean =>
  !result.timedOut && result.code === 0 && result.output.includes(contains)

/**
 * Proves a task is well formed without any model: the trap reproduces, every prompt's checks fail
 * on the untouched fixture, and each prompt's solution alone makes its checks pass. Everything runs
 * in throwaway copies of the fixture outside any git repository; the real fixture is never touched.
 */
export const selfCheckTask = async (
  task: EvalTask,
  taskDir: string,
  opts: SelfCheckOptions = {},
): Promise<SelfCheckResult> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const problems: string[] = []
  const fixture = join(taskDir, 'fixture')
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'rsi-self-check-'))
  try {
    if (insideGitRepo(root)) {
      return { ok: false, problems: [`temp directory ${root} is inside a git repository`] }
    }
    const home = join(root, 'home')
    mkdirSync(home)
    let copies = 0
    const freshCopy = (): string => {
      const work = join(root, `work-${copies++}`)
      cpSync(fixture, work, { recursive: true })
      return work
    }

    const reproduced = await runCommand(task.trap.reproduce, freshCopy(), home, timeoutMs)
    if (reproduced.timedOut) {
      problems.push(`trap.reproduce timed out after ${timeoutMs} ms`)
    } else if (!task.trap.signatures.some((signature) => new RegExp(signature).test(reproduced.output))) {
      problems.push(
        `trap.reproduce output matches none of the signatures: ${reproduced.output.trim().slice(0, 200)}`,
      )
    }

    for (const [sessionIndex, session] of task.sessions.entries()) {
      for (const [promptIndex, prompt] of session.prompts.entries()) {
        const label = `session ${sessionIndex} prompt ${promptIndex}`
        const work = freshCopy()
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
