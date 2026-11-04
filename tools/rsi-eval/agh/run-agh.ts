// Runs the eval tasks through AGH, unattended, with task experience (refinement) on and off.
//
// COST WARNING: this calls a real model and spends money on the account behind the key. Run it
// only after the owner has approved the spend. See "Cost" below for what drives it.
//
// Usage, from the repository root (build once first, as for the loop bench):
//
//   pnpm install --frozen-lockfile
//   pnpm --filter @agnes/host build:native
//   pnpm --filter @agnes/system-node build:native
//   export RSI_EVAL_API_KEY=...            # the variable named by keyEnv in the run config
//   pnpm exec tsx tools/rsi-eval/agh/run-agh.ts --config <run-config.json> --out <dir> \
//     [--tasks a,b] [--reps 3] [--arms off,on,oracle] [--tasks-dir <dir>]
//   pnpm exec tsx tools/rsi-eval/report.ts --run-dir <dir> --config <run-config.json>
//
// The run config is the one the Prime runner takes (run-config.example.json): the same route, model,
// prices, proxy port and session timeout, so the two systems are measured the same way. `provider`
// becomes the AGH route name (lower case letters, digits and dashes) and `api` must be an API AGH
// speaks (for example anthropic-messages or openai-completions). The run config has no context
// window, so the model is declared with 200,000 tokens of context and 8,192 of output. Keep --out
// outside any git repository. The task commands and checks need bash, python3 and make on PATH.
//
// What one run is: a task, a setting and a repetition. Each run gets a home of its own under
// <out>/<runId>/home (its data dir, sessions.db, memory and the refinement switch live there, never
// in your AGH_HOME) and a throwaway workspace outside any git repository for every fixture its
// sessions use, copied to <out>/<runId>/work (and work-b for fixture-b) at the end. Sessions that use
// the same fixture share its workspace, so the second session of a cross-session task is in the same
// project; the second session of a cross-workspace task is in another one, under the same home. The
// host is embedded in this process. Model traffic goes through the usage proxy at /run/<runId>/ like
// the Prime runs, so report.ts prices both the same way.
//
// Memory, in both settings alike: every workspace's memory is on in automatic mode and reads the
// user memory (EVAL_MEMORY), so on and off differ only in refinement.
//
// On: the switch on, mode "manual and automatic", and after every prompt one manual review (the
// request `/refine` makes), waited for before the next prompt, as the Prime runs send `/refine`
// after every prompt. Every approval is given, as Prime runs without asking. AGH keeps entries per
// session, so the second session of a cross-session task starts empty. Where Prime ends the first
// session of a cross-workspace task with `/refine --global` (in place of its last `/refine`), this
// runner makes its last review of that session the user's own save to user memory (`/refine --user`),
// so what is carried to the second workspace is the same kind of save.
// A workflow task is different: its first session ends with the user's save to the workspace
// (`/refine --workspace`), in place of the last review, so the skill it saves can be read from that
// workspace afterwards. Both of its sessions use that one workspace, so the second session is a new
// session where the saved skill is.
// Off: no switch file at all, which is the default.
// Oracle (opt-in with `--arms off,on,oracle`; `--settings` is the same option, older name, on and off only):
// refinement off as in "off", and before the SECOND session starts, one paragraph taken from the task's
// `trap.note` is written to that session's workspace memory, through the same edit the memory page makes.
// The first session is the same as the off run's. It is the most a saved lesson could give the second
// session, so it is the ceiling the "on" run is measured against (see capture.ts). Only for tasks of two
// sessions that are not workflow tasks; the other tasks are skipped for this arm.
//
// No goal: the sessions are unattended and are given no goal. The goal extension has no quiet
// way to set one: `/goal create` starts automatic rounds of its own on the main model (up to
// --max-rounds, racing the next prompt and changing what a run costs), and a task-level lesson
// without a goal expires. So the tasks put a plain user correction in the second prompt of the
// first session; a lesson can quote it, which a session-level lesson needs.
//
// The key: read only from the environment variable named by keyEnv, never written to a file or
// printed. It is handed to the host in this process's environment as the secret the route refers
// to; commands the agent runs get a fixed small environment without it.
//
// Cost: every prompt is a full agent turn on the main model; with refinement on, each prompt adds
// one review (input up to about 24,000 tokens, output up to 4,096, at most 524,288 tokens per
// session) plus the experience notes in later requests; the host also names each session with one
// short call. The total grows with tasks x prompts x reps x 2 settings.

