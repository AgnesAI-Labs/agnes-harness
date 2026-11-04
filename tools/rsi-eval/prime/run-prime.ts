// Runs eval tasks through Prime Agent inside Docker, unattended, with refinement on or off.
//
// Prime has no sandbox, so it only ever runs in a container. Each run gets a fresh agent
// directory (settings.json, models.json) and a throwaway copy of every fixture its sessions use:
// <run>/work for the default fixture, mounted at /work, and <run>/work-b for fixture-b, mounted at
// /work-b. Sessions that use the same fixture share its copy; every session of a run shares the
// agent directory, so what `/refine --global` saves reaches the next workspace. Model
// traffic goes through the local usage proxy at /run/<runId>/. The API key is never written
// anywhere: the container receives it by variable name (`docker run -e NAME`) and models.json
// refers to that same name, which Prime resolves from its own environment.

import { spawn } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { DEFAULT_FIXTURE, fixtureOf, taskFixtures, workspaceName } from '../suite.js'
import type { EvalTask, RunConfig, RunOutcome, Setting } from '../types.js'

export const DEFAULT_IMAGE = 'rsi-eval-prime:9cf0d47'
const CHECK_TIMEOUT_MS = 120_000
const defaultTasksDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tasks')

export type RunOptions = {
  /**
   * Directory copied into the workspace. Defaults to `<tasksDir>/<task.id>/fixture`; another fixture
   * a session names is its sibling.
   */
  fixtureDir?: string
  /** Docker image to run. */
  image?: string
  /** Replaces the docker executable: first element is the program, the rest are leading args. Defaults to `['docker']`. */
  dockerCommand?: string[]
}

export const runId = (taskId: string, setting: Setting | 'oracle', rep: number): string =>
  `${taskId}.${setting}.r${rep}`

export function primeSettings(setting: Setting, cfg: RunConfig): object {
  return {
    harnessRefinements: setting === 'on',
    defaultProvider: cfg.provider,
    defaultModel: cfg.model,
    subagentDefaultModel: cfg.model,
  }
}

/**
 * models.json for one run. `apiKey` holds the NAME of the environment variable, not a key:
 * Prime resolves a bare apiKey string from the environment (see the Dockerfile notes).
 */
export function primeModels(cfg: RunConfig, id: string): object {
  return {
    providers: {
      [cfg.provider]: {
        baseUrl: `http://host.docker.internal:${cfg.proxyPort}/run/${id}/`,
        apiKey: cfg.keyEnv,
        api: cfg.api,
        models: [{ id: cfg.model, cost: { ...cfg.prices } }],
      },
    },
  }
}

/** Where a session's workspace is mounted in its container: /work, or /work-b for fixture-b. */
export const mountPoint = (task: EvalTask, sessionIndex: number): string =>
  `/${workspaceName(fixtureOf(task, sessionIndex))}`

/** Workflow tasks need the `workflow` tool, which Prime does not have; they run on AGH only. */
export const primeTasks = (tasks: EvalTask[]): EvalTask[] => tasks.filter((t) => t.category !== 'workflow')

/** The tasks whose first session ends with a save that outlives the workspace. */
const CARRIES_OVER: ReadonlySet<EvalTask['category']> = new Set(['cross-session', 'cross-workspace'])

export function primeArgv(task: EvalTask, sessionIndex: number, setting: Setting, cfg: RunConfig): string[] {
  const prompts = (task.sessions[sessionIndex]?.prompts ?? []).map((p) => p.text)
  const messages: string[] = []
  for (const text of prompts) {
    messages.push(text)
    if (setting === 'on') messages.push('/refine')
  }
  if (setting === 'on' && CARRIES_OVER.has(task.category) && sessionIndex === 0) {
    messages[messages.length - 1] = '/refine --global'
  }
  return [
    'prime-agent',
    '--mode',
    'json',
    '--cwd',
    mountPoint(task, sessionIndex),
    '--provider',
    cfg.provider,
    '--model',
    cfg.model,
    '-p',
    ...messages,
  ]
}

type DockerResult = { code: number | null; timedOut: boolean }

/** Runs `<docker command> <args>` with output sent to files; kills the named container on timeout. */
function runDocker(
  args: string[],
  stdoutFile: string,
  stderrFile: string | null,
  timeoutMs: number,
  name: string,
  docker: string[],
) {
  const [exe, ...lead] = docker
  if (!exe) throw new Error('dockerCommand must have at least one element')
  return new Promise<DockerResult>((resolveRun, reject) => {
    const outFd = openSync(stdoutFile, 'w')
    const errFd = stderrFile ? openSync(stderrFile, 'w') : outFd
    const child = spawn(exe, [...lead, ...args], { stdio: ['ignore', outFd, errFd] })
    let timedOut = false
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      closeSync(outFd)
      if (errFd !== outFd) closeSync(errFd)
      fn()
    }
    const timer = setTimeout(() => {
      timedOut = true
      // Stop the container first, then make sure the client process is gone as well.
      const killer = spawn(exe, [...lead, 'kill', name], { stdio: 'ignore' })
      killer.on('error', () => child.kill('SIGKILL'))
      killer.on('exit', () => child.kill('SIGKILL'))
    }, timeoutMs)
    child.on('error', (error) => finish(() => reject(error)))
    child.on('exit', (code) => finish(() => resolveRun({ code: timedOut ? null : code, timedOut })))
  })
}

