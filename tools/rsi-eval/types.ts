// Shared types for the offline RSI evaluation tools. Pure types: no runtime code.

export type Category =
  | 'directory'
  | 'command-args'
  | 'convention'
  | 'cross-session'
  | 'cross-workspace'
  | 'workflow'

export type Setting = 'on' | 'off'

/**
 * What a run is measured as: `on` and `off` are the refinement switch. `oracle` is `off` plus one
 * paragraph taken from the task's `trap.note`, written to the second session's workspace memory before
 * that session starts. Only the AGH runner has it.
 */
export type Arm = Setting | 'oracle'

export type EvalPrompt = {
  text: string
  /** Run after all sessions end, inside the task workspace. */
  checks: { command: string; contains: string }[]
  /** Commands that complete this prompt's work; used only by the self-check. */
  solution: string[]
}

export type EvalTask = {
  id: string
  category: Category
  description: string
  trap: { signatures: string[]; reproduce: string; note: string }
  /**
   * `fixture` names the directory, next to task.json, that the session's workspace is copied from;
   * absent means `fixture`. Sessions naming the same fixture share one workspace. Only
   * cross-workspace tasks name another one, for their second session.
   */
  sessions: { prompts: EvalPrompt[]; fixture?: string }[]
}

export type RunConfig = {
  provider: string
  api: string
  upstream: string
  model: string
  /** Name of the environment variable that holds the key; never the key itself. */
  keyEnv: string
  prices: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** True when the prices are a stand-in, not the provider's list; the report says so. */
  pricesAssumed?: boolean
  proxyPort: number
  sessionTimeoutMs: number
}

/**
 * A run that the infrastructure ended, not the task: the upstream refused or failed to answer (quota,
 * credentials, rate limit, a server error) so the model never got to do the work. Such a run says nothing
 * about the system under test; it is left out of every metric and redone on the next start.
 */
export type InfraFailure = {
  /** Which session's turn the upstream ended (zero-based). */
  session: number
  /** What the host reported: the error code and, when it has one, the HTTP status. */
  reason: string
  status?: number
}

export type RunOutcome = {
  runId: string
  /** Which runner wrote it, so its session files are read the right way; absent means Prime. */
  system?: RunRecord['system']
  sessions: { exitCode: number | null; timedOut: boolean; stdoutFile: string; sessionFiles: string[] }[]
  checks: { session: number; prompt: number; passed: boolean }[]
  /**
   * Set by a runner that could not send the save its counterpart sends at the end of session 1. The AGH
   * runner now sends one (`/refine --user`), so only results recorded before that carry it.
   */
  alignment?: Alignment
  /** Workflow tasks: why the host refused the workspace save sent at the end of session 1. */
  saveRefused?: string
  /** Set when the upstream, not the task, ended the run; see `InfraFailure`. */
  infraFailed?: InfraFailure
}

/**
 * `auto-only`: the run had no user-initiated user-level save at the end of the first session of a
 * cross-workspace task (Prime sends `/refine --global` there), so anything carried to the second
 * workspace came from automatic promotion alone. Kept to read results recorded before the AGH runner
 * sent `/refine --user` there.
 */
export type Alignment = 'auto-only'

export type UsageRow = {
  ts: string
  runId: string
  status: number
  model: string | null
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  usage: 'reported' | 'unknown'
}

export type PromptWindow = {
  session: number
  prompt: number
  ran: boolean
  /** A command run in this window failed with the task's trap signature; reading a file that holds it does not count. */
  trapHit: boolean
  checksPassed: boolean | null
}

/**
 * Workflow tasks only: what session 1 left behind and what session 2, a new session in the same workspace, did with it. A run whose first
 * session never completed a `workflow` run has nothing to reuse and is left out of the rate.
 */
export type WorkflowReuse = {
  /** The first session completed at least one `workflow` run. */
  firstCompleted: boolean
  /** The workspace holds a skill that carries a workflow definition. */
  saved: boolean
  /** The host refused the workspace save at the end of the first session, for this reason. */
  saveRefused?: string
  /** `workflow` calls that started a run in the second session. */
  calls: number
  /** Of those, calls whose definition equals a saved one. */
  matching: number
}

/**
 * What one session cost, summed from the rows of its ledger (every lane). `lowerBound`: the session had
 * child sessions whose cost is not in this ledger, or a row without a price, so the figures are at least
 * this much.
 */
export type SessionCost = {
  requests: number
  tokens: number
  cost: number
  lowerBound: boolean
  /** The part of the totals that is the refinement lane's: the review calls. The rest is the session's own work. */
  refinement: { requests: number; tokens: number; cost: number }
}

export type RunRecord = {
  system: 'prime' | 'agh'
  taskId: string
  category: Category
  setting: Arm
  rep: number
  exit: 'ok' | 'error' | 'timeout'
  windows: PromptWindow[]
  refine: { auto: number; user: number; self: number; appliedEdits: number }
  harnessLookups: number
  compactions: number
  usage: { requests: number; unknown: number; tokens: number; costUsd: number }
  alignment?: Alignment
  workflowReuse?: WorkflowReuse
  /** AGH runs: the cost of each session of the task, in order. */
  sessionCosts?: SessionCost[]
  /** AGH runs: the time of the first row of the first session's ledger; tells two runs apart that share an id. */
  startedAt?: string
  /** The upstream ended the run; such records are left out of every metric. */
  infraFailed?: InfraFailure
}
