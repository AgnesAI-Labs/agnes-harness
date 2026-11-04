// Shared types for the offline RSI evaluation tools. Pure types: no runtime code.

export type Category =
  | 'directory'
  | 'command-args'
  | 'convention'
  | 'cross-session'
  | 'cross-workspace'
  | 'workflow'
  /** A task of many stages (one prompt each), measured milestone by milestone. A category of its own, written a few tasks at a time. */
  | 'long'

export type Setting = 'on' | 'off'

/**
 * What a run is measured as: `on` and `off` are the refinement switch. `oracle` is `off` plus one
 * paragraph taken from the task's `trap.note`, written to workspace memory before the second session
 * starts, or after a named prompt of the first (`EvalTask.oracle`). `frozen` is `off` with, from the
 * start, exactly what a named `on` run of the same task and repetition saved: its saved memory
 * paragraphs and its installed workspace skills. Only the AGH runner has `oracle` and `frozen`.
 */
export type Arm = Setting | 'oracle' | 'frozen'

export type EvalPrompt = {
  text: string
  /** Run after all sessions end, inside the task workspace. */
  checks: { command: string; contains: string }[]
  /** Commands that complete this prompt's work; used only by the self-check. */
  solution: string[]
  /**
   * Makes this prompt a milestone: its checks run right after it, in the live workspace, and the run
   * stops at the first milestone whose checks fail. The name is what the report shows.
   */
  milestone?: string
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
  /** The most model requests a run of this task may make; the runner's default when absent. */
  maxRequests?: number
  /**
   * Where the oracle arm writes the lesson: after this prompt (zero-based) of the first session. Absent:
   * before the second session, for a task of two sessions.
   */
  oracle?: { afterPrompt: number }
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
  /** The context window the model is declared with; 200,000 when absent. */
  contextWindow?: number
  /** The most output tokens per request the model is declared with; 8,192 when absent. */
  maxOutputTokens?: number
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
  sessions: {
    exitCode: number | null
    timedOut: boolean
    stdoutFile: string
    sessionFiles: string[]
    /** The run reached its request cap during this session. */
    capped?: boolean
  }[]
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
  /** Set when the host's own verifier ended a turn `blocked`; see `Blocked`. */
  blocked?: Blocked
  /** Set when the run reached its request cap and was stopped there. */
  capped?: Capped
  /** Set when a milestone's checks failed and the run was stopped there. */
  stopped?: { reason: 'milestone-failed'; session: number; prompt: number }
  /** When each prompt's turn ended, by the runner's clock: what was spent by then is read from the ledger. */
  prompts?: { session: number; prompt: number; endedAt: string; reason: string }[]
  /** The throwaway workspace each fixture was copied to (its memory lives under a hash of that path). */
  workspaces?: Record<string, string>
  /** `on` runs: `triggers` when the runner sent no manual reviews and left refinement to its own triggers. */
  onProtocol?: OnProtocol
  /** Frozen runs: the `on` run whose saved lessons were seeded, and what was seeded. */
  frozenFrom?: FrozenSeed
}

/**
 * A run whose turn the host's own turn verifier ended `blocked` (for example `tool_call_as_text`: the model
 * wrote a tool call as text, it did not run, and the repair did not take). The harness stopped the turn,
 * not the task, so such a run is no task failure: it is left out of every metric and redone once.
 */
export type Blocked = {
  /** Which session and prompt (zero-based) the blocked turn belonged to. */
  session: number
  prompt: number
  /** The verifier's reasons, as its ledger row names them. */
  reasons: string[]
}

/** How the runner drives an `on` run: a manual review after every prompt (as Prime does), or only refinement's own triggers. */
export type OnProtocol = 'reviews' | 'triggers'

/** Where a capped run stopped: the request cap it reached, in which session, during or after which prompt. */
export type Capped = { maxRequests: number; session: number; prompt: number }

export type FrozenSeed = {
  /** The `on` run the lessons were taken from. */
  runId: string
  /** Saved memory paragraphs seeded, per fixture. */
  paragraphs: Record<string, number>
  /** Saved workspace skills copied, per fixture. */
  skills: Record<string, string[]>
  /** Saved user memory sections seeded. */
  userSections: number
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
  /** The host's verifier ended a turn blocked; such records are left out of every metric. */
  blocked?: Blocked
  /** The run reached its request cap; such records are listed apart, not in the means. */
  capped?: Capped
  /** AGH runs: what the run had spent at the end of each prompt, with the milestone results. */
  progress?: PromptProgress[]
  /** AGH runs: where the trap was hit and where the context was compacted, per session (ledger seqs). */
  trapEvents?: { session: number; hits: number[]; compactions: number[] }[]
  onProtocol?: OnProtocol
  frozenFrom?: FrozenSeed
}

/** What the run had spent when one of its prompts ended, and whether that prompt's milestone passed. */
export type PromptProgress = {
  session: number
  prompt: number
  /** Main-lane tool calls of the run so far (every session up to this prompt). */
  toolCalls: number
  /** All lanes, as `SessionCost`; `main*` leave the refinement lane out. */
  requests: number
  tokens: number
  cost: number
  mainRequests: number
  mainCost: number
  milestone?: string
  /** The milestone's checks, run right after the prompt; absent for a prompt that is no milestone. */
  passed?: boolean
}
