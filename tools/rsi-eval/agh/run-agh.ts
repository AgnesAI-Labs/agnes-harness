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
// speaks (for example anthropic-messages or openai-completions). The model is declared with the run
// config's `contextWindow` and `maxOutputTokens`, 200,000 and 8,192 when it names none; the host
// compacts by that window (numbers in the README). Keep --out outside any git repository. The task
// commands and checks need bash, python3 and make on PATH.
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
// With `--on-protocol triggers` the on arm sends no manual reviews (nor the end-of-session saves) and
// leaves refinement to its own triggers; a dry read of the session's experience entries, at no model cost,
// then checks once per session that refinement is live, which the reviews otherwise show.
// Off: no switch file at all, which is the default.
// Oracle (opt-in with `--arms off,on,oracle`; `--settings` is the same option, older name, on and off only):
// refinement off as in "off", and before the SECOND session starts, one paragraph taken from the task's
// `trap.note` is written to that session's workspace memory, through the same edit the memory page makes.
// The first session is the same as the off run's. It is the most a saved lesson could give the sessions
// after the first, so it is the ceiling the "on" run is measured against (see capture.ts). Only for tasks of
// two or more sessions (a long task may have several in one workspace, each a new conversation) or with an
// `oracle.afterPrompt`, and not for workflow tasks; the other tasks are skipped for this arm.
//
// Frozen (`--arms frozen --frozen-from <folder of on runs>`): refinement off, and before the first session
// the workspace (and user memory) holds exactly what the on run of the same task and repetition saved:
// its saved memory paragraphs, as text, and its installed workspace skills (see frozen.ts).
//
// Milestones: a prompt marked `milestone` has its checks run right after it, and the run stops at the first
// that fails. Each prompt's end time is recorded, so the report can read from the ledger what had been
// spent by then. A run stops cleanly at its request cap (`maxRequests` of the task, else --max-requests):
// the usage proxy refuses what is past it and the runner aborts the turn; the run is recorded `capped`.
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
import { blockedRun, MAX_BLOCKED_REDOS } from '../blocked.js'
import { createInfraStreak, INFRA_STOP_AFTER, infraFromLedger, infraFromStatuses } from '../infra.js'
import { readConfig, runId } from '../prime/run-prime.js'
import { DEFAULT_FIXTURE, fixtureOf, taskFixtures, workspaceName } from '../suite.js'
import type {
  Arm,
  Capped,
  EvalTask,
  FrozenSeed,
  InfraFailure,
  OnProtocol,
  RunConfig,
  RunOutcome,
} from '../types.js'
import {
  copyFrozenSkills,
  type FrozenMemoryModule,
  type FrozenSource,
  frozenSeed,
  loadFrozenMemoryModule,
  readFrozenSource,
} from './frozen.js'

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
  /**
   * Whether refinement is live in this session, without a model call (a read of its experience entries):
   * refused, with the reason, exactly when a review would be. For `on` runs that send no manual reviews.
   */
  liveness?(): Promise<{ live: true } | { refused: string }>
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
  /** Adds a paragraph to the user memory, as a person writes it. Needed for the frozen arm only. */
  seedUserMemory?(text: string): Promise<void>
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
  /** Enforces a run's request cap (the usage proxy does); without it no cap is enforced. */
  cap?: {
    limit(proxyRunId: string, max: number, reached: () => void): void
    unlimit(proxyRunId: string): void
  }
  /** The cap for a task that names none. */
  maxRequests?: number
  /** Frozen runs: the output folder that holds the `on` runs whose saved lessons are seeded. */
  frozenFrom?: string
  /** The memory provider's layout and parser, for reading a frozen run's source; loaded when absent. */
  frozenMemory?: FrozenMemoryModule
  /** How `on` runs are driven; `reviews` when absent. */
  onProtocol?: OnProtocol
}

/** The most model requests a run may make when its task names no cap (`EvalTask.maxRequests`). */
export const DEFAULT_MAX_REQUESTS = 400

/**
 * The outcome of a run that is finished for good. One the infrastructure ended is not, it is redone; nor is
 * one the host's verifier blocked while it has a redo left (`MAX_BLOCKED_REDOS`).
 */