import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createInfraStreak, INFRA_STOP_AFTER, infraFromLedger, infraFromStatuses } from '../infra.js'
import { readConfig, runId } from '../prime/run-prime.js'
import { DEFAULT_FIXTURE, fixtureOf, taskFixtures, workspaceName } from '../suite.js'
import type { Arm, EvalTask, InfraFailure, RunConfig, RunOutcome } from '../types.js'

const defaultTasksDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tasks')

/** The profile every run's home uses. */
export const PROFILE = 'local-dev'
/** The secret the route names; the host resolves it from `SECRET_ENV` in this process. */
export const SECRET_REF = 'secret://rsi-eval/key'
/** How the host's environment secrets read `SECRET_REF`: AGNES_SECRET_<NS>_<NAME>, upper case. */
export const SECRET_ENV = 'AGNES_SECRET_RSI_EVAL_KEY'
/** Longest wait for one manual review to finish: the manual planner deadline (90 s) and some room. */
export const REFINE_WAIT_MS = 180_000
const CHECK_TIMEOUT_MS = 120_000
const ROUTE = /^[a-z0-9][a-z0-9-]{0,63}$/

// ------------------------------------------------------------------ what the runner needs of a host

/** The refinement switch of a run, as the settings panel would save it; absent means never saved (off). */
export type RefinementSwitch = { enabled: true; mode: 'auto' }

/** The memory settings every workspace of a run gets, in both settings alike. */
export type EvalMemory = { mode: 'auto'; userEnabled: true }
export const EVAL_MEMORY: EvalMemory = Object.freeze({ mode: 'auto', userEnabled: true })

export type LaunchInput = {
  /** A directory that does not exist yet; the launcher makes it the run's home. */
  home: string
  profile: string
  /** Written as the profile file: the one route, pointing at the usage proxy. */
  profileDocument: object
  refinement: RefinementSwitch | undefined
  /** The workspace the host starts in: the first session's. */
  workspace: string
  /** Every workspace the run's sessions use, once each, the first session's first. */
  workspaces: string[]
  /** Saved as the memory settings of every workspace in `workspaces`. */
  memory: EvalMemory
  model: { route: string; model: string }
  /** The environment the host gets: AGH_HOME is the run's home. */
  env: Record<string, string | undefined>
}

/** One event of a session's ledger, every lane, as it is written to the run's session file. */
export type LedgerRow = {
  seq: number
  ts: string
  type: string
  lane: string | null
  origin: string | null
  data: unknown
}

export type ReviewAnswer = { runId: string } | { refused: string }

export interface AghSession {
  readonly key: string
  /** One turn; resolves with how it ended (`completed`, `failed`, ...). */
  prompt(text: string, signal: AbortSignal): Promise<string>
  /**
   * Asks for one manual review of this session; with `saveTo` the result is also saved as the user's own
   * save, to the workspace (`/refine --workspace`) or to user memory (`/refine --user`).
   */
  review(saveTo?: 'workspace' | 'user'): Promise<ReviewAnswer>
  /** The review's final state, or undefined when it has none within `ms`. */
  settled(runId: string, ms: number): Promise<string | undefined>
  close(): Promise<void>
}

export interface AghHost {
  /** Opens a session in `workspace`, one of the launch input's `workspaces`. */
  openSession(sessionKey: string, workspace: string): Promise<AghSession>
  /**
   * Adds a paragraph to the memory of one of the run's workspaces, as a person's own edit of it, in
   * effect from the next session that opens there. Needed for the oracle arm only.
   */
  seedMemory?(workspace: string, text: string): Promise<void>
  close(): Promise<void>
  /** Every row of a session's ledger, read after `close`. */
  ledger(sessionKey: string): LedgerRow[]
}