/** Containers run as uid 1000; make the mounted trees writable for it whatever the host uid is. */
function openPermissions(root: string): void {
  chmodSync(root, 0o777)
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) openPermissions(path)
    else if (entry.isFile()) chmodSync(path, statSync(path).mode | 0o666)
  }
}

function listJsonl(root: string): string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...listJsonl(path))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path)
  }
  return found.sort()
}

export async function runOne(
  task: EvalTask,
  setting: Setting,
  rep: number,
  cfg: RunConfig,
  outDir: string,
  opts: RunOptions = {},
): Promise<RunOutcome> {
  const id = runId(task.id, setting, rep)
  const runDir = resolve(outDir, id)
  const outcomeFile = join(runDir, 'outcome.json')
  if (existsSync(outcomeFile)) return JSON.parse(readFileSync(outcomeFile, 'utf8')) as RunOutcome

  const image = opts.image ?? DEFAULT_IMAGE
  const docker = opts.dockerCommand ?? ['docker']
  const fixtureDir = opts.fixtureDir ?? join(defaultTasksDir, task.id, 'fixture')
  const agentDir = join(runDir, 'agent')
  const workDirOf = (sessionIndex: number): string =>
    join(runDir, workspaceName(fixtureOf(task, sessionIndex)))
  const sessionsOut = join(runDir, 'sessions')
  const checksOut = join(runDir, 'checks')

  // A directory without an outcome is a partial run: start it over.
  rmSync(runDir, { recursive: true, force: true })
  for (const dir of [agentDir, sessionsOut, checksOut]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(agentDir, 'settings.json'), `${JSON.stringify(primeSettings(setting, cfg), null, 2)}\n`)
  writeFileSync(join(agentDir, 'models.json'), `${JSON.stringify(primeModels(cfg, id), null, 2)}\n`)
  for (const fixture of taskFixtures(task)) {
    const workDir = join(runDir, workspaceName(fixture))
    cpSync(fixture === DEFAULT_FIXTURE ? fixtureDir : join(dirname(fixtureDir), fixture), workDir, {
      recursive: true,
    })
    openPermissions(workDir)
  }
  openPermissions(agentDir)

  const sessions: RunOutcome['sessions'] = []
  const seen = new Set<string>()
  for (let i = 0; i < task.sessions.length; i++) {
    const name = `rsi-${id}-s${i + 1}-${process.pid}`
    const stdoutFile = join(runDir, `session${i + 1}.stdout.jsonl`)
    const args = [
      'run',
      '--rm',
      '--name',
      name,
      '--add-host',
      'host.docker.internal:host-gateway',
      '-v',
      `${workDirOf(i)}:${mountPoint(task, i)}`,
      '-v',
      `${agentDir}:/agent`,
      '-e',
      'PRIME_AGENT_CODING_AGENT_DIR=/agent',
      '-e',
      'PRIME_AGENT_TELEMETRY=0',
      '-e',
      cfg.keyEnv,
      image,
      ...primeArgv(task, i, setting, cfg),
    ]
    const result = await runDocker(
      args,
      stdoutFile,
      join(runDir, `session${i + 1}.stderr.log`),
      cfg.sessionTimeoutMs,
      name,
      docker,
    )

    // Session transcripts are written into the shared agent dir; take the ones this session added.
    const sessionFiles: string[] = []
    for (const file of listJsonl(join(agentDir, 'sessions'))) {
      if (seen.has(file)) continue
      seen.add(file)
      const copy = join(sessionsOut, `s${i + 1}.${sessionFiles.length + 1}.${basename(file)}`)
      cpSync(file, copy)
      sessionFiles.push(copy)
    }
    sessions.push({ exitCode: result.code, timedOut: result.timedOut, stdoutFile, sessionFiles })

    // A failed or timed-out session ends the run: later sessions would build on missing work.
    if (result.timedOut || result.code !== 0) break
  }

  // Checks run after every session, in a container without network (the workspace holds
  // model-written code), and only for sessions that ended cleanly. Prompts of a session that
  // failed part-way are left without a result instead of being counted as passed.
  const checks: RunOutcome['checks'] = []
  for (const [s, session] of sessions.entries()) {
    if (session.timedOut || session.exitCode !== 0) continue
    for (const [p, taskPrompt] of (task.sessions[s]?.prompts ?? []).entries()) {
      let passed = true
      for (const [c, check] of taskPrompt.checks.entries()) {
        const name = `rsi-${id}-check-s${s + 1}p${p + 1}c${c + 1}-${process.pid}`
        const outFile = join(checksOut, `s${s + 1}.p${p + 1}.c${c + 1}.out`)
        const result = await runDocker(
          [
            'run',
            '--rm',
            '--name',
            name,
            '--network',
            'none',
            '-v',
            `${workDirOf(s)}:/work`,
            '-w',
            '/work',
            image,
            'bash',
            '-lc',
            check.command,
          ],
          outFile,
          null,
          CHECK_TIMEOUT_MS,
          name,
          docker,
        )
        // Same rule as the task self-check: the command exits 0 and its output contains the marker.
        if (result.timedOut || result.code !== 0 || !readFileSync(outFile, 'utf8').includes(check.contains)) {
          passed = false
        }
      }
      checks.push({ session: s, prompt: p, passed })
    }
  }

  const outcome: RunOutcome = { runId: id, sessions, checks }
  writeFileSync(outcomeFile, `${JSON.stringify(outcome, null, 2)}\n`)
  return outcome
}

