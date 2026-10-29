export type LspConfig = {
  enabled: boolean
  /** Attach errors to write/edit results. */
  autoAttach: boolean
  /** Subagent sessions (generationDepth > 0) attach only when this is set; they can always call the tool. */
  autoAttachInChildren: boolean
  /** Language servers alive at once in this worker, across all sessions. */
  maxServers: number
  maxPerSession: number
  idleMs: number
  failMs: number
  initMs: number
  stableMs: number
  autoWaitMs: number
  toolWaitMs: number
  toolStartMs: number
  /** PATH searched for the TypeScript server's own tsserver (never a workspace copy). */
  searchPath: string
  /** The workspace is trusted. No Host signal reaches a tool yet, so this stays false; trusted-only servers need it. */
  trusted: boolean
}
export const DEFAULTS: LspConfig = {
  enabled: true,
  autoAttach: true,
  autoAttachInChildren: false,
  maxServers: 4,
  maxPerSession: 3,
  idleMs: 10 * 60_000,
  failMs: 3 * 60_000,
  initMs: 30_000,
  stableMs: 200,
  autoWaitMs: 2000,
  toolWaitMs: 10_000,
  toolStartMs: 30_000,
  searchPath: process.env.PATH ?? '',
  trusted: false,
}