export type Launch = (input: LaunchInput) => Promise<AghHost>
/** Runs one check in the workspace: true when it passes. */
export type CheckRun = (
  check: { command: string; contains: string },
  cwd: string,
  home: string,
  timeoutMs: number,
) => Promise<boolean>

export type AghRunOptions = {
  launch: Launch
  /**
   * Directory copied into the workspace. Defaults to `<tasksDir>/<task.id>/fixture`; another fixture
   * a session names is its sibling.
   */
  fixtureDir?: string
  /** Where throwaway workspaces are made; must be outside any git repository. Defaults to the temp dir. */
  workBase?: string
  /** Runs one check; defaults to bash with a small fixed environment, as the task self-check does. */
  runCheck?: CheckRun
  /** The statuses the usage proxy saw for a run id, oldest first; for a run that ended without a readable ledger error. */
  statuses?: (proxyRunId: string) => number[]
}

/** The outcome of a run that is finished for good: one the infrastructure ended is not, it is redone. */
export const finishedOutcome = (outDir: string, id: string): RunOutcome | undefined => {
  const file = join(outDir, id, 'outcome.json')
  if (!existsSync(file)) return undefined
  const outcome = JSON.parse(readFileSync(file, 'utf8')) as RunOutcome
  return outcome.infraFailed ? undefined : outcome
}

/** The exit code of a shard that stopped because the infrastructure kept ending its runs. */
export const INFRA_STOP_EXIT = 3

/** Where a run that the infrastructure ended is noted before it is redone, in the output folder. */
export const INFRA_FAILURES_FILE = 'infra-failures.jsonl'

/** How many times a run was ended by the infrastructure and started again, from the note file. */
const earlierAttempts = (outDir: string, runId: string): number => {
  const file = join(outDir, INFRA_FAILURES_FILE)
  if (!existsSync(file)) return 0
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => {
      try {
        return (JSON.parse(line) as { runId?: string }).runId === runId
      } catch {
        return false
      }
    }).length
}

/**
 * The id a run's model traffic goes under at the usage proxy. A run that is redone after an
 * infrastructure failure gets a new one (`<id>~a1`), so what the failed attempt used is not counted into
 * the run that replaces it; the report reads the latest attempt of a run.
 */
export const proxyRunId = (id: string, attempt: number): string => (attempt === 0 ? id : `${id}~a${attempt}`)

// ------------------------------------------------------------------ pure parts

export type AghArgs = {
  config: string
  out: string
  tasks?: string[]
  reps: number
  /** The arms to run, in this order: `--arms`, or `--settings` (on and off only); `on,off` when neither is given. */
  settings: Arm[]
  tasksDir: string
}

const ARMS: readonly Arm[] = ['on', 'off', 'oracle']

export const USAGE =
  'usage: run-agh.ts --config <run-config.json> --out <dir> [--tasks a,b] [--reps 3] [--arms off,on,oracle] [--tasks-dir <dir>]'

export function parseAghArgs(argv: string[]): AghArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      out: { type: 'string' },
      tasks: { type: 'string' },
      reps: { type: 'string', default: '3' },
      settings: { type: 'string' },
      arms: { type: 'string' },
      'tasks-dir': { type: 'string', default: defaultTasksDir },
    },
  })
  if (!values.config || !values.out) throw new Error(USAGE)
  const reps = Number(values.reps)
  if (!Number.isInteger(reps) || reps < 1) throw new Error('--reps must be a positive integer')
  if (values.settings !== undefined && values.arms !== undefined)
    throw new Error('--settings and --arms are the same option; give one of them')
  const settings = (values.arms ?? values.settings ?? 'on,off').split(',').map((s) => s.trim())
  for (const s of settings) {
    if (values.arms !== undefined ? !ARMS.includes(s as Arm) : s !== 'on' && s !== 'off')
      throw new Error(`unknown ${values.arms !== undefined ? 'arm' : 'setting'} "${s}"`)
  }
  return {
    config: values.config,
    out: values.out,
    ...(values.tasks ? { tasks: values.tasks.split(',').map((s) => s.trim()) } : {}),
    reps,
    settings: settings as Arm[],
    tasksDir: values['tasks-dir'] as string,
  }
}