// ------------------------------------------------------------------ CLI

export function readConfig(file: string): RunConfig {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const strings = ['provider', 'api', 'upstream', 'model', 'keyEnv'] as const
  for (const key of strings) {
    if (typeof raw[key] !== 'string' || raw[key] === '')
      throw new Error(`run-config: "${key}" must be a non-empty string`)
  }
  const prices = raw.prices as Record<string, unknown> | undefined
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    if (typeof prices?.[key] !== 'number') throw new Error(`run-config: prices.${key} must be a number`)
  }
  if (raw.pricesAssumed !== undefined && typeof raw.pricesAssumed !== 'boolean')
    throw new Error('run-config: "pricesAssumed" must be true or false when given')
  for (const key of ['proxyPort', 'sessionTimeoutMs']) {
    if (typeof raw[key] !== 'number') throw new Error(`run-config: "${key}" must be a number`)
  }
  return raw as unknown as RunConfig
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      out: { type: 'string' },
      tasks: { type: 'string' },
      reps: { type: 'string', default: '3' },
      settings: { type: 'string', default: 'on,off' },
      image: { type: 'string', default: DEFAULT_IMAGE },
      'tasks-dir': { type: 'string', default: defaultTasksDir },
    },
  })
  if (!values.config || !values.out) {
    throw new Error(
      'usage: run-prime.ts --config <run-config.json> --out <dir> [--tasks a,b] [--reps 3] [--settings on,off] [--image <tag>]',
    )
  }
  const cfg = readConfig(values.config)
  if (!process.env[cfg.keyEnv]) {
    throw new Error(`environment variable ${cfg.keyEnv} (run-config keyEnv) is not set in this shell`)
  }
  const reps = Number(values.reps)
  if (!Number.isInteger(reps) || reps < 1) throw new Error('--reps must be a positive integer')
  const settings = (values.settings as string).split(',').map((s) => s.trim())
  for (const s of settings) if (s !== 'on' && s !== 'off') throw new Error(`unknown setting "${s}"`)

  const [{ loadSuite }, { startUsageProxy }] = await Promise.all([
    import('../suite.js'),
    import('../usage-proxy.js'),
  ])
  const tasksDir = resolve(values['tasks-dir'] as string)
  const suite = loadSuite(tasksDir)
  let tasks = primeTasks(suite)
  if (values.tasks) {
    const wanted = values.tasks.split(',').map((s) => s.trim())
    const workflow = wanted.filter((id) => suite.some((t) => t.id === id && t.category === 'workflow'))
    if (workflow.length > 0)
      throw new Error(`these tasks need the workflow tool, which Prime does not have: ${workflow.join(', ')}`)
    const missing = wanted.filter((id) => !tasks.some((t) => t.id === id))
    if (missing.length > 0) throw new Error(`unknown task ids: ${missing.join(', ')}`)
    tasks = tasks.filter((t) => wanted.includes(t.id))
  }

  // RSI_EVAL_DOCKER: path of a docker-compatible executable to use instead of `docker` on PATH.
  const dockerCommand = process.env.RSI_EVAL_DOCKER ? [process.env.RSI_EVAL_DOCKER] : undefined

  const out = resolve(values.out)
  mkdirSync(out, { recursive: true })
  const proxy = await startUsageProxy({
    upstream: cfg.upstream,
    port: cfg.proxyPort,
    logFile: join(out, 'usage.jsonl'),
  })
  try {
    for (let rep = 1; rep <= reps; rep++) {
      for (const task of tasks) {
        for (const setting of settings as Setting[]) {
          const id = runId(task.id, setting, rep)
          const fresh = !existsSync(join(out, id, 'outcome.json'))
          const outcome = await runOne(task, setting, rep, cfg, out, {
            image: values.image,
            fixtureDir: join(tasksDir, task.id, 'fixture'),
            ...(dockerCommand ? { dockerCommand } : {}),
          })
          const exits = outcome.sessions.map((s) => (s.timedOut ? 'timeout' : String(s.exitCode))).join(',')
          const passed = outcome.checks.filter((c) => c.passed).length
          console.error(
            `${fresh ? 'ran' : 'skipped'} ${id} exit=[${exits}] checks=${passed}/${outcome.checks.length} (${relative(process.cwd(), join(out, id))})`,
          )
        }
      }
    }
  } finally {
    await proxy.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