export const finishedOutcome = (outDir: string, id: string): RunOutcome | undefined => {
  const file = join(outDir, id, 'outcome.json')
  if (!existsSync(file)) return undefined
  const outcome = JSON.parse(readFileSync(file, 'utf8')) as RunOutcome
  if (outcome.infraFailed) return undefined
  if (outcome.blocked && notedAttempts(outDir, BLOCKED_FILE, id) < MAX_BLOCKED_REDOS) return undefined
  return outcome
}

/** Where a run the host's verifier blocked is noted before it is redone, in the output folder. */
export const BLOCKED_FILE = 'blocked-runs.jsonl'

/** The exit code of a shard that stopped because the infrastructure kept ending its runs. */
export const INFRA_STOP_EXIT = 3

/** Where a run that the infrastructure ended is noted before it is redone, in the output folder. */
export const INFRA_FAILURES_FILE = 'infra-failures.jsonl'

/** How many times a run was ended by the infrastructure and started again, from the note file. */
const earlierAttempts = (outDir: string, runId: string): number =>
  notedAttempts(outDir, INFRA_FAILURES_FILE, runId) + notedAttempts(outDir, BLOCKED_FILE, runId)

/** How many notes of one kind (infrastructure, blocked) a run has in the output folder. */
const notedAttempts = (outDir: string, name: string, runId: string): number => {
  const file = join(outDir, name)
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
  /** The folder of the `on` runs the frozen arm takes its lessons from. */
  frozenFrom?: string
  onProtocol: OnProtocol
  maxRequests: number
}

const ARMS: readonly Arm[] = ['on', 'off', 'oracle', 'frozen']

/**
 * The arms in the order they run for each task and repetition: as given, except that `frozen` comes after
 * `on`, so a frozen run whose on run this invocation makes (`--frozen-from` the same folder as `--out`)
 * finds it finished.
 */
export const orderArms = (arms: Arm[]): Arm[] =>
  arms.includes('frozen') && arms.includes('on') && arms.indexOf('frozen') < arms.indexOf('on')
    ? [...arms.filter((arm) => arm !== 'frozen'), 'frozen']
    : arms
const PROTOCOLS: readonly OnProtocol[] = ['reviews', 'triggers']

export const USAGE =
  'usage: run-agh.ts --config <run-config.json> --out <dir> [--tasks a,b] [--reps 3] [--arms off,on,oracle,frozen] [--frozen-from <dir of on runs>] [--on-protocol reviews|triggers] [--max-requests 400] [--tasks-dir <dir>]'

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
      'frozen-from': { type: 'string' },
      'on-protocol': { type: 'string', default: 'reviews' },
      'max-requests': { type: 'string', default: String(DEFAULT_MAX_REQUESTS) },
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
  const onProtocol = values['on-protocol'] as string
  if (!PROTOCOLS.includes(onProtocol as OnProtocol))
    throw new Error(`--on-protocol must be one of ${PROTOCOLS.join(', ')}, got "${onProtocol}"`)
  const maxRequests = Number(values['max-requests'])
  if (!Number.isInteger(maxRequests) || maxRequests < 1)
    throw new Error('--max-requests must be a positive integer')
  if (settings.includes('frozen') && !values['frozen-from'])
    throw new Error('the frozen arm needs --frozen-from <the output folder of the on runs it copies>')
  if (!settings.includes('frozen') && values['frozen-from'])
    throw new Error('--frozen-from is only for the frozen arm')
  return {
    config: values.config,
    out: values.out,
    ...(values.tasks ? { tasks: values.tasks.split(',').map((s) => s.trim()) } : {}),
    reps,
    settings: orderArms(settings as Arm[]),
    tasksDir: values['tasks-dir'] as string,
    ...(values['frozen-from'] ? { frozenFrom: values['frozen-from'] } : {}),
    onProtocol: onProtocol as OnProtocol,
    maxRequests,
  }
}

/**
 * Whether the frozen arm copies on runs that this same invocation makes: `--frozen-from` is the `--out`
 * folder and the on arm is among the arms. Then `--reps 5 --arms on,off,oracle,frozen --frozen-from <out>`
 * runs in one go: each frozen rN runs right after the on rN of its task (`orderArms`), and its source is
 * checked then instead of before the first run.
 */