/** The key from the variable the run config names; a clear error, without any value, when it is missing. */
export function requireKey(cfg: RunConfig, env: Record<string, string | undefined>): string {
  const key = env[cfg.keyEnv]
  if (key === undefined || key.trim() === '')
    throw new Error(
      `environment variable ${cfg.keyEnv} (run-config keyEnv) is not set in this shell; it must hold the model key`,
    )
  return key
}

/** The run config's route name must be a valid AGH route name. */
export function checkRoute(cfg: RunConfig): void {
  if (!ROUTE.test(cfg.provider))
    throw new Error(
      `run-config: "provider" (${cfg.provider}) must match ${ROUTE.source} to name an AGH route`,
    )
}

/** The model record AGH needs; context and output sizes are fixed defaults (the run config has none). */
function modelRecord(cfg: RunConfig, baseUrl: string): object {
  return {
    id: cfg.model,
    name: cfg.model,
    api: cfg.api,
    route: cfg.provider,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { ...cfg.prices },
    contextWindow: 200_000,
    maxTokens: 8_192,
    toolCallFormats: ['native'],
    thinkingReplay: 'native',
    contract_id: null,
  }
}

/**
 * The profile file of one run: one route, at the usage proxy's run path, whose key is the secret
 * `SECRET_REF` read from the environment. It names the secret; it never holds the key.
 */
export function aghProfile(cfg: RunConfig, id: string): object {
  const baseUrl = `http://127.0.0.1:${cfg.proxyPort}/run/${id}/`
  return {
    name: PROFILE,
    adapters: { secrets: { kind: 'env' } },
    provider: {
      package: '@agnes/ai',
      routes: [
        {
          route: cfg.provider,
          api: cfg.api,
          baseUrl,
          credentialRef: SECRET_REF,
          models: [modelRecord(cfg, baseUrl)],
        },
      ],
    },
  }
}

export const refinementSwitch = (setting: Arm): RefinementSwitch | undefined =>
  setting === 'on' ? { enabled: true, mode: 'auto' } : undefined

/** The arm is for tasks of two sessions that are not workflow tasks: a lesson to carry, and no skill to hand-write. */
export const oracleApplies = (task: EvalTask): boolean =>
  task.sessions.length === 2 && task.category !== 'workflow'

/**
 * The paragraph the oracle arm writes to the second session's memory: the task's own one-line note of
 * its rule. Never the checks or the solutions, which are what the work is measured against.
 */
export const oracleLesson = (task: EvalTask): string => task.trap.note.trim()

/** The nearest directory above `path` (or `path` itself) that holds `.git`, if any. */
export function gitAncestor(path: string): string | undefined {
  let current = resolve(path)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current || current === parse(current).root) return undefined
    current = parent
  }
}

// ------------------------------------------------------------------ one run

type SessionLog = {
  prompt: number
  reason?: string
  error?: string
  review?: ReviewAnswer & { state?: string }
}

/** The states a review ends in. */
export const TERMINAL_REVIEW_STATES: ReadonlySet<string> = new Set([
  'applied',
  'no-op',
  'rejected',
  'superseded',
  'cancelled',
  'unknown',
])
/** Refusals that mean the switch did not reach the host: the "on" run would silently be an "off" run. */
const NOT_ACTIVE = new Set(['refinement-off', 'unavailable'])

/** Same rule as the task self-check: the command exits 0 and its output contains the marker. */
const defaultCheck: CheckRun = async (check, cwd, home, timeoutMs) => {
  const { checkPasses, runCommand } = await import('../self-check.js')
  return checkPasses(await runCommand(check.command, cwd, home, timeoutMs), check.contains)
}

