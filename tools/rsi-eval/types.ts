// Shared types for the offline RSI evaluation tools. Pure types: no runtime code.

export type Category = 'directory' | 'command-args' | 'convention' | 'cross-session'

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
  sessions: { prompts: EvalPrompt[] }[]
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
  sessions: { exitCode: number | null; timedOut: boolean; stdoutFile: string; sessionFiles: string[] }[]
  checks: { session: number; prompt: number; passed: boolean }[]
}

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
}
