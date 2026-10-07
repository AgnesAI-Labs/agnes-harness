/** What a child-agent provider can honestly honor. A false flag is refused at start. */
export type ChildAgentCapabilities = Readonly<{
  /** Accepts a later message and keeps the child after a turn. */
  continuable: boolean
  /** Stops the current turn without disposing the child. */
  interrupt: boolean
  /** Honors `options.model`. */
  modelSelection: boolean
  /** Can seed the child from the parent conversation (`options.fork`). */
  inheritsParentContext: boolean
  /** Can place the child in its own git worktree. */
  worktree: boolean
}>

export type ChildAgentStatus =
  | 'starting'
  | 'running'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type ChildAgentEvent =
  | { type: 'status'; status: ChildAgentStatus }
  | { type: 'text'; text: string }
  | { type: 'error'; message: string }

export type ChildAgentResult = Readonly<{
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  text: string
}>

export type ChildAgentStartOptions = Readonly<{
  signal: AbortSignal
  /** Parent session that owns the child. */
  sessionKey: string
  cwd?: string
  model?: string
  isolation?: 'worktree' | 'shared'
  budget?: number
  /** Run one inherited turn. Requires `inheritsParentContext`. */
  fork?: boolean
}>

/** One running child. `result` settles when the child reaches a terminal state. */
export interface ChildAgentHandle {
  readonly id: string
  readonly providerId: string
  readonly capabilities: ChildAgentCapabilities
  events(): AsyncIterable<ChildAgentEvent>
  /** Deliver a follow-up. Resolves when the message is accepted, not when the child answers. */
  sendMessage(text: string, signal: AbortSignal): Promise<{ messageId: string }>
  interrupt(): Promise<{ accepted: boolean }>
  result(): Promise<ChildAgentResult>
  dispose(): Promise<void>
}

/** Register through an ordinary Cordis plugin that injects `childAgents`. */
export interface ChildAgentProvider {
  readonly id: string
  readonly version: string
  readonly capabilities: ChildAgentCapabilities
  start(task: string, options: ChildAgentStartOptions): Promise<ChildAgentHandle>
  /** Direct children this provider still tracks for one parent session. */
  list?(sessionKey: string): Promise<readonly ChildAgentListing[]>
}

export type ChildAgentCatalogEntry = Readonly<{
  id: string
  version: string
  sourcePackage: string
  capabilities: ChildAgentCapabilities
}>

export type ChildAgentListing = Readonly<{
  id: string
  providerId: string
  status: ChildAgentStatus
  continuable: boolean
  text?: string
}>

/**
 * Models and providers a session may start. An omitted list is unrestricted.
 * An empty list refuses every request of that kind.
 */
export type ChildAgentAllowlist = Readonly<{
  models?: readonly string[]
  providers?: readonly string[]
}>

/** Plugin or extension config. `sessions` replaces `allow` for those session keys. */
export type ChildAgentAllowlistConfig = Readonly<{
  allow?: ChildAgentAllowlist
  sessions?: Readonly<Record<string, ChildAgentAllowlist>>
}>

export interface ChildAgentRegistration {
  /** Duplicate ids are refused. The disposer belongs to the calling plugin fiber. */
  register(provider: ChildAgentProvider): () => void | Promise<void>
  catalog(): readonly ChildAgentCatalogEntry[]
}

export interface ChildAgentService extends ChildAgentRegistration {
  setSessionAllowlist(sessionKey: string, allowlist: ChildAgentAllowlist | undefined): void
  allowlist(sessionKey: string): ChildAgentAllowlist | undefined
  start(providerId: string, task: string, options: ChildAgentStartOptions): Promise<ChildAgentHandle>
  list(sessionKey: string): Promise<readonly ChildAgentListing[]>
}

export type ChildAgentPluginContext = {
  childAgents: ChildAgentService
}