export async function runOne(
  task: EvalTask,
  setting: Arm,
  rep: number,
  cfg: RunConfig,
  outDir: string,
  opts: AghRunOptions,
): Promise<RunOutcome> {
  const id = runId(task.id, setting, rep)
  const runDir = resolve(outDir, id)
  const outcomeFile = join(runDir, 'outcome.json')
  if (existsSync(outcomeFile)) {
    const finished = JSON.parse(readFileSync(outcomeFile, 'utf8')) as RunOutcome
    if (!finished.infraFailed) return finished
    // The upstream ended that run, not the task: note it, then do the run again from the start.
    appendFileSync(
      join(outDir, INFRA_FAILURES_FILE),
      `${JSON.stringify({ runId: id, ts: new Date().toISOString(), ...finished.infraFailed })}\n`,
    )
  }
  const attempt = earlierAttempts(outDir, id)
  const proxyId = proxyRunId(id, attempt)
  if (setting === 'oracle' && !oracleApplies(task))
    throw new Error(`task ${task.id} has no oracle arm: it needs two sessions and is not a workflow task`)

  const fixtureDir = opts.fixtureDir ?? join(defaultTasksDir, task.id, 'fixture')
  const workBase = realpathSync(opts.workBase ?? tmpdir())
  const repo = gitAncestor(workBase)
  if (repo)
    throw new Error(
      `the temp directory ${workBase} is inside the git work tree ${repo}; point TMPDIR at a directory outside any repository`,
    )

  // A directory without an outcome is a partial run: start it over, with a new home.
  rmSync(runDir, { recursive: true, force: true })
  const sessionsOut = join(runDir, 'sessions')
  mkdirSync(sessionsOut, { recursive: true })
  const home = join(runDir, 'home')
  // One throwaway workspace per fixture; sessions that use the same fixture share it.
  const works = new Map<string, string>()
  const workOf = (sessionIndex: number): string => works.get(fixtureOf(task, sessionIndex)) as string
  try {
    for (const fixture of taskFixtures(task)) {
      const work = mkdtempSync(join(workBase, 'rsi-agh-'))
      works.set(fixture, work)
      cpSync(fixture === DEFAULT_FIXTURE ? fixtureDir : join(dirname(fixtureDir), fixture), work, {
        recursive: true,
      })
    }
    const workspaces = [...works.values()]
    const host = await opts.launch({
      home,
      profile: PROFILE,
      profileDocument: aghProfile(cfg, proxyId),
      refinement: refinementSwitch(setting),
      workspace: workOf(0),
      workspaces,
      memory: EVAL_MEMORY,
      model: { route: cfg.provider, model: cfg.model },
      env: { ...process.env, AGH_HOME: home },
    })
    const sessions: RunOutcome['sessions'] = []
    let saveRefused: string | undefined
    const keys: string[] = []
    try {
      // Before the first session is paid for: the oracle arm cannot run on a host that cannot seed memory.
      if (setting === 'oracle' && !host.seedMemory)
        throw new Error('this host cannot seed memory, which the oracle arm needs')
      for (let i = 0; i < task.sessions.length; i++) {
        const key = `rsi-eval-${id}-s${i + 1}`
        keys.push(key)
        // The oracle arm's one difference from off: the lesson is in the second session's memory before it starts.
        if (setting === 'oracle' && i === 1) await host.seedMemory?.(workOf(i), oracleLesson(task))
        const stdoutFile = join(runDir, `session${i + 1}.turns.jsonl`)
        const result = await runSession(
          host,
          key,
          workOf(i),
          task.sessions[i]?.prompts ?? [],
          setting,
          cfg,
          stdoutFile,
          // The first session ends with the user's own save: to the workspace for a workflow task, to
          // user memory for a cross-workspace task.
          i === 0 ? endSaveFor(task.category) : undefined,
        )
        const { saveRefused: refused, ...ended } = result
        if (refused !== undefined) saveRefused = refused
        sessions.push({ ...ended, stdoutFile, sessionFiles: [] })
        // A failed or timed-out session ends the run: later sessions would build on missing work.
        if (result.timedOut || result.exitCode !== 0) break
      }
    } finally {
      await host.close()
    }
    for (const [i, key] of keys.entries()) {
      const file = join(sessionsOut, `s${i + 1}.events.jsonl`)
      const rows = host.ledger(key)
      writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''))
      const session = sessions[i]
      if (session) session.sessionFiles = [file]
    }

    // Checks run after every session, in the workspace, only for sessions that ended cleanly; prompts of
    // a session that failed part-way are left without a result instead of being counted as passed.
    const runCheck = opts.runCheck ?? defaultCheck
    const checkHome = join(runDir, 'check-home')
    mkdirSync(checkHome, { recursive: true })
    const checks: RunOutcome['checks'] = []
    for (const [s, session] of sessions.entries()) {
      if (session.timedOut || session.exitCode !== 0) continue
      for (const [p, taskPrompt] of (task.sessions[s]?.prompts ?? []).entries()) {
        let passed = true
        for (const check of taskPrompt.checks) {
          if (!(await runCheck(check, workOf(s), checkHome, CHECK_TIMEOUT_MS))) passed = false
        }
        checks.push({ session: s, prompt: p, passed })
      }
    }
    // An upstream that refused or failed to answer ended the run, not the task. The host's own account of
    // the turn that ended is preferred; otherwise the proxy's last answers for the run.
    let infraFailed: InfraFailure | undefined
    for (const [i, key] of keys.entries()) infraFailed ??= infraFromLedger(host.ledger(key), i)
    const unclean = sessions.some((s) => s.timedOut || s.exitCode !== 0)
    if (!infraFailed && unclean && opts.statuses)
      infraFailed = infraFromStatuses(opts.statuses(proxyId), sessions.length - 1)
    const outcome: RunOutcome = {
      runId: id,
      system: 'agh',
      sessions,
      checks,
      ...(saveRefused === undefined ? {} : { saveRefused }),
      ...(infraFailed ? { infraFailed } : {}),
    }
    writeFileSync(outcomeFile, `${JSON.stringify(outcome, null, 2)}\n`)
    return outcome
  } finally {
    for (const [fixture, work] of works) {
      cpSync(work, join(runDir, workspaceName(fixture)), { recursive: true })
      rmSync(work, { recursive: true, force: true })
    }
  }
}