export const frozenSourcesMadeHere = (args: Pick<AghArgs, 'out' | 'frozenFrom' | 'settings'>): boolean =>
  args.frozenFrom !== undefined &&
  resolve(args.frozenFrom) === resolve(args.out) &&
  args.settings.includes('on')

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

/** The context window and output size a model is declared with when the run config names none. */
export const DEFAULT_CONTEXT_WINDOW = 200_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192

/**
 * The model record AGH needs. The context window and the output size come from the run config
 * (`contextWindow`, `maxOutputTokens`), with the old fixed values as defaults. The host compacts by the
 * declared window (see the README for the numbers), so a smaller window makes it compact sooner.
 */
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
    contextWindow: cfg.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: cfg.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
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

/**
 * The arm is for tasks that are not workflow tasks (no skill to hand-write) and have a point to write the
 * lesson at: before the second session of a task of two or more, or after a named prompt of the first
 * (`EvalTask.oracle`).
 */
export const oracleApplies = (task: EvalTask): boolean =>
  task.category !== 'workflow' && (task.sessions.length >= 2 || task.oracle !== undefined)

/** Where the oracle writes the lesson: after a prompt of the first session, or before the second session. */
export const oracleSeedPoint = (task: EvalTask): { afterPrompt: number } | { beforeSession: 1 } =>
  task.oracle ? { afterPrompt: task.oracle.afterPrompt } : { beforeSession: 1 }

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
  milestone?: 'failed'
  seeded?: 'oracle'
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
    if (finished.infraFailed) {
      // The upstream ended that run, not the task: note it, then do the run again from the start.
      appendFileSync(
        join(outDir, INFRA_FAILURES_FILE),
        `${JSON.stringify({ runId: id, ts: new Date().toISOString(), ...finished.infraFailed })}\n`,
      )
    } else if (finished.blocked && notedAttempts(outDir, BLOCKED_FILE, id) < MAX_BLOCKED_REDOS) {
      // The host's verifier stopped a turn, not the task: note it and do the run once more. A run blocked
      // again is left as blocked.
      appendFileSync(
        join(outDir, BLOCKED_FILE),
        `${JSON.stringify({ runId: id, ts: new Date().toISOString(), ...finished.blocked })}\n`,
      )
    } else return finished
  }
  const attempt = earlierAttempts(outDir, id)
  const proxyId = proxyRunId(id, attempt)
  if (setting === 'oracle' && !oracleApplies(task))
    throw new Error(
      `task ${task.id} has no oracle arm: it needs two sessions or an oracle.afterPrompt, and is not a workflow task`,
    )
  // The frozen arm's source is read before anything is paid for: a missing or wrong source stops here.
  let frozen: FrozenSource | undefined
  if (setting === 'frozen') {
    if (!opts.frozenFrom)
      throw new Error('the frozen arm needs the folder of the on runs it copies (frozenFrom)')
    frozen = readFrozenSource(
      opts.frozenFrom,
      task,
      rep,
      opts.frozenMemory ?? (await loadFrozenMemoryModule()),
    )
  }

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
  const maxRequests = task.maxRequests ?? opts.maxRequests ?? DEFAULT_MAX_REQUESTS
  try {
    for (const fixture of taskFixtures(task)) {
      const work = mkdtempSync(join(workBase, 'rsi-agh-'))
      works.set(fixture, work)
      cpSync(fixture === DEFAULT_FIXTURE ? fixtureDir : join(dirname(fixtureDir), fixture), work, {
        recursive: true,
      })
    }
    // The saved skills are in the workspace before the host starts, as they were where the on run left them.
    const seed: FrozenSeed | undefined = frozen
      ? frozenSeed(
          frozen,
          copyFrozenSkills(frozen, (fixture) => works.get(fixture) as string),
        )
      : undefined
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
    const prompts: NonNullable<RunOutcome['prompts']> = []
    const milestoneChecks: RunOutcome['checks'] = []
    let saveRefused: string | undefined
    let stopped: RunOutcome['stopped']
    const keys: string[] = []
    // The request cap: the proxy refuses what is past it and tells the runner, which stops the turn.
    const stop = new AbortController()
    let capped: Capped | undefined
    const at = { session: 0, prompt: 0 }
    opts.cap?.limit(proxyId, maxRequests, () => {
      capped ??= { maxRequests, session: at.session, prompt: at.prompt }
      stop.abort()
    })
    const runCheck = opts.runCheck ?? defaultCheck
    const checkHome = join(runDir, 'check-home')
    mkdirSync(checkHome, { recursive: true })
    const protocol: OnProtocol = opts.onProtocol ?? 'reviews'
    try {
      // Before the first session is paid for: the oracle and frozen arms cannot run on a host that cannot seed memory.
      if ((setting === 'oracle' || setting === 'frozen') && !host.seedMemory)
        throw new Error(`this host cannot seed memory, which the ${setting} arm needs`)
      if (frozen) {
        for (const [fixture, { paragraphs }] of frozen.workspaces)
          if (paragraphs.length > 0)
            await host.seedMemory?.(works.get(fixture) as string, paragraphs.join('\n\n'))
        if (frozen.userSections.length > 0) {
          if (!host.seedUserMemory)
            throw new Error('this host cannot seed user memory, which this frozen run needs')
          await host.seedUserMemory(frozen.userSections.join('\n\n'))
        }
      }
      const seedPoint = oracleSeedPoint(task)
      const endSave = endSaveFor(task.category)
      for (let i = 0; i < task.sessions.length; i++) {
        const key = `rsi-eval-${id}-s${i + 1}`
        keys.push(key)
        at.session = i
        // The oracle arm's one difference from off: the lesson in memory before the second session, or
        // after a named prompt of the first.
        if (setting === 'oracle' && 'beforeSession' in seedPoint && i === seedPoint.beforeSession)
          await host.seedMemory?.(workOf(i), oracleLesson(task))
        const stdoutFile = join(runDir, `session${i + 1}.turns.jsonl`)
        const taskPrompts = task.sessions[i]?.prompts ?? []
        const result = await runSession(host, {
          key,
          workspace: workOf(i),
          prompts: taskPrompts,
          setting,
          cfg,
          logFile: stdoutFile,
          // The first session ends with the user's own save: to the workspace for a workflow task, to
          // user memory for a cross-workspace task.
          ...(i === 0 && endSave ? { endSave } : {}),
          protocol,
          stop: stop.signal,
          started: (prompt) => {
            at.prompt = prompt
          },
          ended: (prompt, reason) => {
            prompts.push({ session: i, prompt, endedAt: new Date().toISOString(), reason })
          },
          // A milestone is checked right after its prompt, in the workspace as the run has left it so far.
          milestone: async (prompt) => {
            const taskPrompt = taskPrompts[prompt]
            if (taskPrompt?.milestone === undefined) return true
            let passed = true
            for (const check of taskPrompt.checks)
              if (!(await runCheck(check, workOf(i), checkHome, CHECK_TIMEOUT_MS))) passed = false
            milestoneChecks.push({ session: i, prompt, passed })
            return passed
          },
          ...(setting === 'oracle' && i === 0 && 'afterPrompt' in seedPoint
            ? { seedAfter: { prompt: seedPoint.afterPrompt, text: oracleLesson(task) } }
            : {}),
        })
        const { saveRefused: refused, failedMilestone, capped: wasCapped, ...ended } = result
        if (refused !== undefined) saveRefused = refused
        sessions.push({ ...ended, ...(wasCapped ? { capped: true } : {}), stdoutFile, sessionFiles: [] })
        if (failedMilestone !== undefined)
          stopped = { reason: 'milestone-failed', session: i, prompt: failedMilestone }
        // A failed, capped or timed-out session ends the run: later sessions would build on missing work.
        if (result.timedOut || result.exitCode !== 0) break
      }
    } finally {
      opts.cap?.unlimit(proxyId)
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
    // a session that failed part-way are left without a result instead of being counted as passed. A
    // milestone was checked right after its prompt instead, and keeps that result.
    const checks: RunOutcome['checks'] = [...milestoneChecks]
    for (const [s, session] of sessions.entries()) {
      if (session.timedOut || session.exitCode !== 0) continue
      for (const [p, taskPrompt] of (task.sessions[s]?.prompts ?? []).entries()) {
        if (taskPrompt.milestone !== undefined) continue
        let passed = true
        for (const check of taskPrompt.checks) {
          if (!(await runCheck(check, workOf(s), checkHome, CHECK_TIMEOUT_MS))) passed = false
        }
        checks.push({ session: s, prompt: p, passed })
      }
    }
    checks.sort((x, y) => x.session - y.session || x.prompt - y.prompt)
    // An upstream that refused or failed to answer ended the run, not the task. The host's own account of
    // the turn that ended is preferred; otherwise the proxy's last answers for the run. A capped run was
    // stopped by the runner itself.
    let infraFailed: InfraFailure | undefined
    if (!capped) {
      for (const [i, key] of keys.entries()) infraFailed ??= infraFromLedger(host.ledger(key), i)
      const unclean = sessions.some((s) => s.timedOut || s.exitCode !== 0)
      if (!infraFailed && unclean && opts.statuses)
        infraFailed = infraFromStatuses(opts.statuses(proxyId), sessions.length - 1)
    }
    // A turn the host's verifier ended blocked: the harness stopped it, not the task (unless the upstream or
    // the cap did first).
    const blocked =
      infraFailed || capped
        ? undefined
        : blockedRun(prompts, (session) => host.ledger(keys[session] as string))
    const outcome: RunOutcome = {
      runId: id,
      system: 'agh',
      sessions,
      checks,
      ...(saveRefused === undefined ? {} : { saveRefused }),
      ...(infraFailed ? { infraFailed } : {}),
      ...(blocked ? { blocked } : {}),
      ...(capped ? { capped } : {}),
      ...(stopped ? { stopped } : {}),
      prompts,
      workspaces: Object.fromEntries(works),
      ...(setting === 'on' ? { onProtocol: protocol } : {}),
      ...(seed ? { frozenFrom: seed } : {}),
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

type SessionPlan = {
  key: string
  workspace: string
  prompts: EvalTask['sessions'][number]['prompts']
  setting: Arm
  cfg: RunConfig
  logFile: string
  endSave?: 'workspace' | 'user'
  protocol: OnProtocol
  /** Aborted when the run reached its request cap: the turn is stopped and the session ends. */
  stop: AbortSignal
  started(prompt: number): void
  ended(prompt: number, reason: string): void
  /** Runs a prompt's milestone checks, if it is one; false stops the run. */
  milestone(prompt: number): Promise<boolean>
  /** The oracle's lesson, written after this prompt. */
  seedAfter?: { prompt: number; text: string }
}

type SessionEnd = {
  exitCode: number | null
  timedOut: boolean
  saveRefused?: string
  capped?: boolean
  failedMilestone?: number
}

async function runSession(host: AghHost, plan: SessionPlan): Promise<SessionEnd> {
  const { prompts, setting, cfg, endSave } = plan
  const deadline = Date.now() + cfg.sessionTimeoutMs
  const log = (entry: SessionLog) => writeFileSync(plan.logFile, `${JSON.stringify(entry)}\n`, { flag: 'a' })
  writeFileSync(plan.logFile, '')
  const session = await host.openSession(plan.key, plan.workspace)
  let exitCode: number | null = 0
  let timedOut = false
  let capped = false
  let failedMilestone: number | undefined
  let saveRefused: string | undefined
  const reviews = setting === 'on' && plan.protocol === 'reviews'
  try {
    // Without manual reviews nothing else would show a dead refinement: check it once, at no model cost.
    if (setting === 'on' && plan.protocol === 'triggers') {
      if (!session.liveness) throw new Error('this host cannot check that refinement is live')
      const live = await session.liveness()
      if ('refused' in live && NOT_ACTIVE.has(live.refused))
        throw new Error(
          `refinement is not active in the run host (${live.refused}); the "on" run would measure nothing`,
        )
    }
    for (const [index, prompt] of prompts.entries()) {
      if (plan.stop.aborted) {
        capped = true
        break
      }
      const left = deadline - Date.now()
      if (left <= 0) {
        timedOut = true
        break
      }
      plan.started(index)
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), left)
      const signal = AbortSignal.any([abort.signal, plan.stop])
      let reason: string | undefined
      try {
        reason = await session.prompt(prompt.text, signal)
      } catch (error) {
        log({ prompt: index, error: error instanceof Error ? error.message : String(error) })
      } finally {
        clearTimeout(timer)
      }
      plan.ended(index, plan.stop.aborted ? 'capped' : abort.signal.aborted ? 'timeout' : (reason ?? 'error'))
      if (plan.stop.aborted) {
        capped = true
        log({ prompt: index, reason: 'capped' })
        break
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
      if (!(await plan.milestone(index))) {
        log({ prompt: index, reason, milestone: 'failed' })
        failedMilestone = index
        exitCode = 1
        break
      }
      if (!reviews) {
        log({ prompt: index, reason })
      } else {
        const saveTo = index === prompts.length - 1 ? endSave : undefined
        const review = await session.review(saveTo)
        if ('refused' in review && NOT_ACTIVE.has(review.refused))
          throw new Error(
            `refinement is not active in the run host (${review.refused}); the "on" run would measure nothing`,
          )
        if (saveTo && 'refused' in review) saveRefused = review.refused
        const state =
          'runId' in review
            ? await session.settled(
                review.runId,
                Math.min(REFINE_WAIT_MS, Math.max(0, deadline - Date.now())),
              )
            : undefined
        log({ prompt: index, reason, review: { ...review, ...(state ? { state } : {}) } })
      }
      // The lesson is in memory from the next prompt on: the provider reads it again at each turn.
      if (plan.seedAfter?.prompt === index) {
        await host.seedMemory?.(plan.workspace, plan.seedAfter.text)
        log({ prompt: index, seeded: 'oracle' })
      }
    }
  } finally {
    await session.close()
  }
  return {
    exitCode: timedOut ? null : capped ? 1 : exitCode,
    timedOut,
    ...(capped ? { capped: true } : {}),
    ...(failedMilestone === undefined ? {} : { failedMilestone }),
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

  // The frozen arm's sources are checked before anything is paid for, except the on runs this invocation
  // makes itself (the same folder, the on arm among the arms): those are checked when their frozen run comes.
  const out = resolve(args.out)
  const frozenFrom = args.frozenFrom ? resolve(args.frozenFrom) : undefined
  const sourcesMadeHere = frozenSourcesMadeHere(args)
  if (frozenFrom && !sourcesMadeHere) {
    const memory = await loadFrozenMemoryModule()
    const problems: string[] = []
    for (let rep = 1; rep <= args.reps; rep++)
      for (const task of tasks) {
        try {
          readFrozenSource(frozenFrom, task, rep, memory)
        } catch (error) {
          problems.push(error instanceof Error ? error.message : String(error))
        }
      }
    if (problems.length > 0) throw new Error(`the frozen arm cannot start:\n${problems.join('\n')}`)
  }

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
          if (setting === 'frozen' && sourcesMadeHere && fresh) {
            // Its on run ran just before it in this loop (`orderArms`); one that cannot be a source leaves
            // this frozen run out, the others go on.
            try {
              readFrozenSource(out, task, rep, await loadFrozenMemoryModule())
            } catch (error) {
              console.error(`skipped ${id}: ${error instanceof Error ? error.message : String(error)}`)
              continue
            }
          }
          const outcome = await runOne(task, setting, rep, cfg, out, {
            launch: launchHost,
            fixtureDir: join(tasksDir, task.id, 'fixture'),
            statuses: (proxyId) => proxy.statuses(proxyId),
            cap: proxy,
            maxRequests: args.maxRequests,
            onProtocol: args.onProtocol,
            ...(frozenFrom ? { frozenFrom } : {}),
          })
          const exits = outcome.sessions.map((s) => (s.timedOut ? 'timeout' : String(s.exitCode))).join(',')
          const passed = outcome.checks.filter((c) => c.passed).length
          const infra = outcome.infraFailed
            ? ` INFRA-FAILED (${outcome.infraFailed.reason}; not a task failure, left out of the results, redone on the next start)`
            : outcome.blocked
              ? ` BLOCKED by the host's verifier (${outcome.blocked.reasons.join(', ')}; not a task failure, left out of the results, redone once on the next start)`
              : outcome.capped
                ? ` CAPPED (${outcome.capped.maxRequests} requests, session ${outcome.capped.session + 1} prompt ${outcome.capped.prompt + 1}; listed apart in the report)`
                : outcome.stopped
                  ? ` STOPPED at a failed milestone (session ${outcome.stopped.session + 1} prompt ${outcome.stopped.prompt + 1})`
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
