// Shared types for the offline RSI evaluation tools. Pure types: no runtime code.

export type Category = 'directory' | 'command-args' | 'convention' | 'cross-session' | 'cross-workspace'

export type Setting = 'on' | 'off'

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
  proxyPort: number
  sessionTimeoutMs: number
}

export type RunOutcome = {
  runId: string
  /** Which runner wrote it, so its session files are read the right way; absent means Prime. */
  system?: RunRecord['system']
  sessions: { exitCode: number | null; timedOut: boolean; stdoutFile: string; sessionFiles: string[] }[]
  checks: { session: number; prompt: number; passed: boolean }[]
  /** Set by a runner that could not send the save its counterpart sends at the end of session 1. */
  alignment?: Alignment
}

/**
 * `auto-only`: the run had no user-initiated user-level save at the end of the first session of a
 * cross-workspace task (Prime sends `/refine --global` there), so anything carried to the second
 * workspace came from automatic promotion alone.
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

export type RunRecord = {
  system: 'prime' | 'agh'
  taskId: string
  category: Category
  setting: Setting
  rep: number
  exit: 'ok' | 'error' | 'timeout'
  windows: PromptWindow[]
  refine: { auto: number; user: number; self: number; appliedEdits: number }
  harnessLookups: number
  compactions: number
  usage: { requests: number; unknown: number; tokens: number; costUsd: number }
  alignment?: Alignment
}