/** Where the first session of a task of this category ends with the user's own save, if it does. */
function endSaveFor(category: EvalTask['category']): 'workspace' | 'user' | undefined {
  if (category === 'workflow') return 'workspace'
  if (category === 'cross-workspace') return 'user'
  return undefined
}

async function runSession(
  host: AghHost,
  key: string,
  workspace: string,
  prompts: EvalTask['sessions'][number]['prompts'],
  setting: Arm,
  cfg: RunConfig,
  logFile: string,
  endSave?: 'workspace' | 'user',
): Promise<{ exitCode: number | null; timedOut: boolean; saveRefused?: string }> {
  const deadline = Date.now() + cfg.sessionTimeoutMs
  const log = (entry: SessionLog) => writeFileSync(logFile, `${JSON.stringify(entry)}\n`, { flag: 'a' })
  writeFileSync(logFile, '')
  const session = await host.openSession(key, workspace)
  let exitCode: number | null = 0
  let timedOut = false
  let saveRefused: string | undefined
  try {
    for (const [index, prompt] of prompts.entries()) {
      const left = deadline - Date.now()
      if (left <= 0) {
        timedOut = true
        break
      }
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), left)
      let reason: string | undefined
      try {
        reason = await session.prompt(prompt.text, abort.signal)
      } catch (error) {
        log({ prompt: index, error: error instanceof Error ? error.message : String(error) })
      } finally {
        clearTimeout(timer)
      }
      if (abort.signal.aborted) {
        timedOut = true
        log({ prompt: index, reason: 'timeout' })
        break
      }
      if (reason !== 'completed') {
        if (reason !== undefined) log({ prompt: index, reason })
        exitCode = 1
        break
      }
      if (setting !== 'on') {
        log({ prompt: index, reason })
        continue
      }
      const saveTo = index === prompts.length - 1 ? endSave : undefined
      const review = await session.review(saveTo)
      if ('refused' in review && NOT_ACTIVE.has(review.refused))
        throw new Error(
          `refinement is not active in the run host (${review.refused}); the "on" run would measure nothing`,
        )
      if (saveTo && 'refused' in review) saveRefused = review.refused
      const state =
        'runId' in review
          ? await session.settled(review.runId, Math.min(REFINE_WAIT_MS, Math.max(0, deadline - Date.now())))
          : undefined
      log({ prompt: index, reason, review: { ...review, ...(state ? { state } : {}) } })
    }
  } finally {
    await session.close()
  }
  return {
    exitCode: timedOut ? null : exitCode,
    timedOut,
    ...(saveRefused === undefined ? {} : { saveRefused }),
  }
}

// ------------------------------------------------------------------ CLI

async function main(argv: string[]): Promise<void> {
  const args = parseAghArgs(argv)
  const cfg = readConfig(args.config)
  checkRoute(cfg)
  const key = requireKey(cfg, process.env)

  const [{ loadSuite }, { startUsageProxy }, { launchHost }] = await Promise.all([
    import('../suite.js'),
    import('../usage-proxy.js'),
    import('./launch.js'),
  ])
  const tasksDir = resolve(args.tasksDir)
  let tasks = loadSuite(tasksDir)
  if (args.tasks) {
    const wanted = args.tasks
    const missing = wanted.filter((id) => !tasks.some((t) => t.id === id))
    if (missing.length > 0) throw new Error(`unknown task ids: ${missing.join(', ')}`)
    tasks = tasks.filter((t) => wanted.includes(t.id))
  }

  const out = resolve(args.out)
  mkdirSync(out, { recursive: true })
  const proxy = await startUsageProxy({
    upstream: cfg.upstream,
    port: cfg.proxyPort,
    logFile: join(out, 'usage.jsonl'),
    redact: [key],
  })
  // The host resolves the route's secret from this process's environment; it is never written down.
  process.env[SECRET_ENV] = key
  const streak = createInfraStreak()
  try {
    for (let rep = 1; rep <= args.reps && !streak.stopped; rep++) {
      for (const task of tasks) {
        for (const setting of args.settings) {
          if (streak.stopped) break
          if (setting === 'oracle' && !oracleApplies(task)) {
            if (rep === 1) console.error(`skipped ${task.id}: no oracle arm for this task`)
            continue
          }
          const id = runId(task.id, setting, rep)
          const fresh = finishedOutcome(out, id) === undefined
          const outcome = await runOne(task, setting, rep, cfg, out, {
            launch: launchHost,
            fixtureDir: join(tasksDir, task.id, 'fixture'),
            statuses: (proxyId) => proxy.statuses(proxyId),
          })
          const exits = outcome.sessions.map((s) => (s.timedOut ? 'timeout' : String(s.exitCode))).join(',')
          const passed = outcome.checks.filter((c) => c.passed).length
          const infra = outcome.infraFailed
            ? ` INFRA-FAILED (${outcome.infraFailed.reason}; not a task failure, left out of the results, redone on the next start)`
            : ''
          console.error(
            `${fresh ? 'ran' : 'skipped'} ${id} exit=[${exits}] checks=${passed}/${outcome.checks.length}${infra} (${relative(process.cwd(), join(out, id))})`,
          )
          if (fresh && streak.record(outcome.infraFailed !== undefined)) {
            console.error(
              `STOPPED: ${INFRA_STOP_AFTER} runs in a row were ended by the upstream (${outcome.infraFailed?.reason}), not by their tasks. ` +
                'Check the key, the account balance and the model name (the preflight does this), then start the same command again: finished runs are kept, the infra-failed ones are redone.',
            )
            process.exitCode = INFRA_STOP_EXIT
          }
        }
      }
    }
  } finally {
    delete process.env[SECRET_ENV]
    await proxy.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
